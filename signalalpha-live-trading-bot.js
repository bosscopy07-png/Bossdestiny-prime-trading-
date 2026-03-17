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
    const macd = this.calculateMACD(closes);
    const volume = this.analyzeVolume(ohlcv);
    const levels = this.findKeyLevels(ohlcv, 2);
    const structure = this.analyzeStructure(ohlcv);
    const sweep = this.detectLiquiditySweep(ohlcv, levels);
    const atr = this.calculateATR(ohlcv);

    // Calculate Fibonacci if we have valid range
    let fibonacci = null;
    if (levels.support && levels.resistance) {
      fibonacci = this.calculateFibonacci(levels.resistance, levels.support);
    }

    return {
      timeframe,
      price: currentPrice,
      trend,
      momentum: { rsi, macd },
      volume,
      levels,
      structure,
      sweep,
      fibonacci,
      atr,
      timestamp: Date.now(),
    };
  }
}

// ==========================================
// END OF PART 2
//
// NEXT: Copy Part 3 below this section
// Part 3 contains: Confidence Engine & Strategy Detector
// ==========================================
// ==========================================
// PART 3: CONFIDENCE ENGINE & STRATEGY DETECTOR
// signalalpha-part3.js
// Continue from Part 2
// ==========================================

// ==========================================
// BALANCED CONFIDENCE SCORING ENGINE
// Key: 60-100 scale, realistic weights, no fake inflation
// ==========================================

class ConfidenceEngine {
  constructor() {
    this.weights = {
      trend: 20,      // Trend alignment
      momentum: 20,   // RSI + MACD confluence
      volume: 15,     // Volume confirmation
      levels: 15,     // S/R quality
      structure: 15,  // Market structure/BOS
      rr: 15,         // Risk:Reward ratio
    };
    console.log('🎯 ConfidenceEngine initialized with balanced weights');
  }

  calculate(analysis) {
    let score = 0;
    const details = [];
    const bonuses = [];
    const penalties = [];

    // ==========================================
    // 1. TREND ANALYSIS (0-20 points)
    // Balanced: rewards alignment, doesn't punish mixed signals harshly
    // ==========================================
    
    const { trend, multiTimeframe } = analysis;
    
    if (multiTimeframe?.alignment && trend?.strength > 60) {
      // Strong aligned trend across timeframes
      score += 18;
      details.push('✅ Strong multi-TF trend alignment (+18)');
    } else if (multiTimeframe?.alignment && trend?.strength > 40) {
      // Aligned but moderate strength
      score += 14;
      details.push('⚡ Moderate trend alignment (+14)');
    } else if (trend?.primary !== 'neutral' && trend?.strength > 30) {
      // Single timeframe trend only
      score += 10;
      details.push('📊 Single TF trend present (+10)');
    } else if (trend?.primary !== 'neutral') {
      // Weak trend
      score += 6;
      details.push('⚠️ Weak trend (+6)');
    } else {
      // No trend (ranging)
      score += 3;
      details.push('❌ No clear trend - ranging market (+3)');
    }

    // Bonus: EMA slope steepness (strong momentum)
    if (Math.abs(trend?.slope || 0) > 0.1) {
      score += 2;
      bonuses.push('📈 Strong EMA slope (+2)');
    }

    // ==========================================
    // 2. MOMENTUM CONFLUENCE (0-20 points)
    // Balanced RSI: 35-65 is "active zone", not 30-70 extremes
    // ==========================================
    
    const { momentum } = analysis;
    const rsi = momentum?.rsi?.value || 50;
    const macd = momentum?.macd;
    
    // RSI scoring (balanced - avoid extremes)
    let rsiScore = 0;
    const rsiMid = Math.abs(rsi - 50);
    
    if (rsi >= 40 && rsi <= 60) {
      // Sweet spot - active but not extreme
      rsiScore = 8;
      details.push(`✅ RSI in active zone ${rsi.toFixed(1)} (+8)`);
    } else if (rsi >= 35 && rsi <= 65) {
      // Good zone
      rsiScore = 6;
      details.push(`⚡ RSI moderate ${rsi.toFixed(1)} (+6)`);
    } else if (rsi >= 30 && rsi <= 70) {
      // Acceptable but approaching extreme
      rsiScore = 4;
      details.push(`⚠️ RSI near extreme ${rsi.toFixed(1)} (+4)`);
    } else {
      // Extreme - potential reversal zone
      rsiScore = 1;
      details.push(`❌ RSI extreme ${rsi.toFixed(1)} - caution (+1)`);
    }

    // MACD scoring
    let macdScore = 0;
    if (macd?.crossover !== 'none' && macd?.momentum > 0.001) {
      // Fresh crossover with momentum
      macdScore = 10;
      details.push(`✅ MACD ${macd.crossover} crossover (+10)`);
    } else if (macd?.trend?.includes('bullish') || macd?.trend?.includes('bearish')) {
      // Established trend (no crossover but directional)
      macdScore = 7;
      details.push(`📊 MACD ${macd.trend} (+7)`);
    } else if (macd?.momentum > 0.0005) {
      // Weak but present momentum
      macdScore = 4;
      details.push(`⚠️ Weak MACD momentum (+4)`);
    } else {
      macdScore = 1;
      details.push(`❌ No MACD momentum (+1)`);
    }

    // Divergence bonus (separate from main scoring)
    if (momentum?.rsi?.divergence?.bullish || momentum?.rsi?.divergence?.bearish) {
      score += 3;
      bonuses.push('🔄 RSI divergence detected (+3)');
    }

    score += rsiScore + macdScore;

    // ==========================================
    // 3. VOLUME CONFIRMATION (0-15 points)
    // Balanced: 1.3x is good, not requiring 2x+
    // ==========================================
    
    const { volume } = analysis;
    const volRatio = volume?.ratio || 1;
    
    if (volRatio >= 2.0) {
      score += 13;
      details.push(`✅ Strong volume ${volRatio.toFixed(1)}x (+13)`);
    } else if (volRatio >= 1.5) {
      score += 10;
      details.push(`⚡ Good volume ${volRatio.toFixed(1)}x (+10)`);
    } else if (volRatio >= 1.3) {
      // Threshold lowered from 1.5 to 1.3
      score += 7;
      details.push(`📊 Adequate volume ${volRatio.toFixed(1)}x (+7)`);
    } else if (volRatio >= 1.0) {
      score += 4;
      details.push(`⚠️ Average volume ${volRatio.toFixed(1)}x (+4)`);
    } else {
      score += 1;
      details.push(`❌ Low volume ${volRatio.toFixed(1)}x (+1)`);
    }

    // Volume-price confirmation bonus
    if (volume?.confirmation) {
      score += 2;
      bonuses.push('📈 Volume-price confirmation (+2)');
    }

    // ==========================================
    // 4. SUPPORT/RESISTANCE QUALITY (0-15 points)
    // Balanced: 1 touch is acceptable if level is clear
    // ==========================================
    
    const { levels } = analysis;
    
    if (levels?.valid && (levels.supportTouches >= 2 || levels.resistanceTouches >= 2)) {
      score += 13;
      details.push(`✅ Tested S/R levels (S:${levels.supportTouches} R:${levels.resistanceTouches}) (+13)`);
    } else if (levels?.valid && (levels.supportTouches >= 1 || levels.resistanceTouches >= 1)) {
      // Single touch is acceptable
      score += 9;
      details.push(`⚡ Basic S/R present (S:${levels.supportTouches} R:${levels.resistanceTouches}) (+9)`);
    } else if (levels?.support && levels?.resistance) {
      // Levels exist but not recently tested
      score += 6;
      details.push(`⚠️ S/R levels untested recently (+6)`);
    } else if (levels?.nearSupport || levels?.nearResistance) {
      // Price near key level
      score += 4;
      details.push(`📍 Price near S/R zone (+4)`);
    } else {
      score += 1;
      details.push(`❌ No clear S/R levels (+1)`);
    }

    // Range quality bonus (wide enough to trade)
    if (levels?.range && levels.range / analysis.price > 0.02) {
      score += 2;
      bonuses.push('📏 Good S/R range (+2)');
    }

    // ==========================================
    // 5. MARKET STRUCTURE (0-15 points)
    // BOS/CHoCH detection rewards momentum shifts
    // ==========================================
    
    const { structure } = analysis;
    
    if (structure?.bos === 'continuation' && structure?.trending) {
      // Best case: trend continuation with BOS
      score += 13;
      details.push(`✅ Trend continuation BOS (+13)`);
    } else if (structure?.bos !== 'none' && structure?.strength > 50) {
      // Strong breakout/breakdown
      score += 10;
      details.push(`⚡ Structure break (${structure.bos}) (+10)`);
    } else if (structure?.bos !== 'none') {
      // Weak BOS
      score += 7;
      details.push(`📊 Weak structure break (+7)`);
    } else if (structure?.trending && structure?.strength > 40) {
      // Trending but no recent BOS
      score += 5;
      details.push(`⚠️ Trending, no recent BOS (+5)`);
    } else if (structure?.consolidation) {
      // Ranging - harder to trade
      score += 3;
      details.push(`❌ Consolidating market (+3)`);
    } else {
      score += 2;
      details.push(`❓ Unclear structure (+2)`);
    }

    // Structure strength bonus
    if (structure?.strength > 70) {
      score += 2;
      bonuses.push('💪 Strong market structure (+2)');
    }

    // ==========================================
    // 6. RISK:REWARD RATIO (0-15 points)
    // Balanced: 1.5:1 minimum, 3:1 is excellent
    // ==========================================
    
    const rr = analysis.setup?.riskReward || 0;
    
    if (rr >= 3.0) {
      score += 15;
      details.push(`✅ Excellent R:R ${rr.toFixed(1)}:1 (+15)`);
    } else if (rr >= 2.5) {
      score += 12;
      details.push(`⚡ Very good R:R ${rr.toFixed(1)}:1 (+12)`);
    } else if (rr >= 2.0) {
      score += 10;
      details.push(`📊 Good R:R ${rr.toFixed(1)}:1 (+10)`);
    } else if (rr >= 1.5) {
      // Minimum threshold lowered from 2.0 to 1.5
      score += 7;
      details.push(`⚠️ Acceptable R:R ${rr.toFixed(1)}:1 (+7)`);
    } else if (rr >= 1.2) {
      score += 3;
      details.push(`❌ Poor R:R ${rr.toFixed(1)}:1 (+3)`);
    } else {
      score += 0;
      penalties.push(`🚫 Bad R:R ${rr.toFixed(1)}:1 (min 1.5:1)`);
    }

    // ==========================================
    // PENALTIES (avoid fake signals)
    // ==========================================
    
    // Penalty: Extreme volatility (choppy market)
    if (analysis.atr?.percent > 5) {
      score -= 5;
      penalties.push('⚠️ High volatility (-5)');
    }

    // Penalty: Very low volume (illiquid)
    if (volume?.ratio < 0.7) {
      score -= 3;
      penalties.push('⚠️ Very low volume (-3)');
    }

    // Penalty: Against major trend on 4H
    if (multiTimeframe?.higherTF?.primary !== 'neutral' && 
        multiTimeframe?.higherTF?.primary !== trend?.primary) {
      score -= 4;
      penalties.push('⚠️ Against 4H trend (-4)');
    }

    // ==========================================
    // FINAL SCORE CALCULATION
    // ==========================================
    
    // Clamp score 0-100
    let finalScore = Math.max(0, Math.min(100, score));
    
    // Round to nearest 5 for cleaner display
    finalScore = Math.round(finalScore / 5) * 5;

    // Determine tier and recommendation
    let tier, passed, confidence, recommendation;

    if (finalScore >= 80) {
      tier = 'A+';
      passed = true;
      confidence = 'high';
      recommendation = 'Strong signal - Execute with standard size';
    } else if (finalScore >= 70) {
      tier = 'A';
      passed = true;
      confidence = 'high';
      recommendation = 'Good signal - Execute with standard size';
    } else if (finalScore >= 60) {
      tier = 'B+';
      passed = true;
      confidence = 'medium';
      recommendation = 'Moderate signal - Reduce position size 25%';
    } else if (finalScore >= 50) {
      tier = 'B';
      passed = true;
      confidence = 'medium';
      recommendation = 'Marginal signal - Reduce size 50%, tight stops';
    } else if (finalScore >= 40) {
      tier = 'C';
      passed = false;
      confidence = 'low';
      recommendation = 'Weak signal - Avoid or paper trade';
    } else {
      tier = 'D';
      passed = false;
      confidence = 'low';
      recommendation = 'No trade - Insufficient confluence';
    }

    // Override: Must have minimum R:R regardless of score
    if (rr < CONFIG.RISK.MIN_RR) {
      passed = false;
      recommendation = 'R:R below minimum - No trade';
    }

    return {
      score: finalScore,
      tier,
      passed,
      confidence,
      recommendation,
      details,
      bonuses,
      penalties,
      breakdown: {
        trend: rsiScore + macdScore, // Approximate
        total: finalScore,
      },
    };
  }
}

// ==========================================
// STRATEGY DETECTOR (Real setups, not forced)
// Detects actual market patterns with quality ratings
// ==========================================

class StrategyDetector {
  constructor() {
    this.minQuality = 'B'; // Minimum quality to report
    console.log('🎲 StrategyDetector initialized');
  }

  detect(analysis) {
    const { trend, momentum, volume, levels, structure, sweep, fibonacci, price } = analysis;
    
    // Must have basic data
    if (!price || !levels?.support || !levels?.resistance) return null;

    // Check for each strategy type in order of priority
    const strategies = [
      this.detectLiquiditySweep.bind(this),
      this.detectTrendContinuation.bind(this),
      this.detectBreakout.bind(this),
      this.detectPullback.bind(this),
      this.detectRangePlay.bind(this),
    ];

    for (const detector of strategies) {
      const setup = detector(analysis);
      if (setup && this.qualityRank(setup.quality) >= this.qualityRank('B')) {
        return setup;
      }
    }

    return null;
  }

  qualityRank(q) {
    const ranks = { 'A+': 5, 'A': 4, 'B+': 3, 'B': 2, 'C': 1 };
    return ranks[q] || 0;
  }

  // ==========================================
  // 1. LIQUIDITY SWEEP (Highest priority - clean entry)
  // ==========================================
  
  detectLiquiditySweep(analysis) {
    const { sweep, levels, trend, price, momentum } = analysis;
    
    if (!sweep?.bullish && !sweep?.bearish && !sweep?.weakBullish && !sweep?.weakBearish) {
      return null;
    }

    const isBullish = sweep.bullish || sweep.weakBullish;
    const isStrong = sweep.bullish || sweep.bearish; // Not weak
    const direction = isBullish ? 'bullish' : 'bearish';
    
    // Verify: Sweep should align with momentum or trend
    const rsiOk = momentum?.rsi?.value > 30 && momentum?.rsi?.value < 70;
    const macdOk = momentum?.macd?.trend?.includes(direction === 'bullish' ? 'bull' : 'bear');
    
    if (!rsiOk && !macdOk) return null; // No confirmation

    // Calculate levels
    const stop = sweep.level * (direction === 'bullish' ? 0.985 : 1.015);
    const target = direction === 'bullish' ? levels.resistance : levels.support;
    const rr = Math.abs(target - price) / Math.abs(price - stop);

    if (rr < 1.5) return null; // Poor R:R

    return {
      type: 'Liquidity Sweep',
      direction,
      quality: isStrong ? 'A' : 'B+',
      entry: price,
      stop,
      target,
      rr,
      timeframe: '5M-15M',
      note: isStrong ? 'Clean liquidity grab' : 'Weak sweep - manage tight',
      invalidation: `Close beyond $${stop.toFixed(4)}`,
      confidence: isStrong ? 'high' : 'medium',
    };
  }

  // ==========================================
  // 2. TREND CONTINUATION (Pullback to EMA)
  // ==========================================
  
  detectTrendContinuation(analysis) {
    const { trend, price, levels, momentum, fibonacci } = analysis;
    
    if (trend?.primary === 'neutral') return null;
    if (trend?.strength < 40) return null; // Need decent trend

    const direction = trend.primary;
    
    // Check for pullback to key level
    const ema20 = trend.ema20;
    const ema50 = trend.ema50;
    
    const nearEma20 = ema20 && Math.abs(price - ema20) / price < 0.015; // 1.5%
    const nearEma50 = ema50 && Math.abs(price - ema50) / price < 0.025; // 2.5%
    
    // Or near Fibonacci retracement
    let nearFib = false;
    let fibLevel = null;
    if (fibonacci) {
      const fibLevels = [0.382, 0.5, 0.618];
      for (const f of fibLevels) {
        if (Math.abs(price - fibonacci[f]) / price < 0.012) {
          nearFib = true;
          fibLevel = f;
          break;
        }
      }
    }

    if (!nearEma20 && !nearEma50 && !nearFib) return null;

    // Momentum should be resetting (not overbought/oversold)
    const rsi = momentum?.rsi?.value || 50;
    const rsiResetting = direction === 'bullish' ? rsi < 60 : rsi > 40;
    if (!rsiResetting) return null;

    // Calculate levels
    const stop = direction === 'bullish' 
      ? (levels.support * 0.992 || price * 0.97)
      : (levels.resistance * 1.008 || price * 1.03);
    
    const target = direction === 'bullish'
      ? levels.resistance || price * 1.03
      : levels.support || price * 0.97;
    
    const rr = Math.abs(target - price) / Math.abs(price - stop);

    if (rr < 1.5) return null;

    const quality = trend.alignment ? 'A' : 'B+';
    
    return {
      type: 'Trend Continuation',
      direction,
      quality,
      entry: price,
      stop,
      target,
      rr,
      timeframe: '15M-1H',
      note: trend.alignment ? 'Aligned trend pullback' : 'Single TF trend - caution',
      invalidation: `Break of ${direction === 'bullish' ? 'support' : 'resistance'}`,
      confidence: trend.alignment ? 'high' : 'medium',
      context: nearFib ? `Near ${fibLevel} Fib` : nearEma20 ? 'Near EMA20' : 'Near EMA50',
    };
  }

  // ==========================================
  // 3. BREAKOUT PLAY (Structure break + volume)
  // ==========================================
  
  detectBreakout(analysis) {
    const { structure, volume, levels, momentum, price } = analysis;
    
    if (structure?.bos === 'none') return null;
    if (volume?.ratio < 1.3) return null; // Need volume confirmation
    
    // Determine direction from BOS
    const direction = structure.bos.includes('bullish') ? 'bullish' : 'bearish';
    
    // Check momentum aligns
    const macdAligns = momentum?.macd?.trend?.includes(direction === 'bullish' ? 'bull' : 'bear');
    if (!macdAligns) return null;

    // Entry: slight pullback to broken level or current price
    const entry = price;
    const stop = direction === 'bullish'
      ? levels.pivot || levels.support || price * 0.985
      : levels.pivot || levels.resistance || price * 1.015;
    
    const target = direction === 'bullish'
      ? (levels.resistance * 1.02 || price * 1.04)
      : (levels.support * 0.98 || price * 0.96);
    
    const rr = Math.abs(target - entry) / Math.abs(entry - stop);

    if (rr < 1.5) return null;

    const isClean = volume.ratio > 1.8 && structure.strength > 60;
    
    return {
      type: 'Breakout Play',
      direction,
      quality: isClean ? 'A' : 'B+',
      entry,
      stop,
      target,
      rr,
      timeframe: '5M-15M',
      note: isClean ? 'Clean BOS with volume' : 'Moderate breakout',
      invalidation: `Close back below ${direction === 'bullish' ? 'breakout' : 'breakdown'} level`,
      confidence: isClean ? 'high' : 'medium',
    };
  }

  // ==========================================
  // 4. PULLBACK TO S/R (Range extremes)
  // ==========================================
  
  detectPullback(analysis) {
    const { levels, price, trend, momentum } = analysis;
    
    if (!levels.nearSupport && !levels.nearResistance) return null;
    
    // Determine direction based on which level we're at
    const atSupport = levels.nearSupport;
    const direction = atSupport ? 'bullish' : 'bearish';
    
    // Don't fight strong trend
    if (trend?.primary !== 'neutral' && trend?.primary !== direction) {
      if (trend?.strength > 60) return null; // Strong opposite trend
    }

    // RSI should support the bounce
    const rsi = momentum?.rsi?.value || 50;
    const rsiOk = atSupport ? rsi < 55 : rsi > 45;
    if (!rsiOk) return null;

    const stop = atSupport
      ? levels.support * 0.99
      : levels.resistance * 1.01;
    
    const target = atSupport
      ? (levels.pivot || levels.resistance)
      : (levels.pivot || levels.support);
    
    const rr = Math.abs(target - price) / Math.abs(price - stop);

    if (rr < 1.5) return null;

    return {
      type: 'S/R Pullback',
      direction,
      quality: 'B+',
      entry: price,
      stop,
      target,
      rr,
      timeframe: '15M-30M',
      note: `Bounce from ${atSupport ? 'support' : 'resistance'}`,
      invalidation: `Close beyond ${atSupport ? 'support' : 'resistance'}`,
      confidence: 'medium',
    };
  }

  // ==========================================
  // 5. RANGE PLAY (Mean reversion - lowest priority)
  // ==========================================
  
  
  detectRangePlay(analysis) {
    const { structure, levels, price, volume } = analysis;
    
    if (!structure?.consolidation) return null;
    if (!levels.range || levels.range / price < 0.015) return null; // Need 1.5% range
    
    // Only at extremes, not middle
    const rangeMid = (levels.support + levels.resistance) / 2;
    const nearMid = Math.abs(price - rangeMid) / price < 0.005;
    if (nearMid) return null;

    const atResistance = Math.abs(price - levels.resistance) / price < 0.008;
    const atSupport = Math.abs(price - levels.support) / price < 0.008;
    
    if (!atResistance && !atSupport) return null;

    const direction = atSupport ? 'bullish' : 'bearish';
    
    // Volume should be normal (not breakout)
    if (volume?.trend === 'breakout') return null;

    const stop = atSupport
      ? levels.support * 0.992
      : levels.resistance * 1.008;
    
    const target = rangeMid; // Target middle of range
    
    const rr = Math.abs(target - price) / Math.abs(price - stop);

    if (rr < 1.2) return null; // Lower threshold for range plays

    return {
      type: 'Range Play',
      direction,
      quality: 'B',
      entry: price,
      stop,
      target,
      rr,
      timeframe: '15M-1H',
      note: 'Mean reversion in range',
      invalidation: `Break ${atSupport ? 'below support' : 'above resistance'}`,
      confidence: 'medium',
      warning: 'Counter-trend - reduce size',
    };
  }
}

// ==========================================
// END OF PART 3
//
// NEXT: Copy Part 4 below this section
// Part 4 contains: Signal Generator & Telegram Bot
// ==========================================
// ==========================================
// PART 4: SIGNAL GENERATOR & TELEGRAM BOT
// signalalpha-part4.js
// Continue from Part 3
// ==========================================

// ==========================================
// REAL-TIME SIGNAL GENERATOR
// Manages signal lifecycle, scanning, and monitoring
// ==========================================

class RealTimeSignalGenerator extends EventEmitter {
  constructor(marketData, ta, confidence, strategy) {
    super();
    this.marketData = marketData;
    this.ta = ta;
    this.confidence = confidence;
    this.strategy = strategy;
    this.activeSignals = new Map();
    this.tradeLogger = new TradeLogger();
    this.isScanning = false;
    this.scanStats = {
      lastScan: null,
      signalsToday: 0,
      scansCompleted: 0,
    };
    console.log('🎯 RealTimeSignalGenerator initialized');
  }

  // ==========================================
  // MULTI-TIMEFRAME ANALYSIS
  // ==========================================
  
  async analyzeSymbol(symbol) {
    console.log(`🔍 Analyzing ${symbol}...`);
    
    try {
      // Fetch multi-timeframe data with staggered limits
      const [m5, m15, h1, h4] = await Promise.all([
        this.marketData.fetchOHLCV(symbol, '5m', 100),
        this.marketData.fetchOHLCV(symbol, '15m', 100),
        this.marketData.fetchOHLCV(symbol, '1h', 80),
        this.marketData.fetchOHLCV(symbol, '4h', 50),
      ]);

      if (!m15 || !h1) {
        console.log(`⚠️ Insufficient data for ${symbol}`);
        return null;
      }

      const currentPrice = await this.marketData.getCurrentPrice(symbol);
      if (!currentPrice) {
        console.log(`⚠️ No price data for ${symbol}`);
        return null;
      }

      // Volume check (relaxed)
      const volume24h = await this.marketData.get24hVolume(symbol);
      if (volume24h < CONFIG.TA.MIN_VOLUME_USD) {
        console.log(`⚠️ Low volume for ${symbol}: $${volume24h.toLocaleString()}`);
        return null;
      }

      // Run full analysis on each timeframe
      const analysis5m = this.ta.runFullAnalysis(m5, '5m');
      const analysis15m = this.ta.runFullAnalysis(m15, '15m');
      const analysis1h = this.ta.runFullAnalysis(h1, '1h');
      const analysis4h = h4 ? this.ta.runFullAnalysis(h4, '4h') : null;

      // Multi-timeframe confluence
      const multiTimeframe = {
        primary: analysis15m.trend,
        higherTF: analysis1h.trend,
        alignment: analysis15m.trend.primary === analysis1h.trend.primary && 
                   analysis15m.trend.primary !== 'neutral' &&
                   analysis1h.trend.strength > 30,
        fourHour: analysis4h?.trend || { primary: 'neutral' },
      };

      // Use 15m as primary, 1h for confirmation
      const primary = analysis15m;
      
      // Detect strategy
      const setup = this.strategy.detect({
        ...primary,
        multiTimeframe,
        price: currentPrice,
      });

      if (!setup) {
        console.log(`📊 No strategy match for ${symbol}`);
        return null;
      }

      // Validate R:R meets minimum
      if (setup.rr < CONFIG.RISK.MIN_RR) {
        console.log(`⚠️ R:R too low for ${symbol}: ${setup.rr.toFixed(2)}:1`);
        return null;
      }

      // Full analysis object for confidence scoring
      const fullAnalysis = {
        symbol,
        price: currentPrice,
        multiTimeframe,
        momentum: primary.momentum,
        volume: primary.volume,
        levels: primary.levels,
        structure: primary.structure,
        sweep: primary.sweep,
        setup,
        atr: primary.atr,
      };

      // Calculate confidence
      const confidence = this.confidence.calculate(fullAnalysis);
      
      console.log(`📊 ${symbol}: ${setup.type} ${setup.direction} | Score: ${confidence.score}% (${confidence.tier}) | R:R ${setup.rr.toFixed(2)}:1`);

      return {
        ...fullAnalysis,
        confidence,
        timestamp: Date.now(),
      };

    } catch (err) {
      logger.error(`Analysis failed for ${symbol}:`, err.message);
      console.error(`❌ Analysis error for ${symbol}:`, err.message);
      return null;
    }
  }

  // ==========================================
  // SIGNAL BUILDER (Formats complete signal)
  // ==========================================
  
  buildSignal(analysis) {
    const { symbol, price, confidence, setup, multiTimeframe, momentum, volume, levels, atr } = analysis;
    
    // Dynamic position sizing based on confidence
    const currentCapital = CONFIG.CHALLENGE.CURRENT_CAPITAL;
    
    // Risk: 2% base, up to 4% for high confidence
    let riskPct = 2;
    if (confidence.score >= 85) riskPct = 4;
    else if (confidence.score >= 75) riskPct = 3;
    else if (confidence.score >= 60) riskPct = 2;
    else riskPct = 1; // Shouldn't happen due to filter

    const riskAmount = currentCapital * (riskPct / 100);
    const riskPrice = Math.abs(setup.entry - setup.stop);
    const positionSize = riskPrice > 0 ? (riskAmount / riskPrice) * setup.entry : 0;

    // Leverage: 5x-15x based on confidence and volatility
    let leverage = 5;
    if (confidence.score >= 80 && atr?.percent < 3) leverage = 15;
    else if (confidence.score >= 70 && atr?.percent < 4) leverage = 10;
    else if (confidence.score >= 60) leverage = 5;
    
    // Cap leverage by ATR (lower leverage for high volatility)
    if (atr?.percent > 5) leverage = Math.min(leverage, 3);

    const margin = positionSize / leverage;

    // Challenge progress
    const progress = ((currentCapital - CONFIG.CHALLENGE.START_CAPITAL) / 
                     (CONFIG.CHALLENGE.TARGET - CONFIG.CHALLENGE.START_CAPITAL) * 100);

    // Build execution steps
    const steps = [
      `Enter ${setup.timeframe} on ${setup.direction === 'bullish' ? 'green' : 'red'} candle close`,
      `Stop: $${setup.stop.toFixed(4)} (${((Math.abs(setup.stop - setup.entry) / setup.entry) * 100).toFixed(2)}%)`,
      `Target: $${setup.target.toFixed(4)} (R:R ${setup.rr.toFixed(2)}:1)`,
    ];

    // Add scale-out plan for good R:R
    if (setup.rr >= 2) {
      const scalePrice = setup.entry + (setup.target - setup.entry) * 0.5 * (setup.direction === 'bullish' ? 1 : -1);
      steps.push(`Scale 50% at $${scalePrice.toFixed(4)} (1:1 R:R), move SL to breakeven`);
    }

    return {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      validUntil: new Date(Date.now() + 4 * 3600000).toISOString(), // 4 hour validity
      
      symbol,
      direction: setup.direction === 'bullish' ? 'LONG' : 'SHORT',
      strategy: setup.type,
      quality: setup.quality,
      
      confidence: {
        score: confidence.score,
        tier: confidence.tier,
        level: confidence.confidence,
        details: confidence.details,
        bonuses: confidence.bonuses,
        penalties: confidence.penalties,
        recommendation: confidence.recommendation,
      },

      entry: {
        price: setup.entry,
        zone: {
          min: setup.entry * 0.998,
          max: setup.entry * 1.002,
        },
      },
      
      stopLoss: setup.stop,
      takeProfit: setup.target,
      riskReward: setup.rr.toFixed(2),
      
      position: {
        riskPct,
        riskAmount: riskAmount.toFixed(2),
        leverage,
        positionSize: positionSize.toFixed(4),
        margin: margin.toFixed(2),
        estProfit: (positionSize * (Math.abs(setup.target - setup.entry) / setup.entry)).toFixed(2),
        estLoss: riskAmount.toFixed(2),
      },

      analysis: {
        trend: multiTimeframe.primary.primary,
        trendStrength: multiTimeframe.primary.strength,
        trendAlignment: multiTimeframe.alignment,
        rsi: momentum.rsi.value.toFixed(1),
        rsiCondition: momentum.rsi.condition,
        macdTrend: momentum.macd.trend,
        macdCrossover: momentum.macd.crossover,
        volumeRatio: volume.ratio.toFixed(2),
        volumeTrend: volume.trend,
        support: levels.support?.toFixed(4) || 'N/A',
        resistance: levels.resistance?.toFixed(4) || 'N/A',
        supportTouches: levels.supportTouches,
        resistanceTouches: levels.resistanceTouches,
        structure: setup.context || multiTimeframe.primary.primary,
        atr: atr?.percent?.toFixed(2) + '%' || 'N/A',
      },

      execution: {
        steps,
        invalidation: setup.invalidation,
        warning: setup.warning || null,
        maxHold: setup.timeframe.includes('5M') ? '2-4 hours' : '4-8 hours',
      },

      challenge: {
        startCapital: CONFIG.CHALLENGE.START_CAPITAL,
        currentCapital: currentCapital.toFixed(2),
        target: CONFIG.CHALLENGE.TARGET,
        progress: Math.max(0, Math.min(100, progress)).toFixed(1),
        daysLeft: CONFIG.CHALLENGE.DAYS,
      },

      meta: {
        scannedAt: new Date().toISOString(),
        dataQuality: 'multi-timeframe',
        version: '2.0-balanced',
      },
    };
  }

  // ==========================================
  // SIGNAL GENERATION (Main entry point)
  // ==========================================
  
  async generateSignal(symbol, force = false) {
    console.log(`🎯 Generating signal for ${symbol} (force=${force})...`);
    
    // Check daily limit
    const todayCount = await this.tradeLogger.getTodaySignalCount();
    if (!force && todayCount >= CONFIG.RISK.MAX_SIGNALS_PER_DAY) {
      console.log(`⛅ Daily signal limit reached: ${todayCount}/${CONFIG.RISK.MAX_SIGNALS_PER_DAY}`);
      return null;
    }

    const analysis = await this.analyzeSymbol(symbol);
    if (!analysis) {
      return null;
    }

    // Confidence filter (60% minimum unless forced)
    if (!force && !analysis.confidence.passed) {
      console.log(`❌ Confidence too low: ${analysis.confidence.score}% - ${analysis.confidence.recommendation}`);
      return null;
    }

    // Build complete signal
    const signal = this.buildSignal(analysis);

    // Log and emit
    await this.tradeLogger.log('SIGNAL_GENERATED', {
      symbol,
      direction: signal.direction,
      confidence: signal.confidence.score,
      strategy: signal.strategy,
      quality: signal.quality,
      rr: signal.riskReward,
    });

    this.emit('signal', signal);
    this.activeSignals.set(signal.id, signal);
    this.scanStats.signalsToday = todayCount + 1;

    console.log(`✅ SIGNAL CREATED: ${signal.id} | ${symbol} ${signal.direction} | ${signal.confidence.score}% ${signal.quality}`);

    // Start monitoring
    this.monitorSignal(signal.id);

    return signal;
  }

  // ==========================================
  // CONTINUOUS SCANNING
  // ==========================================
  
  async startContinuousScanning() {
    if (this.isScanning) {
      console.log('⚠️ Scanning already active');
      return;
    }
    
    this.isScanning = true;
    console.log('🚀 Starting continuous market scanning...');
    this.emit('scanning_started');

    const scanLoop = async () => {
      while (this.isScanning) {
        try {
          // Check daily limit
          const todayCount = await this.tradeLogger.getTodaySignalCount();
          if (todayCount >= CONFIG.RISK.MAX_SIGNALS_PER_DAY) {
            console.log(`⛅ Daily limit reached (${todayCount}), pausing scans...`);
            await new Promise(r => setTimeout(r, 300000)); // 5 min wait
            continue;
          }

          console.log(`\n🔄 Scan Cycle #${++this.scanStats.scansCompleted} | Signals today: ${todayCount}/${CONFIG.RISK.MAX_SIGNALS_PER_DAY}`);
          
          // Get top volume pairs (rotating selection)
          const symbols = await this.marketData.getTopVolumeSymbols(20);
          
          // Shuffle for variety
          const shuffled = symbols.sort(() => 0.5 - Math.random());
          
          let signalsFound = 0;
          for (const symbol of shuffled) {
            if (!this.isScanning) break;
            
            // Skip if active signal exists for this symbol
            const hasActive = Array.from(this.activeSignals.values())
              .some(s => s.symbol === symbol && Date.now() - new Date(s.timestamp).getTime() < 7200000);
            
            if (hasActive) {
              console.log(`⏭️ Skipping ${symbol} - active signal`);
              continue;
            }

            const signal = await this.generateSignal(symbol);
            if (signal) {
              signalsFound++;
              // Wait between signals
              await new Promise(r => setTimeout(r, 3000));
              
              // Break if daily limit hit after this signal
              if (await this.tradeLogger.getTodaySignalCount() >= CONFIG.RISK.MAX_SIGNALS_PER_DAY) {
                break;
              }
            } else {
              // Small delay between scans
              await new Promise(r => setTimeout(r, 500));
            }
          }
          
          this.scanStats.lastScan = new Date();
          console.log(`✅ Scan complete. Found: ${signalsFound} signals`);
          
          // Wait before next cycle (30-60s random to avoid patterns)
          const waitTime = 30000 + Math.random() * 30000;
          await new Promise(r => setTimeout(r, waitTime));
          
        } catch (err) {
          logger.error('Scan loop error:', err.message);
          console.error('❌ Scan loop error:', err.message);
          await new Promise(r => setTimeout(r, 60000));
        }
      }
    };

    scanLoop();
  }

  stopScanning() {
    console.log('⏹️ Stopping market scanning...');
    this.isScanning = false;
    this.emit('scanning_stopped');
  }

  // ==========================================
  // SIGNAL MONITORING (Live tracking)
  // ==========================================
  
  async monitorSignal(signalId) {
    const signal = this.activeSignals.get(signalId);
    if (!signal) return;

    console.log(`👁️  Monitoring ${signal.symbol} ${signal.direction} | Entry: $${signal.entry.price.toFixed(4)} | SL: $${signal.stopLoss.toFixed(4)} | TP: $${signal.takeProfit.toFixed(4)}`);

    let checkCount = 0;
    const checkInterval = setInterval(async () => {
      try {
        checkCount++;
        const currentPrice = await this.marketData.getCurrentPrice(signal.symbol);
        if (!currentPrice) return;

        // Progress tracking (every 10 checks = ~50s)
        if (checkCount % 10 === 0) {
          const pnlPct = signal.direction === 'LONG' 
            ? ((currentPrice - signal.entry.price) / signal.entry.price) * 100
            : ((signal.entry.price - currentPrice) / signal.entry.price) * 100;
          console.log(`📊 ${signal.symbol} | Check #${checkCount} | Price: $${currentPrice.toFixed(4)} | P&L: ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%`);
        }

        // Check stop loss
        if (signal.direction === 'LONG' && currentPrice <= signal.stopLoss) {
          this.closeSignal(signalId, 'stop_loss', currentPrice, checkInterval);
        }
        // Check take profit
        else if (signal.direction === 'LONG' && currentPrice >= signal.takeProfit) {
          this.closeSignal(signalId, 'take_profit', currentPrice, checkInterval);
        }
        // Short variants
        else if (signal.direction === 'SHORT' && currentPrice >= signal.stopLoss) {
          this.closeSignal(signalId, 'stop_loss', currentPrice, checkInterval);
        }
        else if (signal.direction === 'SHORT' && currentPrice <= signal.takeProfit) {
          this.closeSignal(signalId, 'take_profit', currentPrice, checkInterval);
        }
        
      } catch (err) {
        logger.error(`Monitor error for ${signal.symbol}:`, err.message);
      }
    }, 5000);

    // Auto-expire after 4 hours
    setTimeout(() => {
      if (this.activeSignals.has(signalId)) {
        console.log(`⏰ Signal ${signalId} expired (4h timeout)`);
        clearInterval(checkInterval);
        this.activeSignals.delete(signalId);
        this.tradeLogger.log('SIGNAL_EXPIRED', { signalId, symbol: signal.symbol });
      }
    }, 4 * 3600000);
  }

  async closeSignal(signalId, result, exitPrice, interval) {
    clearInterval(interval);
    const signal = this.activeSignals.get(signalId);
    if (!signal) return;

    const pnl = result === 'take_profit' 
      ? parseFloat(signal.position.estProfit)
      : -parseFloat(signal.position.estLoss);
    
    const pnlPct = (pnl / CONFIG.CHALLENGE.CURRENT_CAPITAL) * 100;

    console.log(`🏁 SIGNAL CLOSED: ${signal.symbol} ${result.toUpperCase()} @ $${exitPrice.toFixed(4)} | P&L: $${pnl.toFixed(2)} (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`);

    this.emit('signal_closed', { signal, result, exitPrice, pnl, pnlPct });
    this.activeSignals.delete(signalId);

    await this.tradeLogger.log('SIGNAL_CLOSED', {
      signalId,
      symbol: signal.symbol,
      result,
      exitPrice,
      pnl,
      pnlPct,
      duration: Date.now() - new Date(signal.timestamp).getTime(),
    });

    // Update challenge capital (simulated)
    CONFIG.CHALLENGE.CURRENT_CAPITAL += pnl;
  }

  getActiveSignals() {
    return Array.from(this.activeSignals.values());
  }

  getStats() {
    return {
      ...this.scanStats,
      activeSignals: this.activeSignals.size,
      isScanning: this.isScanning,
    };
  }
}

// ==========================================
// TELEGRAM BOT INTERFACE
// ==========================================

class SignalAlphaTelegramBot {
  constructor() {
    console.log('🤖 Initializing SignalAlphaTelegramBot...');
    
    if (!CONFIG.BOT_TOKEN) {
      throw new Error('BOT_TOKEN is required in .env file');
    }

    this.bot = new Telegraf(CONFIG.BOT_TOKEN);
    this.marketData = new MarketDataEngine();
    this.ta = new InstitutionalTA(this.marketData);
    this.confidence = new ConfidenceEngine();
    this.strategy = new StrategyDetector();
    this.generator = new RealTimeSignalGenerator(this.marketData, this.ta, this.confidence, this.strategy);
    this.tradeLogger = new TradeLogger();

    this.userSettings = new Map();
    this.setupBot();

    console.log('✅ SignalAlphaTelegramBot constructed');
  }

  setupBot() {
    console.log('⚙️ Setting up bot handlers...');

    // Admin middleware
    this.bot.use(async (ctx, next) => {
      ctx.isAdmin = CONFIG.ADMIN_IDS.includes(String(ctx.from?.id));
      await next();
    });

    this.setupCommands();
    this.setupActions();
    this.setupCallbacks();

    // Event listeners
    this.generator.on('signal', (signal) => this.handleNewSignal(signal));
    this.generator.on('signal_closed', (data) => this.handleSignalClose(data));
    this.generator.on('scanning_started', () => this.broadcastToAdmins('🔥 Live scanning activated'));
    this.generator.on('scanning_stopped', () => this.broadcastToAdmins('⏹️ Scanning stopped'));

    console.log('✅ Bot handlers configured');
  }

  setupCommands() {
    // /start - Welcome
    this.bot.command('start', async (ctx) => {
      console.log(`👤 User started: ${ctx.from.id}`);
      
      const welcome = [
        '🎯 *SignalAlpha v2.0 - Balanced Signals*',
        '',
        'Real-time crypto analysis with calibrated thresholds.',
        'No fake signals. No missed opportunities.',
        '',
        '*Key Features:*',
        '• 60%+ confidence threshold (balanced)',
        '• 1.5:1 minimum R:R (realistic)',
        '• Multi-timeframe confluence',
        '• Live market monitoring',
        '',
        '📊 /dashboard - View challenge progress',
        '🎯 /signal - Get manual signal scan',
        '🔥 /live - Start auto-scanning (admin)',
        '',
        `🎁 [Trade on BingX](${CONFIG.REFERRAL.LINK}) | Code: \`${CONFIG.REFERRAL.CODE}\``,
        
      await ctx.reply(welcome, {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Dashboard', 'DASHBOARD'), Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL')],
          [Markup.button.callback('📈 Stats', 'STATS'), Markup.button.callback('⚙️ Settings', 'SETTINGS')]
        ])
      });
    });

    // /dashboard - Challenge progress
    this.bot.command('dashboard', async (ctx) => {
      await this.sendDashboard(ctx.chat.id, ctx.isAdmin);
    });

    // /signal - Manual scan
    this.bot.command('signal', async (ctx) => {
      await ctx.reply('🔍 Scanning for qualified setups...', { parse_mode: 'Markdown' });
      
      const symbols = await this.marketData.getTopVolumeSymbols(10);
      let found = false;
      
      for (const symbol of symbols) {
        const signal = await this.generator.generateSignal(symbol);
        if (signal) {
          await this.sendSignal(ctx.chat.id, signal);
          found = true;
          break;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      
      if (!found) {
        await ctx.reply([
          '❌ *No qualified setups found*',
          '',
          'Markets are consolidating or signals don\\\'t meet quality thresholds.',
          '',
          'Try again in 15-30 minutes, or enable auto-alerts.',
          '',
          'Quality > Quantity. Patience pays.'
        ].join('\n'), {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔔 Auto-Alerts', 'ENABLE_ALERTS')],
            [Markup.button.callback('📊 Dashboard', 'DASHBOARD')]
          ])
        });
      }
    });

    // /live - Start scanning (admin only)
    this.bot.command('live', async (ctx) => {
      if (!ctx.isAdmin) {
        return ctx.reply('⛔ Admin only command');
      }
      
      await ctx.reply('🔥 Starting live market scanning...');
      await this.generator.startContinuousScanning();
    });

    // /stop - Stop scanning (admin only)
    this.bot.command('stop', async (ctx) => {
      if (!ctx.isAdmin) {
        return ctx.reply('⛔ Admin only command');
      }
      
      this.generator.stopScanning();
      await ctx.reply('⏹️ Scanning stopped.');
    });

    // /stats - System statistics
    this.bot.command('stats', async (ctx) => {
      const stats = this.generator.getStats();
      const recent = await this.tradeLogger.getRecentTrades(24);
      const signals24h = recent.filter(r => r.type === 'SIGNAL_GENERATED').length;
      const closed24h = recent.filter(r => r.type === 'SIGNAL_CLOSED');
      
      const wins = closed24h.filter(r => r.result === 'take_profit').length;
      const losses = closed24h.filter(r => r.result === 'stop_loss').length;
      const winRate = closed24h.length > 0 ? ((wins / closed24h.length) * 100).toFixed(1) : 'N/A';

      await ctx.reply([
        '📊 *24H Statistics*',
        '',
        `Signals Generated: ${signals24h}/${CONFIG.RISK.MAX_SIGNALS_PER_DAY} daily limit`,
        `Active Signals: ${stats.activeSignals}`,
        `Scanning: ${stats.isScanning ? '🟢 ON' : '⚪ OFF'}`,
        `Scan Cycles: ${stats.scansCompleted}`,
        '',
        `Closed Signals: ${closed24h.length}`,
        `Win Rate: ${winRate}% (${wins}W/${losses}L)`,
        '',
        `Markets Tracked: ${this.marketData.perpetualMarkets?.length || 0}`,
        `Challenge Day: ${CONFIG.CHALLENGE.DAYS}`,
        `Capital: $${CONFIG.CHALLENGE.CURRENT_CAPITAL.toFixed(2)}`
      ].join('\n'), { parse_mode: 'Markdown' });
    });

    console.log('✅ Commands registered: /start, /dashboard, /signal, /live, /stop, /stats');
  }

  setupActions() {
    // Dashboard
    this.bot.action('DASHBOARD', async (ctx) => {
      await ctx.answerCbQuery();
      await this.sendDashboard(ctx.chat.id, ctx.isAdmin);
    });

    // Get Signal
    this.bot.action('GET_SIGNAL', async (ctx) => {
      await ctx.answerCbQuery('Scanning...');
      await ctx.reply('🔍 Scanning top pairs for A-B+ setups...');
      
      const majors = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'BNB/USDT:USDT', 'XRP/USDT:USDT'];
      
      for (const symbol of majors) {
        const signal = await this.generator.generateSignal(symbol);
        if (signal) {
          await this.sendSignal(ctx.chat.id, signal);
          return;
        }
        await new Promise(r => setTimeout(r, 1500));
      }
      
      await ctx.reply('❌ No qualified setups found in majors. Try /signal for broader scan.');
    });

    // Stats
    this.bot.action('STATS', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply('Use /stats command for full statistics');
    });

    // Settings
    this.bot.action('SETTINGS', async (ctx) => {
      await ctx.answerCbQuery();
      const settings = this.userSettings.get(ctx.from.id) || {};
      
      await ctx.reply([
        '⚙️ *User Settings*',
        '',
        `Min Confidence: ${settings.minConfidence || 60}%`,
        `Notifications: ${settings.notifications !== false ? '✅ ON' : '❌ OFF'}`,
        '',
        'Adjust confidence threshold:'
      ].join('\n'), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('60% (Balanced)', 'SET_CONF_60')],
          [Markup.button.callback('70% (Conservative)', 'SET_CONF_70')],
          [Markup.button.callback('80% (Strict)', 'SET_CONF_80')],
          [Markup.button.callback('🔙 Back', 'MAIN_MENU')]
        ])
      });
    });

    // Confidence settings
    this.bot.action(/SET_CONF_(\d+)/, async (ctx) => {
      const conf = parseInt(ctx.match[1]);
      this.userSettings.set(ctx.from.id, { 
        ...(this.userSettings.get(ctx.from.id) || {}),
        minConfidence: conf 
      });
      await ctx.answerCbQuery(`Min confidence: ${conf}%`);
      await ctx.reply(`✅ Minimum confidence set to ${conf}%`);
    });

    // Main menu
    this.bot.action('MAIN_MENU', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply('🏠 *Main Menu*', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Dashboard', 'DASHBOARD'), Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL')],
          [Markup.button.callback('📈 Stats', 'STATS'), Markup.button.callback('⚙️ Settings', 'SETTINGS')]
        ])
      });
    });

    console.log('✅ Action handlers configured');
  }

  setupCallbacks() {
    // Signal taken/skipped callbacks
    this.bot.action(/TAKEN_(.+)/, async (ctx) => {
      const signalId = ctx.match[1];
      await ctx.answerCbQuery('✅ Marked as taken - Good luck!');
      await ctx.reply('📝 Signal marked as TAKEN. Trade with discipline!');
      await this.tradeLogger.log('SIGNAL_TAKEN', { signalId, user: ctx.from.id });
    });

    this.bot.action(/SKIPPED_(.+)/, async (ctx) => {
      const signalId = ctx.match[1];
      await ctx.answerCbQuery('Skipped');
      await this.tradeLogger.log('SIGNAL_SKIPPED', { signalId, user: ctx.from.id });
    });

    // Enable alerts (placeholder)
    this.bot.action('ENABLE_ALERTS', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply('🔔 Auto-alerts enabled. You will receive signals when they meet quality thresholds.');
    });
  }

  // ==========================================
  // MESSAGE BUILDERS
  // ==========================================
  
  async sendDashboard(chatId, isAdmin = false) {
    const current = CONFIG.CHALLENGE.CURRENT_CAPITAL;
    const start = CONFIG.CHALLENGE.START_CAPITAL;
    const target = CONFIG.CHALLENGE.TARGET;
    const progress = ((current - start) / (target - start)) * 100;
    
    const progressBar = (pct) => {
      const filled = Math.round(pct / 10);
      return '█'.repeat(filled) + '░'.repeat(10 - filled);
    };

    const stats = this.generator.getStats();

    const text = [
      '🎯 *SIGNALALPHA DASHBOARD*',
      '',
      `💰 Capital: $${current.toFixed(2)} / $${target}`,
      `📈 Progress: ${Math.max(0, progress).toFixed(1)}% ${progressBar(progress)}`,
      `📅 Challenge: Day 1/${CONFIG.CHALLENGE.DAYS}`,
      '',
      '*System Status:*',
      `🔍 Scanning: ${stats.isScanning ? '🟢 ACTIVE' : '⚪ IDLE'}`,
      `📊 Markets: ${this.marketData.perpetualMarkets?.length || 0} tracked`,
      `🎯 Signals Today: ${stats.signalsToday}/${CONFIG.RISK.MAX_SIGNALS_PER_DAY}`,
      `⏱️ Last Scan: ${stats.lastScan ? new Date(stats.lastScan).toLocaleTimeString() : 'Never'}`,
      '',
      '*Risk Limits:*',
      `Daily Loss: ${CONFIG.RISK.DAILY_LOSS_LIMIT_PCT}% ($${(start * CONFIG.RISK.DAILY_LOSS_LIMIT_PCT / 100).toFixed(2)})`,
      `Max Consecutive Losses: ${CONFIG.RISK.MAX_CONSECUTIVE_LOSSES}`,
      `Active Signals: ${stats.activeSignals}`,
      '',
      `🎁 [Trade on BingX](${CONFIG.REFERRAL.LINK}) | Code: \`${CONFIG.REFERRAL.CODE}\``

    const buttons = isAdmin ? [
      [Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL'), Markup.button.callback('🔥 Start Live', 'START_LIVE')],
      [Markup.button.callback('⏹️ Stop Scan', 'STOP_SCAN'), Markup.button.callback('📊 Stats', 'STATS')],
      [Markup.button.callback('⚙️ Settings', 'SETTINGS')]
    ] : [
      [Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL'), Markup.button.callback('📊 Stats', 'STATS')],
      [Markup.button.callback('⚙️ Settings', 'SETTINGS')]
    ];

    try {
      await this.bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons)
      });
    } catch (err) {
      console.error('Failed to send dashboard:', err.message);
    }
  }

  async sendSignal(chatId, signal) {
    const qualityEmoji = { 'A+': '🥇', 'A': '🥈', 'B+': '🥉', 'B': '📊' };
    
    const text = [
      `╔══════════════════════════════════════════════════════════════╗`,
      `║     ${qualityEmoji[signal.quality] || '📊'} SIGNALALPHA CRYPTO SIGNAL ${qualityEmoji[signal.quality] || '📊'}     ║`,
      `║           [$${signal.challenge.startCapital} → $${signal.challenge.target} Challenge]              ║`,
      `╚══════════════════════════════════════════════════════════════╝`,
      '',
      '📋 *SETUP DETAILS*',
      `Strategy: *${signal.strategy}* [${signal.quality}]`,
      `Direction: ${signal.direction === 'LONG' ? '🟢 *LONG*' : '🔴 *SHORT*'}`,
      `Confidence: *${signal.confidence.score}%* (${signal.confidence.tier})`,
      `Risk/Reward: *1:${signal.riskReward}*`,
      '',
      '💰 *ENTRY & EXITS*',
      `Entry Zone: $${signal.entry.zone.min.toFixed(4)} - $${signal.entry.zone.max.toFixed(4)}`,
      `Stop Loss: $${signal.stopLoss.toFixed(4)} (${((Math.abs(signal.stopLoss - signal.entry.price) / signal.entry.price) * 100).toFixed(2)}%)`,
      `Take Profit: $${signal.takeProfit.toFixed(4)}`,
      '',
      '⚙️ *POSITION*',
      `Risk: ${signal.position.riskPct}% ($${signal.position.riskAmount})`,
      `Leverage: ${signal.position.leverage}x`,
      `Position Size: $${signal.position.positionSize}`,
      `Margin Required: $${signal.position.margin}`,
      `Est. Profit: $${signal.position.estProfit} | Est. Loss: $${signal.position.estLoss}`,
      '',
      '📊 *ANALYSIS*',
      `Trend: ${signal.analysis.trend} (${signal.analysis.trendStrength}% strength)`,
      `Alignment: ${signal.analysis.trendAlignment ? '✅ Aligned' : '⚠️ Single TF'}`,
      `Momentum: RSI ${signal.analysis.rsi} (${signal.analysis.rsiCondition})`,
      `Volume: ${signal.analysis.volumeRatio}x avg (${signal.analysis.volumeTrend})`,
      `S/R: S $${signal.analysis.support} (${signal.analysis.supportTouches}t) / R $${signal.analysis.resistance} (${signal.analysis.resistanceTouches}t)`,
      `Structure: ${signal.analysis.structure}`,
      '',
      '🎯 *EXECUTION PLAN*',
      ...signal.execution.steps.map((step, i) => `${i + 1}. ${step}`),
      '',
      signal.execution.warning ? `⚠️ *WARNING:* ${signal.execution.warning}` : '',
      signal.execution.maxHold ? `⏰ Max Hold: ${signal.execution.maxHold}` : '',
      '',
      '📈 *CHALLENGE TRACKER*',
      `Progress: ${signal.challenge.progress}% ${'█'.repeat(Math.round(signal.challenge.progress / 10))}${'░'.repeat(10 - Math.round(signal.challenge.progress / 10))}`,
      `Current: $${signal.challenge.currentCapital} | Target: $${signal.challenge.target}`,
      '',
      '═══════════════════════════════════════════════════════════════',
      `🔗 ${CONFIG.REFERRAL.LINK}`,
      `🎁 Code: ${CONFIG.REFERRAL.CODE}`,
      '═══════════════════════════════════════════════════════════════',
      '',
      `⚡ ${signal.confidence.recommendation}`,
      '',
      `🆔 Signal ID: \`${signal.id.substr(0, 8)}\``
    ].filter(Boolean).join('\n');

    try {
      await this.bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Taking This', `TAKEN_${signal.id}`), Markup.button.callback('❌ Skip', `SKIPPED_${signal.id}`)],
          [Markup.button.callback('📊 Dashboard', 'DASHBOARD')]
        ])
      });
      console.log(`✅ Signal sent to ${chatId}`);
    } catch (err) {
      console.error(`❌ Failed to send signal to ${chatId}:`, err.message);
    }
  }

  // ==========================================
  // EVENT HANDLERS
  // ==========================================
  
  async handleNewSignal(signal) {
    // Broadcast to all admins
    for (const adminId of CONFIG.ADMIN_IDS) {
      try {
        await this.sendSignal(adminId, signal);
      } catch (err) {
        console.error(`Failed to notify admin ${adminId}:`, err.message);
      }
    }
  }

  async handleSignalClose(data) {
    const { signal, result, pnl, pnlPct } = data;
    
    const emoji = result === 'take_profit' ? '🎯' : '🛑';
    const text = [
      `${emoji} *SIGNAL CLOSED*`,
      '',
      `${signal.symbol} ${signal.direction}`,
      `Result: *${result.toUpperCase()}*`,
      `P&L: $${Math.abs(pnl).toFixed(2)} (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`,
      '',
      `Updated Capital: $${CONFIG.CHALLENGE.CURRENT_CAPITAL.toFixed(2)}`
    ].join('\n');

    // Notify admins
    for (const adminId of CONFIG.ADMIN_IDS) {
      try {
        await this.bot.telegram.sendMessage(adminId, text, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error(`Failed to notify close to ${adminId}:`, err.message);
      }
    }
  }

  async broadcastToAdmins(message) {
    for (const adminId of CONFIG.ADMIN_IDS) {
      try {
        await this.bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error(`Broadcast failed to ${adminId}:`, err.message);
      }
    }
  }

  // ==========================================
  // MAIN STARTUP
  // ==========================================
  
  async start() {
    console.log('🚀 Starting SignalAlpha Bot...');
    
    // Initialize market data
    await this.marketData.initialize();
    
    // Launch bot
    await this.bot.launch();
    console.log('✅ Telegram bot launched');
    
    // Auto-start scanning if configured
    if (process.env.AUTO_START_SCAN === 'true') {
      console.log('🔥 Auto-starting continuous scanning...');
      setTimeout(() => this.generator.startContinuousScanning(), 5000);
    }

    // Graceful shutdown
    process.once('SIGINT', () => this.shutdown('SIGINT'));
    process.once('SIGTERM', () => this.shutdown('SIGTERM'));
    
    console.log('🎯 SignalAlpha v2.0 is LIVE!');
  }

  shutdown(signal) {
    console.log(`\n👋 ${signal} received, shutting down gracefully...`);
    this.generator.stopScanning();
    this.bot.stop(signal);
    process.exit(0);
  }
}

// ==========================================
// MAIN ENTRY POINT
// ==========================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     🚀 SIGNALALPHA TRADING BOT v2.0 - BALANCED EDITION     ║');
  console.log('║                                                            ║');
  console.log('║  Thresholds: 60% confidence | 1.5:1 R:R | Real signals     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // Validate config
  if (!CONFIG.BOT_TOKEN) {
    console.error('❌ BOT_TOKEN required in .env file');
    process.exit(1);
  }

  try {
    const bot = new SignalAlphaTelegramBot();
    await bot.start();
  } catch (err) {
    console.error('💥 Fatal error:', err.message);
    process.exit(1);
  }
}

// Run
main().catch(err => {
  console.error('💥 Unhandled error:', err.message);
  process.exit(1);
});

// ==========================================
// END OF PART 4 - COMPLETE SYSTEM
// ==========================================
