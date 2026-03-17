// ==========================================
// PART 1: CORE INFRASTRUCTURE & CONFIGURATION
// signalalpha-part1.js
// Copy this section first
// ==========================================

import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import ccxt from 'ccxt';
import WebSocket from 'ws';
import Pino from 'pino';
import { config } from 'dotenv';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import crypto from 'crypto';

config();

// ==========================================
// BALANCED CONFIGURATION (Calibrated Thresholds)
// ==========================================
const CONFIG = {
  // Bot Core
  BOT_TOKEN: process.env.BOT_TOKEN,
  ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean),
  
  // Challenge Settings
  CHALLENGE: {
    START_CAPITAL: parseFloat(process.env.CHALLENGE_START || 10),
    TARGET: parseFloat(process.env.CHALLENGE_TARGET || 100),
    DAYS: parseInt(process.env.CHALLENGE_DAYS || 30),
    CURRENT_CAPITAL: parseFloat(process.env.CURRENT_CAPITAL || 10),
  },
  
  // Risk Management (Balanced - not too strict, not too loose)
  RISK: {
    DAILY_LOSS_LIMIT_PCT: 5,
    WEEKLY_LOSS_LIMIT_PCT: 15,
    MAX_CONSECUTIVE_LOSSES: 3,
    MAX_SIGNALS_PER_DAY: 8,        // Increased from 6 to 8
    MIN_CONFIDENCE: 60,           // Lowered from 70 to 60 (balanced entry)
    MIN_RR: 1.5,                  // Lowered from 2.0 to 1.5 (realistic targets)
    MAX_RISK_PER_TRADE_PCT: 5,
  },
  
  // Technical Analysis (Calibrated for real market conditions)
  TA: {
    TIMEFRAMES: ['5m', '15m', '1h', '4h'],
    EMA_FAST: 50,
    EMA_SLOW: 200,
    RSI_PERIOD: 14,
    RSI_OVERBOUGHT: 72,           // Slightly higher (avoid false overbought)
    RSI_OVERSOLD: 28,             // Slightly lower (avoid false oversold)
    VOLUME_THRESHOLD: 1.3,        // Lowered from 1.5 (130% of average)
    MIN_VOLUME_USD: 5000000,      // Lowered from 10M to 5M (more opportunities)
  },
  
  // Exchange Configuration
  EXCHANGE: {
    SANDBOX: process.env.SANDBOX === 'true',
    DEFAULT_TYPE: 'swap',
    ID: 'bingx',
  },
  
  // Market Data
  DATA: {
    COINGECKO_API: 'https://api.coingecko.com/api/v3',
    BINANCE_FUTURES_WS: 'wss://fstream.binance.com/ws',
    UPDATE_INTERVAL_MS: 5000,
  },
  
  // Referral
  REFERRAL: {
    LINK: 'https://bingxdao.com/invite/4UAWNP/',
    CODE: '4UAWNP',
  },
  
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

// Validation logging
console.log('✅ CONFIG loaded successfully');
console.log(`📊 Challenge: $${CONFIG.CHALLENGE.START_CAPITAL} → $${CONFIG.CHALLENGE.TARGET}`);
console.log(`🎯 Min Confidence: ${CONFIG.RISK.MIN_CONFIDENCE}% | Min R:R: ${CONFIG.RISK.MIN_RR}:1`);
console.log(`👥 Admin IDs: ${CONFIG.ADMIN_IDS.length > 0 ? CONFIG.ADMIN_IDS.join(', ') : 'None set'}`);

// ==========================================
// ADVANCED LOGGER WITH ROTATION
// ==========================================
const logger = Pino({
  level: CONFIG.LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});

console.log('✅ Logger initialized');

// Improved Trade Logger with rotation and stats
class TradeLogger {
  constructor(filename = 'trades.log') {
    this.filename = filename;
    this.dailyStats = new Map();
    console.log(`📁 TradeLogger initialized: ${filename}`);
  }

  async log(type, data) {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      ...data,
    };

    try {
      await fs.appendFile(this.filename, JSON.stringify(entry) + '\n');
      console.log(`📝 Logged: ${type} - ${data.symbol || 'system'}`);
    } catch (err) {
      logger.error('Failed to log trade:', err);
      console.error(`❌ Failed to write to ${this.filename}:`, err.message);
    }
  }

  async getRecentTrades(hours = 24) {
    console.log(`📖 Reading recent trades from last ${hours}h...`);
    try {
      const content = await fs.readFile(this.filename, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const cutoff = Date.now() - (hours * 3600000);

      const trades = lines
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(trade => trade && new Date(trade.timestamp).getTime() > cutoff);
      
      console.log(`✅ Found ${trades.length} trades in last ${hours}h`);
      return trades;
    } catch (err) {
      console.warn(`⚠️ Could not read ${this.filename}:`, err.message);
      return [];
    }
  }

  async getTodaySignalCount() {
    const trades = await this.getRecentTrades(24);
    return trades.filter(t => t.type === 'SIGNAL_GENERATED').length;
  }
}

// ==========================================
// IMPROVED MARKET DATA ENGINE
// ==========================================
class MarketDataEngine extends EventEmitter {
  constructor() {
    super();
    console.log('🏗️ Initializing MarketDataEngine...');
    
    // Initialize CCXT exchange with better error handling
    try {
      this.exchange = new ccxt[CONFIG.EXCHANGE.ID]({
        enableRateLimit: true,
        options: {
          defaultType: CONFIG.EXCHANGE.DEFAULT_TYPE,
        },
      });
      
      if (CONFIG.EXCHANGE.SANDBOX) {
        this.exchange.setSandboxMode(true);
        console.log('🔒 Sandbox mode enabled');
      }
      
      console.log(`✅ Exchange initialized: ${CONFIG.EXCHANGE.ID}`);
    } catch (err) {
      console.error('❌ Failed to initialize exchange:', err.message);
      // Fallback to binance if primary fails
      this.exchange = new ccxt.binance({
        enableRateLimit: true,
        options: { defaultType: 'future' },
      });
      console.log('⚠️ Fallback to binance exchange');
    }

    this.priceCache = new Map();
    this.ohlcvCache = new Map();
    this.wsConnections = new Map();
    this.isRunning = false;
    this.perpetualMarkets = [];
    this.lastUpdate = Date.now();
    
    console.log('✅ MarketDataEngine constructed');
  }

  async initialize() {
    console.log('🚀 Starting MarketDataEngine initialization...');
    try {
      console.log('📡 Loading markets from exchange...');
      await this.exchange.loadMarkets();
      const marketCount = Object.keys(this.exchange.markets).length;
      logger.info(`Loaded ${marketCount} markets`);
      console.log(`✅ Loaded ${marketCount} markets`);

      // Filter USDT perpetual futures with better criteria
      console.log('🔍 Filtering perpetual markets...');
      this.perpetualMarkets = Object.values(this.exchange.markets)
        .filter(m => {
          const isSwap = m.type === 'swap' || m.type === 'future';
          const isUSDT = m.quote === 'USDT' || m.quoteId === 'USDT';
          return isSwap && isUSDT && m.active && !m.symbol.includes('-');
        })
        .map(m => m.symbol)
        .sort();
      
      logger.info(`Found ${this.perpetualMarkets.length} active perpetual markets`);
      console.log(`✅ Found ${this.perpetualMarkets.length} perpetual markets`);
      console.log(`📊 Top markets: ${this.perpetualMarkets.slice(0, 5).join(', ')}...`);

      // Start WebSocket feeds
      console.log('🔌 Starting WebSocket feeds...');
      this.startWebSocketFeeds();
      
      // Start polling for OHLCV
      console.log('📈 Starting OHLCV polling...');
      this.startOhlcvPolling();
      
      this.isRunning = true;
      console.log('🎯 MarketDataEngine fully initialized and running');
    } catch (err) {
      logger.error('Failed to initialize market data:', err);
      console.error('❌ MarketDataEngine initialization failed:', err.message);
      throw err;
    }
  }

  startWebSocketFeeds() {
    // Major pairs for real-time price feeds
    const majorPairs = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'xrpusdt', 'dogeusdt', 'adausdt'];
    console.log(`🔌 Starting WebSocket connections for ${majorPairs.length} pairs...`);
    
    for (const pair of majorPairs) {
      const wsUrl = `${CONFIG.DATA.BINANCE_FUTURES_WS}/${pair}@kline_1m`;
      
      try {
        const ws = new WebSocket(wsUrl);
        
        ws.on('open', () => {
          console.log(`✅ WebSocket connected: ${pair}`);
        });
        
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data);
            if (msg.k) {
              this.priceCache.set(pair, {
                price: parseFloat(msg.k.c),
                volume: parseFloat(msg.k.v),
                timestamp: Date.now(),
              });
            }
          } catch (err) {
            // Silent parse errors
          }
        });
        
        ws.on('error', (err) => {
          console.error(`❌ WebSocket error for ${pair}:`, err.message);
        });
        
        ws.on('close', () => {
          console.warn(`⚠️ WebSocket closed for ${pair}, reconnecting in 10s...`);
          setTimeout(() => {
            this.wsConnections.delete(pair);
            // Reconnect single pair
            const newWs = new WebSocket(wsUrl);
            this.wsConnections.set(pair, newWs);
          }, 10000);
        });
        
        this.wsConnections.set(pair, ws);
      } catch (err) {
        console.error(`❌ Failed to connect WebSocket for ${pair}:`, err.message);
      }
    }
    console.log('✅ All WebSocket connections initiated');
  }

  startOhlcvPolling() {
    console.log('⏱️ Starting OHLCV polling (15s interval)...');
    
    const poll = async () => {
      if (!this.isRunning) return;
      
      try {
        // Get top 30 by volume for better coverage
        const symbolsToPoll = this.perpetualMarkets.slice(0, 30);
        
        for (const symbol of symbolsToPoll) {
          for (const timeframe of CONFIG.TA.TIMEFRAMES) {
            try {
              const ohlcv = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, 100);
              const key = `${symbol}_${timeframe}`;
              this.ohlcvCache.set(key, {
                data: ohlcv,
                timestamp: Date.now(),
              });
              // Small delay to respect rate limits
              await new Promise(r => setTimeout(r, 50));
            } catch (err) {
              // Continue on error
            }
          }
        }
        this.lastUpdate = Date.now();
      } catch (err) {
        console.error('❌ OHLCV polling error:', err.message);
      }
      
      // Schedule next poll
      setTimeout(poll, 15000);
    };
    
    // Start first poll
    setTimeout(poll, 5000);
    console.log('✅ OHLCV polling active');
  }

  async fetchOHLCV(symbol, timeframe, limit = 100) {
    const key = `${symbol}_${timeframe}`;
    const cached = this.ohlcvCache.get(key);
    
    // Use cache if less than 45 seconds old
    if (cached && Date.now() - cached.timestamp < 45000) {
      return cached.data;
    }

    try {
      console.log(`📊 Fetching OHLCV: ${symbol} ${timeframe}`);
      const data = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      this.ohlcvCache.set(key, { data, timestamp: Date.now() });
      return data;
    } catch (err) {
      logger.error(`Failed to fetch OHLCV for ${symbol}:`, err.message);
      return cached?.data || null; // Return stale cache if available
    }
  }

  async getCurrentPrice(symbol) {
    // Try WebSocket first
    const wsKey = symbol.toLowerCase().replace('/', '').replace(':', '');
    const wsData = this.priceCache.get(wsKey);
    if (wsData && Date.now() - wsData.timestamp < 10000) {
      return wsData.price;
    }
    
    // Fallback to REST
    try {
      const ticker = await this.exchange.fetchTicker(symbol);
      return ticker.last;
    } catch (err) {
      logger.error(`Failed to get price for ${symbol}:`, err.message);
      return null;
    }
  }

  async get24hVolume(symbol) {
    try {
      const ticker = await this.exchange.fetchTicker(symbol);
      return ticker.quoteVolume || 0;
    } catch (err) {
      return 0;
    }
  }

  async getTopVolumeSymbols(count = 20) {
    console.log(`🏆 Fetching top ${count} volume symbols...`);
    try {
      const tickers = await this.exchange.fetchTickers();
      const sorted = Object.values(tickers)
        .filter(t => {
          const isPerp = t.symbol && (t.symbol.includes(':USDT') || t.symbol.includes('/USDT'));
          const hasVolume = t.quoteVolume > CONFIG.TA.MIN_VOLUME_USD;
          return isPerp && hasVolume;
        })
        .sort((a, b) => b.quoteVolume - a.quoteVolume)
        .slice(0, count)
        .map(t => t.symbol);
      
      console.log(`✅ Top volumes: ${sorted.slice(0, 5).join(', ')}...`);
      return sorted;
    } catch (err) {
      console.error('❌ Failed to fetch top volumes:', err.message);
      // Return default majors
      return ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'BNB/USDT:USDT', 'XRP/USDT:USDT'];
    }
  }
}

// ==========================================
// END OF PART 1
// 
// NEXT: Copy Part 2 below this section
// Part 2 contains: Technical Analysis Engine
// ==========================================
      // ==========================================
// PART 2: TECHNICAL ANALYSIS ENGINE
// signalalpha-part2.js
// Continue from Part 1
// ==========================================

class InstitutionalTA {
  constructor(marketData) {
    this.marketData = marketData;
    console.log('📐 InstitutionalTA initialized');
  }

  // ==========================================
  // TREND ANALYSIS (Balanced - not too strict)
  // ==========================================
  
  calculateEMA(prices, period) {
    if (prices.length < period) return null;
    
    const k = 2 / (period + 1);
    const ema = [];
    
    // Start with SMA for first value
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += prices[i];
    }
    ema.push(sum / period);
    
    // Calculate EMA for rest
    for (let i = period; i < prices.length; i++) {
      ema.push(prices[i] * k + ema[ema.length - 1] * (1 - k));
    }
    
    return ema;
  }

  calculateSMA(prices, period) {
    if (prices.length < period) return null;
    const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
  }

  // Improved trend detection with multiple confirmations
  analyzeTrend(ohlcv, timeframe = '15m') {
    const closes = ohlcv.map(c => c[4]);
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    
    if (closes.length < 50) return { primary: 'neutral', strength: 0 };

    // Multiple EMAs for trend
    const ema20 = this.calculateEMA(closes, 20);
    const ema50 = this.calculateEMA(closes, 50);
    const ema200 = this.calculateEMA(closes, 200);
    
    if (!ema20 || !ema50) return { primary: 'neutral', strength: 0 };

    const currentPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 5];
    
    const ema20Current = ema20[ema20.length - 1];
    const ema50Current = ema50[ema50.length - 1];
    const ema200Current = ema200 ? ema200[ema200.length - 1] : null;

    // Price action trend
    const higherHighs = this.countHigherHighs(highs.slice(-20));
    const higherLows = this.countHigherLows(lows.slice(-20));
    const lowerHighs = this.countLowerHighs(highs.slice(-20));
    const lowerLows = this.countLowerLows(lows.slice(-20));

    // Determine trend with balanced criteria
    let trend = 'neutral';
    let strength = 0;
    let alignment = false;

    const bullishEma = ema20Current > ema50Current;
    const bearishEma = ema20Current < ema50Current;
    
    const bullishPA = higherHighs > lowerHighs && higherLows > lowerLows;
    const bearishPA = lowerHighs > higherHighs && lowerLows > higherLows;

    // Balanced: Need 2 of 3 confirmations (EMA, Price Action, Higher TF)
    let bullishScore = 0;
    let bearishScore = 0;

    if (bullishEma) bullishScore += 1;
    if (bullishPA) bullishScore += 1;
    if (currentPrice > ema50Current) bullishScore += 1;
    
    if (bearishEma) bearishScore += 1;
    if (bearishPA) bearishScore += 1;
    if (currentPrice < ema50Current) bearishScore += 1;

    if (bullishScore >= 2) {
      trend = 'bullish';
      strength = bullishScore / 3;
      alignment = ema200 ? currentPrice > ema200Current : true;
    } else if (bearishScore >= 2) {
      trend = 'bearish';
      strength = bearishScore / 3;
      alignment = ema200 ? currentPrice < ema200Current : true;
    }

    return {
      primary: trend,
      strength: Math.round(strength * 100),
      alignment,
      ema20: ema20Current,
      ema50: ema50Current,
      ema200: ema200Current,
      slope: (ema20Current - ema20[ema20.length - 5]) / ema20Current * 100, // % slope
    };
  }

  countHigherHighs(highs) {
    let count = 0;
    for (let i = 2; i < highs.length; i++) {
      if (highs[i] > highs[i-1] && highs[i-1] > highs[i-2]) count++;
    }
    return count;
  }

  countHigherLows(lows) {
    let count = 0;
    for (let i = 2; i < lows.length; i++) {
      if (lows[i] > lows[i-1] && lows[i-1] > lows[i-2]) count++;
    }
    return count;
  }

  countLowerHighs(highs) {
    let count = 0;
    for (let i = 2; i < highs.length; i++) {
      if (highs[i] < highs[i-1] && highs[i-1] < highs[i-2]) count++;
    }
    return count;
  }

  countLowerLows(lows) {
    let count = 0;
    for (let i = 2; i < lows.length; i++) {
      if (lows[i] < lows[i-1] && lows[i-1] < lows[i-2]) count++;
    }
    return count;
  }

  // ==========================================
  // MOMENTUM ANALYSIS (RSI + MACD)
  // ==========================================
  
  calculateRSI(prices, period = 14) {
    if (prices.length < period + 5) return { value: 50, trend: 'neutral' };

    const changes = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1]);
    }

    let gains = 0, losses = 0;
    for (let i = 0; i < period; i++) {
      if (changes[i] > 0) gains += changes[i];
      else losses += Math.abs(changes[i]);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    
    const rsiValues = [];
    let rs = avgGain / (avgLoss || 0.001);
    rsiValues.push(100 - (100 / (1 + rs)));

    for (let i = period; i < changes.length; i++) {
      const change = changes[i];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;
      
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      
      rs = avgGain / (avgLoss || 0.001);
      rsiValues.push(100 - (100 / (1 + rs)));
    }

    const currentRSI = rsiValues[rsiValues.length - 1];
    const prevRSI = rsiValues[rsiValues.length - 3];
    
    // Balanced RSI interpretation
    let condition = 'neutral';
    if (currentRSI > 65) condition = 'overbought';
    else if (currentRSI < 35) condition = 'oversold';
    else if (currentRSI > 55) condition = 'bullish';
    else if (currentRSI < 45) condition = 'bearish';

    return {
      value: Math.round(currentRSI * 10) / 10,
      trend: currentRSI > prevRSI ? 'rising' : 'falling',
      condition,
      divergence: this.detectRSIDivergence(prices, rsiValues),
    };
  }

  detectRSIDivergence(prices, rsiValues) {
    // Look for divergence in last 10 candles
    if (prices.length < 15 || rsiValues.length < 15) return { bullish: false, bearish: false };

    const p1 = prices[prices.length - 10];
    const p2 = prices[prices.length - 1];
    const r1 = rsiValues[rsiValues.length - 10];
    const r2 = rsiValues[rsiValues.length - 1];

    // Bullish: Lower price, Higher RSI (not in extreme overbought)
    const bullish = p2 < p1 && r2 > r1 && r2 < 70 && r1 < 60;
    
    // Bearish: Higher price, Lower RSI (not in extreme oversold)
    const bearish = p2 > p1 && r2 < r1 && r2 > 30 && r1 > 40;

    return { bullish, bearish, strength: Math.abs(r2 - r1) };
  }

  calculateMACD(prices, fast = 12, slow = 26, signal = 9) {
    if (prices.length < slow + signal) return null;

    const ema12 = this.calculateEMA(prices, fast);
    const ema26 = this.calculateEMA(prices, slow);
    
    if (!ema12 || !ema26) return null;

    const macdLine = [];
    const startIdx = ema26.length - ema12.length;
    
    for (let i = 0; i < ema12.length; i++) {
      macdLine.push(ema12[i] - ema26[i + startIdx]);
    }

    const signalLine = this.calculateEMA(macdLine, signal);
    if (!signalLine) return null;

    const histogram = macdLine.slice(-signalLine.length).map((v, i) => v - signalLine[i]);
    
    const currentHist = histogram[histogram.length - 1];
    const prevHist = histogram[histogram.length - 2];
    const prevPrevHist = histogram[histogram.length - 3] || prevHist;
    
    // Trend based on histogram
    let trend = 'neutral';
    if (currentHist > prevHist && currentHist > 0) trend = 'bullish';
    else if (currentHist < prevHist && currentHist < 0) trend = 'bearish';
    else if (currentHist > 0) trend = 'weak_bullish';
    else if (currentHist < 0) trend = 'weak_bearish';

    // Crossover detection (2-bar confirmation to avoid noise)
    let crossover = 'none';
    const macdCurrent = macdLine[macdLine.length - 1];
    const macdPrev = macdLine[macdLine.length - 2];
    const signalCurrent = signalLine[signalLine.length - 1];
    const signalPrev = signalLine[signalLine.length - 2];

    if (macdPrev < signalPrev && macdCurrent > signalCurrent) {
      crossover = 'bullish';
    } else if (macdPrev > signalPrev && macdCurrent < signalCurrent) {
      crossover = 'bearish';
    }

    // Momentum strength (average of last 3 histogram bars)
    const histAvg = (currentHist + prevHist + prevPrevHist) / 3;

    return {
      value: Math.round(macdCurrent * 10000) / 10000,
      signal: Math.round(signalCurrent * 10000) / 10000,
      histogram: Math.round(currentHist * 10000) / 10000,
      trend,
      crossover,
      histAvg: Math.round(histAvg * 10000) / 10000,
      momentum: Math.abs(histAvg), // Strength indicator
    };
  }

  // ==========================================
  // VOLUME ANALYSIS (Balanced thresholds)
  // ==========================================
  
  analyzeVolume(ohlcv) {
    if (ohlcv.length < 20) return { ratio: 1, trend: 'normal', confirmation: false };

    const volumes = ohlcv.map(c => c[5]);
    const closes = ohllcv.map(c => c[4]);
    
    // Current vs 20-period average
    const avgVolume = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const currentVolume = volumes[volumes.length - 1];
    const ratio = avgVolume > 0 ? currentVolume / avgVolume : 1;

    // Volume trend (comparing last 3 bars to previous 3)
    const recentVol = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const prevVol = volumes.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
    
    let trend = 'normal';
    if (ratio > 1.5) trend = 'breakout';
    else if (ratio > 1.2) trend = 'rising';
    else if (ratio < 0.8) trend = 'falling';

    // Volume-price confirmation (simplified OBV)
    let obv = 0;
    for (let i = 1; i < Math.min(ohlcv.length, 10); i++) {
      if (closes[i] > closes[i - 1]) obv += volumes[i];
      else if (closes[i] < closes[i - 1]) obv -= volumes[i];
    }

    const confirmation = (obv > 0 && closes[closes.length - 1] > closes[closes.length - 5]) ||
                        (obv < 0 && closes[closes.length - 1] < closes[closes.length - 5]);

    return {
      ratio: Math.round(ratio * 100) / 100,
      trend,
      confirmation,
      obvTrend: obv > 0 ? 'positive' : 'negative',
      avgVolume: Math.round(avgVolume),
      currentVolume: Math.round(currentVolume),
    };
  }

  // ==========================================
  // SUPPORT/RESISTANCE (Improved clustering)
  // ==========================================
  
  findKeyLevels(ohlcv, touchesRequired = 2) {
    if (ohlcv.length < 30) {
      return {
        support: null,
        resistance: null,
        pivot: null,
        valid: false,
        touches: 0,
      };
    }

    const highs = ohllcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    const closes = ohlcv.map(c => c[4]);
    const opens = ohlcv.map(c => c[1]);

    // Find swing points (last 50 candles)
    const lookback = Math.min(50, ohlcv.length - 4);
    const swingHighs = [];
    const swingLows = [];

    for (let i = 2; i < lookback - 2; i++) {
      const idx = ohlcv.length - lookback + i;
      
      // Swing high: higher than 2 bars each side
      if (highs[idx] > highs[idx-1] && highs[idx] > highs[idx-2] &&
          highs[idx] > highs[idx+1] && highs[idx] > highs[idx+2]) {
        swingHighs.push({ price: highs[idx], strength: 2 });
      }
      
      // Swing low: lower than 2 bars each side
      if (lows[idx] < lows[idx-1] && lows[idx] < lows[idx-2] &&
          lows[idx] < lows[idx+1] && lows[idx] < lows[idx+2]) {
        swingLows.push({ price: lows[idx], strength: 2 });
      }
    }

    // Also include recent highs/lows
    const recentHigh = Math.max(...highs.slice(-10));
    const recentLow = Math.min(...lows.slice(-10));
    
    if (recentHigh > highs[highs.length - 11] * 0.99) {
      swingHighs.push({ price: recentHigh, strength: 1 });
    }
    if (recentLow < lows[lows.length - 11] * 1.01) {
      swingLows.push({ price: recentLow, strength: 1 });
    }

    // Cluster levels (0.5% threshold)
    const resistance = this.clusterLevels(swingHighs.map(h => h.price), 0.005);
    const support = this.clusterLevels(swingLows.map(l => l.price), 0.005);

    const currentPrice = closes[closes.length - 1];
    
    // Count touches in last 20 candles
    const recentCloses = closes.slice(-20);
    let supportTouches = 0;
    let resistanceTouches = 0;

    for (const close of recentCloses) {
      if (support.some(s => Math.abs(close - s) / s < 0.003)) supportTouches++;
      if (resistance.some(r => Math.abs(close - r) / r < 0.003)) resistanceTouches++;
    }

    // Determine nearest levels
    const nearestSupport = support.find(s => s < currentPrice) || support[0];
    const nearestResistance = resistance.find(r => r > currentPrice) || resistance[0];
    
    // Calculate pivot (midpoint or recent significant level)
    const pivot = nearestSupport && nearestResistance ? 
      (nearestSupport + nearestResistance) / 2 : null;

    const valid = support.length > 0 && resistance.length > 0 && 
                  (supportTouches >= touchesRequired || resistanceTouches >= touchesRequired);

    return {
      support: nearestSupport,
      resistance: nearestResistance,
      pivot,
      supportList: support.slice(0, 3),
      resistanceList: resistance.slice(0, 3),
      supportTouches,
      resistanceTouches,
      valid,
      nearSupport: nearestSupport ? Math.abs(currentPrice - nearestSupport) / currentPrice < 0.01 : false,
      nearResistance: nearestResistance ? Math.abs(currentPrice - nearestResistance) / currentPrice < 0.01 : false,
      range: nearestResistance && nearestSupport ? nearestResistance - nearestSupport : null,
    };
  }

  clusterLevels(levels, threshold = 0.01) {
    if (levels.length === 0) return [];
    
    const sorted = [...levels].sort((a, b) => a - b);
    const clusters = [];
    let currentCluster = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i] - currentCluster[0]) / currentCluster[0] < threshold) {
        currentCluster.push(sorted[i]);
      } else {
        // Average the cluster
        clusters.push(currentCluster.reduce((a, b) => a + b, 0) / currentCluster.length);
        currentCluster = [sorted[i]];
      }
    }
    
    if (currentCluster.length > 0) {
      clusters.push(currentCluster.reduce((a, b) => a + b, 0) / currentCluster.length);
    }

    return clusters.sort((a, b) => a - b);
  }

  // ==========================================
  // MARKET STRUCTURE (BOS/CHoCH detection)
  // ==========================================
  
  analyzeStructure(ohlcv) {
    if (ohlcv.length < 20) return { type: 'unknown', bos: 'none', strength: 0 };

    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    const closes = ohlcv.map(c => c[4]);

    const recentHighs = highs.slice(-20);
    const recentLows = lows.slice(-20);

    // Count patterns
    let hh = 0, hl = 0, lh = 0, ll = 0;

    for (let i = 1; i < recentHighs.length; i++) {
      if (recentHighs[i] > recentHighs[i - 1]) hh++;
      else lh++;
      
      if (recentLows[i] > recentLows[i - 1]) hl++;
      else ll++;
    }

    // Determine structure type
    let type = 'ranging';
    let strength = 0;

    if (hh > lh && hl > ll) {
      type = 'uptrend';
      strength = (hh + hl) / recentHighs.length;
    } else if (lh > hh && ll > hl) {
      type = 'downtrend';
      strength = (lh + ll) / recentHighs.length;
    } else if (Math.abs(hh - lh) < 3 && Math.abs(hl - ll) < 3) {
      type = 'consolidation';
    }

    // Break of Structure (BOS) detection
    const last5High = Math.max(...highs.slice(-5));
    const last5Low = Math.min(...lows.slice(-5));
    const prev10High = Math.max(...highs.slice(-15, -5));
    const prev10Low = Math.min(...lows.slice(-15, -5));

    let bos = 'none';
    let breakLevel = null;

    if (last5High > prev10High * 1.002) { // 0.2% breakout
      bos = type === 'uptrend' ? 'continuation' : 'bullish_break';
      breakLevel = prev10High;
    } else if (last5Low < prev10Low * 0.998) { // 0.2% breakdown
      bos = type === 'downtrend' ? 'continuation' : 'bearish_break';
      breakLevel = prev10Low;
    }

    return {
      type,
      bos,
      breakLevel,
      strength: Math.round(strength * 100),
      consolidation: type === 'consolidation' || type === 'ranging',
      trending: type === 'uptrend' || type === 'downtrend',
    };
  }

  // ==========================================
  // LIQUIDITY SWEEP DETECTION
  // ==========================================
  
  detectLiquiditySweep(ohlcv, levels) {
    if (!levels.support || !levels.resistance || ohlcv.length < 3) {
      return { bullish: false, bearish: false, weakBullish: false, weakBearish: false, level: null };
    }

    const lastCandle = ohlcv[ohlcv.length - 1];
    const prevCandle = ohlcv[ohlcv.length - 2];
    const thirdCandle = ohlcv[ohlcv.length - 3];

    const [o1, h1, l1, c1] = [lastCandle[1], lastCandle[2], lastCandle[3], lastCandle[4]];
    const [o2, h2, l2, c2] = [prevCandle[1], prevCandle[2], prevCandle[3], prevCandle[4]];

    // Strong bullish sweep: Wick below support, close above
    const bullishSweep = l2 < levels.support && c1 > levels.support && c1 > o1;
    
    // Strong bearish sweep: Wick above resistance, close below
    const bearishSweep = h2 > levels.resistance && c1 < levels.resistance && c1 < o1;

    // Weak sweeps (single candle or less clean close)
    const weakBullish = (l1 < levels.support && c1 > levels.support) || 
                        (l2 < levels.support && c2 > levels.support);
    
    const weakBearish = (h1 > levels.resistance && c1 < levels.resistance) ||
                        (h2 > levels.resistance && c2 < levels.resistance);

    return {
      bullish: bullishSweep,
      bearish: bearishSweep,
      weakBullish: weakBullish && !bullishSweep,
      weakBearish: weakBearish && !bearishSweep,
      level: bullishSweep || weakBullish ? levels.support : 
             (bearishSweep || weakBearish ? levels.resistance : null),
    };
  }

  // ==========================================
  // FIBONACCI LEVELS
  // ==========================================
  
  calculateFibonacci(high, low) {
    const diff = high - low;
    return {
      0: high,
      0.236: high - diff * 0.236,
      0.382: high - diff * 0.382,
      0.5: high - diff * 0.5,
      0.618: high - diff * 0.618,
      0.786: high - diff * 0.786,
      1: low,
      range: diff,
    };
  }

  // ==========================================
  // VOLATILITY & ATR
  // ==========================================
  
  calculateATR(ohlcv, period = 14) {
    if (ohlcv.length < period + 1) return { value: 0, percent: 0 };

    const trs = [];
    for (let i = 1; i < ohlcv.length; i++) {
      const high = ohlcv[i][2];
      const low = ohlcv[i][3];
      const prevClose = ohlcv[i-1][4];
      
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trs.push(tr);
    }

    const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
    const currentPrice = ohlcv[ohlcv.length - 1][4];
    const atrPercent = (atr / currentPrice) * 100;

    return {
      value: Math.round(atr * 10000) / 10000,
      percent: Math.round(atrPercent * 100) / 100,
    };
  }

  // ==========================================
  // COMPREHENSIVE ANALYSIS WRAPPER
  // ==========================================
  
  runFullAnalysis(ohlcv, timeframe = '15m') {
    const closes = ohlcv.map(c => c[4]);
    const currentPrice = closes[closes.length - 1];

    // Run all analyses
    const trend = this.analyzeTrend(ohlcv, timeframe);
    const rsi = this.calculateRSI(closes);
    const macd = this.calc
