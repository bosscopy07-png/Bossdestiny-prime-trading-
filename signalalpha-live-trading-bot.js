// signalalpha-live-trading-bot.js
// Institutional-Grade Real-Time Crypto Signal Bot
// Live Trading Ready - Single File Implementation

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
// CONFIGURATION & CONSTANTS
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
  
  // Risk Management (Strict)
  RISK: {
    DAILY_LOSS_LIMIT_PCT: 5,
    WEEKLY_LOSS_LIMIT_PCT: 15,
    MAX_CONSECUTIVE_LOSSES: 3,
    MAX_SIGNALS_PER_DAY: 6,
    MIN_CONFIDENCE: 70,
    MIN_RR: 2.0,
    MAX_RISK_PER_TRADE_PCT: 5,
  },
  
  // Technical Analysis
  TA: {
    TIMEFRAMES: ['5m', '15m', '1h', '4h'],
    EMA_FAST: 50,
    EMA_SLOW: 200,
    RSI_PERIOD: 14,
    RSI_OVERBOUGHT: 70,
    RSI_OVERSOLD: 30,
    VOLUME_THRESHOLD: 1.5, // 150% of average
  },
  
  // Exchange Configuration
  EXCHANGE: {
    SANDBOX: process.env.SANDBOX === 'true',
    DEFAULT_TYPE: 'swap', // perpetual futures
    ID: 'bingx', // Default exchange
  },
  
  // Market Data
  DATA: {
    COINGECKO_API: 'https://api.coingecko.com/api/v3',
    BINANCE_FUTURES_WS: 'wss://fstream.binance.com/ws',
    UPDATE_INTERVAL_MS: 5000,
    MIN_VOLUME_USD: 10000000, // $10M minimum
  },
  
  // Referral
  REFERRAL: {
    LINK: 'https://bingxdao.com/invite/4UAWNP/',
    CODE: '4UAWNP',
  },
  
  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

console.log('✅ CONFIG loaded successfully');
console.log(`📊 Challenge: $${CONFIG.CHALLENGE.START_CAPITAL} → $${CONFIG.CHALLENGE.TARGET}`);
console.log(`👥 Admin IDs: ${CONFIG.ADMIN_IDS.length > 0 ? CONFIG.ADMIN_IDS.join(', ') : 'None set'}`);

// ==========================================
// ADVANCED LOGGER WITH TRADE LOGGING
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

// File logger for trade history
class TradeLogger {
  constructor(filename = 'trades.log') {
    this.filename = filename;
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
      const lines = content.trim().split('\n');
      const cutoff = Date.now() - (hours * 3600000);
      
      const trades = lines
        .map(line => JSON.parse(line))
        .filter(trade => new Date(trade.timestamp).getTime() > cutoff);
      
      console.log(`✅ Found ${trades.length} trades in last ${hours}h`);
      return trades;
    } catch (err) {
      console.warn(`⚠️ Could not read ${this.filename}:`, err.message);
      return [];
    }
  }
}

// ==========================================
// REAL-TIME MARKET DATA ENGINE
// ==========================================

class MarketDataEngine extends EventEmitter {
  constructor() {
    super();
    console.log('🏗️  Initializing MarketDataEngine...');
    
    // Initialize CCXT exchange
    try {
      this.exchange = new ccxt.bingx({
        enableRateLimit: true,
        options: {
          defaultType: CONFIG.EXCHANGE.DEFAULT_TYPE,
        }
      });
      
      if (CONFIG.EXCHANGE.SANDBOX) {
        this.exchange.setSandboxMode(true);
        console.log('🔒 Sandbox mode enabled');
      }
      
      console.log(`✅ Exchange initialized: ${CONFIG.EXCHANGE.ID}`);
    } catch (err) {
      console.error('❌ Failed to initialize exchange:', err.message);
      throw err;
    }

    this.priceCache = new Map();
    this.ohlcvCache = new Map();
    this.orderBookCache = new Map();
    this.fundingRates = new Map();
    this.wsConnections = new Map();
    this.isRunning = false;
    this.perpetualMarkets = [];
    
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

      // Filter USDT perpetual futures
      console.log('🔍 Filtering perpetual markets...');
      this.perpetualMarkets = Object.values(this.exchange.markets)
        .filter(m => m.type === 'swap' && m.quote === 'USDT' && m.active)
        .map(m => m.symbol);
      
      logger.info(`Found ${this.perpetualMarkets.length} active perpetual markets`);
      console.log(`✅ Found ${this.perpetualMarkets.length} perpetual markets`);
      console.log(`📊 Top markets: ${this.perpetualMarkets.slice(0, 5).join(', ')}...`);

      // Start WebSocket feeds for major pairs
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
    const majorPairs = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'xrpusdt', 'dogeusdt'];
    console.log(`🔌 Starting WebSocket connections for ${majorPairs.length} pairs...`);
    
    for (const pair of majorPairs) {
      const wsUrl = `${CONFIG.DATA.BINANCE_FUTURES_WS}/${pair}@kline_1m`;
      console.log(`🔗 Connecting to ${wsUrl}...`);
      
      const ws = new WebSocket(wsUrl);
      
      ws.on('open', () => {
        logger.info(`WebSocket connected: ${pair}`);
        console.log(`✅ WebSocket connected: ${pair}`);
      });
      
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.k) {
            const candle = msg.k;
            this.priceCache.set(pair, {
              price: parseFloat(candle.c),
              volume: parseFloat(candle.v),
              timestamp: Date.now(),
            });
          }
        } catch (err) {
          // Ignore parse errors
        }
      });
      
      ws.on('error', (err) => {
        logger.warn(`WebSocket error for ${pair}:`, err.message);
        console.error(`❌ WebSocket error for ${pair}:`, err.message);
      });
      
      ws.on('close', () => {
        logger.warn(`WebSocket closed for ${pair}, reconnecting...`);
        console.warn(`⚠️ WebSocket closed for ${pair}, will reconnect in 5s...`);
        setTimeout(() => this.startWebSocketFeeds(), 5000);
      });
      
      this.wsConnections.set(pair, ws);
    }
    console.log('✅ All WebSocket connections initiated');
  }

  startOhlcvPolling() {
    console.log('⏱️  Starting OHLCV polling (10s interval)...');
    // Poll OHLCV every 10 seconds for active timeframes
    setInterval(async () => {
      const symbolsToPoll = this.perpetualMarkets.slice(0, 20);
      console.log(`🔄 Polling OHLCV for ${symbolsToPoll.length} symbols...`);
      
      for (const symbol of symbolsToPoll) {
        for (const timeframe of CONFIG.TA.TIMEFRAMES) {
          try {
            const ohlcv = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, 100);
            const key = `${symbol}_${timeframe}`;
            this.ohlcvCache.set(key, {
              data: ohlcv,
              timestamp: Date.now(),
            });
          } catch (err) {
            // Rate limit handling
            await new Promise(r => setTimeout(r, 100));
          }
        }
      }
      console.log('✅ OHLCV poll cycle complete');
    }, 10000);
    console.log('✅ OHLCV polling active');
  }

  async fetchOHLCV(symbol, timeframe, limit = 100) {
    const key = `${symbol}_${timeframe}`;
    const cached = this.ohlcvCache.get(key);
    
    if (cached && Date.now() - cached.timestamp < 30000) {
      return cached.data;
    }

    try {
      console.log(`📊 Fetching OHLCV: ${symbol} ${timeframe}`);
      const data = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      this.ohlcvCache.set(key, { data, timestamp: Date.now() });
      return data;
    } catch (err) {
      logger.error(`Failed to fetch OHLCV for ${symbol}:`, err.message);
      console.error(`❌ OHLCV fetch failed for ${symbol}:`, err.message);
      return null;
    }
  }

  async getCurrentPrice(symbol) {
    // Try WebSocket first
    const wsKey = symbol.toLowerCase().replace('/', '');
    const wsData = this.priceCache.get(wsKey);
    if (wsData && Date.now() - wsData.timestamp < 5000) {
      return wsData.price;
    }

    // Fallback to REST
    try {
      console.log(`💰 Fetching current price for ${symbol} (REST fallback)`);
      const ticker = await this.exchange.fetchTicker(symbol);
      return ticker.last;
    } catch (err) {
      logger.error(`Failed to get price for ${symbol}:`, err.message);
      console.error(`❌ Price fetch failed for ${symbol}:`, err.message);
      return null;
    }
  }

  async get24hVolume(symbol) {
    try {
      const ticker = await this.exchange.fetchTicker(symbol);
      return ticker.quoteVolume; // USDT volume
    } catch (err) {
      return 0;
    }
  }

  async getFundingRate(symbol) {
    try {
      const markets = await this.exchange.fetchFundingRates([symbol]);
      return markets[symbol]?.fundingRate || 0;
    } catch (err) {
      return 0;
    }
  }

  async getOrderBook(symbol, limit = 20) {
    try {
      const book = await this.exchange.fetchOrderBook(symbol, limit);
      return {
        bids: book.bids.slice(0, 5),
        asks: book.asks.slice(0, 5),
        spread: (book.asks[0][0] - book.bids[0][0]) / book.bids[0][0],
      };
    } catch (err) {
      return null;
    }
  }

  async getTopVolumeSymbols(count = 10) {
    console.log(`🏆 Fetching top ${count} volume symbols...`);
    try {
      const tickers = await this.exchange.fetchTickers();
      const sorted = Object.values(tickers)
        .filter(t => t.symbol.endsWith(':USDT') && t.quoteVolume > CONFIG.DATA.MIN_VOLUME_USD)
        .sort((a, b) => b.quoteVolume - a.quoteVolume)
        .slice(0, count)
        .map(t => t.symbol);
      
      console.log(`✅ Top volumes: ${sorted.join(', ')}`);
      return sorted;
    } catch (err) {
      console.error('❌ Failed to fetch top volumes:', err.message);
      return ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'BNB/USDT:USDT', 'XRP/USDT:USDT'];
    }
  }
}

// ==========================================
// INSTITUTIONAL-GRADE TECHNICAL ANALYSIS
// ==========================================

class InstitutionalTA {
  constructor(marketData) {
    this.marketData = marketData;
    console.log('📐 InstitutionalTA initialized');
  }

  // EMA Calculation with proper smoothing
  calculateEMA(prices, period) {
    const k = 2 / (period + 1);
    const ema = [prices[0]];
    
    for (let i = 1; i < prices.length; i++) {
      ema.push(prices[i] * k + ema[i - 1] * (1 - k));
    }
    
    return ema;
  }

  // RSI with divergence detection
  calculateRSI(prices, period = 14) {
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
    
    const rsi = [100 - (100 / (1 + avgGain / avgLoss))];
    
    for (let i = period; i < changes.length; i++) {
      const change = changes[i];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;
      
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      
      rsi.push(100 - (100 / (1 + avgGain / avgLoss)));
    }
    
    return rsi;
  }

  // MACD with histogram analysis
  calculateMACD(prices, fast = 12, slow = 26, signal = 9) {
    const ema12 = this.calculateEMA(prices, fast);
    const ema26 = this.calculateEMA(prices, slow);
    
    const macdLine = [];
    const startIdx = ema26.length - ema12.length;
    
    for (let i = 0; i < ema12.length; i++) {
      macdLine.push(ema12[i] - ema26[i + startIdx]);
    }
    
    const signalLine = this.calculateEMA(macdLine, signal);
    const histogram = macdLine.slice(-signalLine.length).map((v, i) => v - signalLine[i]);
    
    return {
      macdLine: macdLine.slice(-20),
      signalLine,
      histogram,
      trend: histogram[histogram.length - 1] > histogram[histogram.length - 2] ? 'rising' : 'falling',
      crossover: macdLine[macdLine.length - 2] < signalLine[signalLine.length - 2] && 
                 macdLine[macdLine.length - 1] > signalLine[signalLine.length - 1] ? 'bullish' :
                 macdLine[macdLine.length - 2] > signalLine[signalLine.length - 2] && 
                 macdLine[macdLine.length - 1] < signalLine[signalLine.length - 1] ? 'bearish' : 'none',
    };
  }

  // Volume Profile Analysis
  analyzeVolume(ohlcv) {
    const volumes = ohlcv.map(c => c[5]);
    const closes = ohlcv.map(c => c[4]);
    
    const avgVolume = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
    const currentVolume = volumes[volumes.length - 1];
    const ratio = currentVolume / avgVolume;
    
    // On-Balance Volume (OBV)
    let obv = 0;
    for (let i = 1; i < ohlcv.length; i++) {
      if (closes[i] > closes[i - 1]) obv += volumes[i];
      else if (closes[i] < closes[i - 1]) obv -= volumes[i];
    }
    
    const obvTrend = obv > 0 ? 'positive' : 'negative';
    
    return {
      ratio,
      trend: ratio > CONFIG.TA.VOLUME_THRESHOLD ? 'breakout' : ratio > 1 ? 'above_avg' : 'normal',
      obvTrend,
      confirmation: (obvTrend === 'positive' && closes[closes.length - 1] > closes[closes.length - 5]) ||
                    (obvTrend === 'negative' && closes[closes.length - 1] < closes[closes.length - 5]),
    };
  }

  // Support/Resistance with touch validation
  findKeyLevels(ohlcv, touchesRequired = 2) {
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    const closes = ohlcv.map(c => c[4]);
    
    // Find swing highs and lows
    const swingHighs = [];
    const swingLows = [];
    
    for (let i = 2; i < ohlcv.length - 2; i++) {
      if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] && 
          highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
        swingHighs.push(highs[i]);
      }
      if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] && 
          lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
        swingLows.push(lows[i]);
      }
    }
    
    // Cluster levels
    const resistance = this.clusterLevels(swingHighs);
    const support = this.clusterLevels(swingLows);
    
    // Count touches
    const resistanceTouches = closes.filter(c => 
      resistance.some(r => Math.abs(c - r) / r < 0.005)
    ).length;
    
    const supportTouches = closes.filter(c => 
      support.some(s => Math.abs(c - s) / s < 0.005)
    ).length;
    
    return {
      resistance: resistance[0] || Math.max(...highs.slice(-20)),
      support: support[0] || Math.min(...lows.slice(-20)),
      resistanceTouches,
      supportTouches,
      valid: resistanceTouches >= touchesRequired || supportTouches >= touchesRequired,
      range: resistance[0] - support[0],
    };
  }

  clusterLevels(levels, threshold = 0.01) {
    if (levels.length === 0) return [];
    
    const clusters = [];
    let currentCluster = [levels[0]];
    
    for (let i = 1; i < levels.length; i++) {
      if (Math.abs(levels[i] - currentCluster[0]) / currentCluster[0] < threshold) {
        currentCluster.push(levels[i]);
      } else {
        clusters.push(currentCluster.reduce((a, b) => a + b, 0) / currentCluster.length);
        currentCluster = [levels[i]];
      }
    }
    
    clusters.push(currentCluster.reduce((a, b) => a + b, 0) / currentCluster.length);
    return clusters.sort((a, b) => b - a);
  }

  // Fibonacci retracements
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
    };
  }

  // Market Structure Analysis
  analyzeStructure(ohlcv) {
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    const closes = ohlcv.map(c => c[4]);
    
    const recentHighs = highs.slice(-20);
    const recentLows = lows.slice(-20);
    
    // Higher highs / higher lows = uptrend
    // Lower highs / lower lows = downtrend
    let hh = 0, hl = 0, lh = 0, ll = 0;
    
    for (let i = 1; i < recentHighs.length; i++) {
      if (recentHighs[i] > recentHighs[i - 1]) hh++;
      else lh++;
      
      if (recentLows[i] > recentLows[i - 1]) hl++;
      else ll++;
    }
    
    const trend = hh > lh && hl > ll ? 'bullish' : 
                  lh > hh && ll > hl ? 'bearish' : 'neutral';
    
    // Break of structure
    const lastHigh = Math.max(...recentHighs.slice(-5));
    const lastLow = Math.min(...recentLows.slice(-5));
    const prevHigh = Math.max(...recentHighs.slice(-10, -5));
    const prevLow = Math.min(...recentLows.slice(-10, -5));
    
    const bos = lastHigh > prevHigh ? 'bullish_break' :
                lastLow < prevLow ? 'bearish_break' : 'none';
    
    return { trend, bos, strength: Math.abs(hh - lh + hl - ll) / recentHighs.length };
  }

  // Divergence Detection
  detectDivergence(prices, rsi) {
    const priceLen = prices.length;
    const rsiLen = rsi.length;
    
    // Compare last 10 candles
    const p1 = prices[priceLen - 10], p2 = prices[priceLen - 1];
    const r1 = rsi[rsiLen - 10], r2 = rsi[rsiLen - 1];
    
    // Bullish divergence: lower price, higher RSI
    const bullish = p2 < p1 && r2 > r1 && r2 < 50;
    
    // Bearish divergence: higher price, lower RSI
    const bearish = p2 > p1 && r2 < r1 && r2 > 50;
    
    return { bullish, bearish, strength: Math.abs(r2 - r1) };
  }

  // Liquidity sweep detection
  detectLiquiditySweep(ohlcv, levels) {
    const lastCandle = ohlcv[ohlcv.length - 1];
    const prevCandle = ohlcv[ohlcv.length - 2];
    
    // Wick beyond level with close inside = sweep
    const bullishSweep = prevCandle[3] < levels.support && 
                         lastCandle[4] > levels.support &&
                         lastCandle[4] > lastCandle[1]; // Close > Open
    
    const bearishSweep = prevCandle[2] > levels.resistance && 
                         lastCandle[4] < levels.resistance &&
                         lastCandle[4] < lastCandle[1]; // Close < Open
    
    return {
      bullish: bullishSweep,
      bearish: bearishSweep,
      level: bullishSweep ? levels.support : bearishSweep ? levels.resistance : null,
    };
  }
}

// ==========================================
// CONFIDENCE SCORING ENGINE
// ==========================================

class ConfidenceEngine {
  calculate(analysis) {
    let score = 0;
    const details = [];
    const bonuses = [];

    // 1. Trend Alignment (25 pts)
    const { trend, higherTF } = analysis.multiTimeframe;
    
    if (trend.alignment && higherTF.alignment) {
      score += 25;
      details.push('✅ Perfect multi-TF trend alignment (+25)');
      if (trend.primary === 'bullish' && analysis.momentum.macd.trend === 'rising') {
        score += 15;
        bonuses.push('🚀 Bullish momentum bonus (+15)');
      }
    } else if (trend.primary !== 'neutral') {
      score += 15;
      details.push('⚠️ Single TF trend only (+15)');
    }

    // 2. Volume Confirmation (20 pts)
    const vol = analysis.volume;
    if (vol.ratio > 2.0) {
      score += 20;
      details.push('✅ Exceptional volume breakout (+20)');
    } else if (vol.ratio > CONFIG.TA.VOLUME_THRESHOLD) {
      score += 15;
      details.push('✅ Strong volume confirmation (+15)');
    } else if (vol.ratio > 1.0) {
      score += 10;
      details.push('⚠️ Above average volume (+10)');
    }

    if (vol.confirmation) {
      score += 10;
      bonuses.push('📈 OBV confirmation (+10)');
    }

    // 3. Momentum Confluence (20 pts)
    const mom = analysis.momentum;
    const rsiValid = mom.rsi > CONFIG.TA.RSI_OVERSOLD && mom.rsi < CONFIG.TA.RSI_OVERBOUGHT;
    const macdValid = Math.abs(mom.macd.histogram[mom.macd.histogram.length - 1]) > 0.001;
    
    if (rsiValid && macdValid && mom.divergence.bullish) {
      score += 20;
      details.push('✅ Perfect momentum confluence with divergence (+20)');
    } else if (rsiValid && macdValid) {
      score += 15;
      details.push('✅ Strong momentum alignment (+15)');
    } else if (rsiValid || macdValid) {
      score += 8;
      details.push('⚠️ Partial momentum (+8)');
    }

    // 4. S/R Quality (20 pts)
    const sr = analysis.levels;
    if (sr.valid && (sr.supportTouches >= 3 || sr.resistanceTouches >= 3)) {
      score += 20;
      details.push('✅ High-quality S/R with 3+ touches (+20)');
    } else if (sr.valid) {
      score += 15;
      details.push('✅ Valid S/R levels (+15)');
    } else if (sr.supportTouches >= 2 || sr.resistanceTouches >= 2) {
      score += 10;
      details.push('⚠️ Developing S/R (+10)');
    }

    // 5. R:R Ratio (15 pts)
    const rr = analysis.setup?.riskReward || 0;
    if (rr >= 3) {
      score += 15;
      details.push('✅ Exceptional R:R 1:3+ (+15)');
    } else if (rr >= 2.5) {
      score += 12;
      details.push('✅ Strong R:R 1:2.5 (+12)');
    } else if (rr >= 2.0) {
      score += 10;
      details.push('✅ Valid R:R 1:2 (+10)');
    }

    // Bonuses
    if (analysis.structure?.bos !== 'none' && analysis.structure?.strength > 0.6) {
      score += 5;
      bonuses.push('🏗️ Clean structure break (+5)');
    }

    // Session timing
    const hour = new Date().getUTCHours();
    if ((hour >= 0 && hour <= 8) || (hour >= 13 && hour <= 21)) {
      score += 5;
      bonuses.push('🌏 Active session (+5)');
    }

    const finalScore = Math.min(100, score);
    
    return {
      score: finalScore,
      tier: finalScore >= 90 ? 'Maximum' : 
            finalScore >= 85 ? 'High' : 
            finalScore >= 70 ? 'Standard' : 'Insufficient',
      details,
      bonuses,
      passed: finalScore >= CONFIG.RISK.MIN_CONFIDENCE,
    };
  }
}

// ==========================================
// SIGNAL STRATEGY DETECTOR
// ==========================================

class StrategyDetector {
  detect(analysis) {
    const { trend, momentum, volume, levels, structure, sweep } = analysis;
    
    // 1. Trend Pullback (Highest priority)
    if (trend.alignment && !structure.consolidation && volume.trend === 'normal') {
      const pullbackToEma = Math.abs(analysis.price - analysis.ema50) / analysis.price < 0.02;
      const fibLevels = analysis.fibonacci;
      const nearFib = fibLevels && (
        Math.abs(analysis.price - fibLevels[0.5]) / analysis.price < 0.01 ||
        Math.abs(analysis.price - fibLevels[0.618]) / analysis.price < 0.01
      );
      
      if (pullbackToEma || nearFib) {
        return {
          type: 'Trend Pullback',
          direction: trend.primary,
          quality: 'A+',
          entry: analysis.price,
          stop: trend.primary === 'bullish' ? levels.support * 0.995 : levels.resistance * 1.005,
          target: trend.primary === 'bullish' ? levels.resistance : levels.support,
          timeframe: '15M-1H',
        };
      }
    }
    
    // 2. Breakout Play
    if (structure.consolidation && volume.trend === 'breakout' && 
        levels.supportTouches >= 3 && momentum.macd.crossover !== 'none') {
      const direction = momentum.macd.crossover === 'bullish' ? 'bullish' : 'bearish';
      return {
        type: 'Breakout Play',
        direction,
        quality: 'A',
        entry: direction === 'bullish' ? levels.resistance * 1.005 : levels.support * 0.995,
        stop: levels.pivot,
        target: direction === 'bullish' ? levels.resistance * 1.05 : levels.support * 0.95,
        timeframe: '5M-15M',
      };
    }
    
    // 3. Liquidity Sweep
    if (sweep.bullish || sweep.bearish) {
      const direction = sweep.bullish ? 'bullish' : 'bearish';
      return {
        type: 'Liquidity Sweep',
        direction,
        quality: 'A',
        entry: analysis.price,
        stop: sweep.level * (direction === 'bullish' ? 0.995 : 1.005),
        target: direction === 'bullish' ? levels.resistance : levels.support,
        timeframe: '5M',
      };
    }
    
    // 4. Momentum Scalp (Lowest priority, requires exceptional conditions)
    if (volume.ratio > 3 && Math.abs(momentum.macd.histogram.slice(-1)[0]) > 0.01 &&
        momentum.rsi > 50 && momentum.rsi < 70) {
      return {
        type: 'Momentum Scalp',
        direction: momentum.macd.trend === 'rising' ? 'bullish' : 'bearish',
        quality: 'B+',
        entry: analysis.price,
        stop: analysis.price * 0.985,
        target: analysis.price * 1.02,
        timeframe: '1M-5M',
      };
    }
    
    return null;
  }
}

// ==========================================
// REAL-TIME SIGNAL GENERATOR
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
    
    console.log('🎯 RealTimeSignalGenerator initialized');
  }

  async analyzeSymbol(symbol) {
    console.log(`🔍 Analyzing ${symbol}...`);
    try {
      // Fetch multi-timeframe data
      console.log(`📊 Fetching multi-timeframe data for ${symbol}...`);
      const [m5, m15, h1, h4] = await Promise.all([
        this.marketData.fetchOHLCV(symbol, '5m', 100),
        this.marketData.fetchOHLCV(symbol, '15m', 100),
        this.marketData.fetchOHLCV(symbol, '1h', 100),
        this.marketData.fetchOHLCV(symbol, '4h', 50),
      ]);

      if (!m5 || !m15 || !h1 || !h4) {
        console.log(`⚠️ Insufficient data for ${symbol}`);
        return null;
      }
      console.log(`✅ Data fetched for ${symbol}`);

      const currentPrice = await this.marketData.getCurrentPrice(symbol);
      if (!currentPrice) {
        console.log(`⚠️ Could not get current price for ${symbol}`);
        return null;
      }
      console.log(`💰 Current price for ${symbol}: $${currentPrice}`);

      // Volume check
      const volume24h = await this.marketData.get24hVolume(symbol);
      if (volume24h < CONFIG.DATA.MIN_VOLUME_USD) {
        console.log(`⚠️ Insufficient volume for ${symbol}: $${volume24h}`);
        return null; // Insufficient liquidity
      }
      console.log(`📈 Volume OK for ${symbol}: $${volume24h}`);

      // Technical Analysis on each timeframe
      console.log(`📐 Running technical analysis on ${symbol}...`);
      const analysis5m = this.runAnalysis(m5);
      const analysis15m = this.runAnalysis(m15);
      const analysis1h = this.runAnalysis(h1);
      const analysis4h = this.runAnalysis(h4);

      // Multi-timeframe confluence
      const multiTimeframe = {
        primary: analysis15m.trend,
        higherTF: analysis1h.trend,
        alignment: analysis15m.trend.primary === analysis1h.trend.primary && 
                   analysis1h.trend.primary !== 'neutral',
      };

      // Use 15m as primary, 1h as confirmation
      const primary = analysis15m;
      const higherTF = analysis1h;

      // Detect strategy
      const setup = this.strategy.detect({
        ...primary,
        multiTimeframe,
        price: currentPrice,
        ema50: primary.ema50,
        fibonacci: primary.fibonacci,
      });

      if (!setup) {
        console.log(`⚠️ No strategy detected for ${symbol}`);
        return null;
      }
      console.log(`🎯 Strategy detected for ${symbol}: ${setup.type} ${setup.direction}`);

      // Calculate R:R
      const risk = Math.abs(setup.entry - setup.stop);
      const reward = Math.abs(setup.target - setup.entry);
      const riskReward = reward / risk;

      if (riskReward < CONFIG.RISK.MIN_RR) {
        console.log(`⚠️ R:R too low for ${symbol}: ${riskReward.toFixed(2)}`);
        return null;
      }
      console.log(`✅ R:R acceptable: ${riskReward.toFixed(2)}`);

      // Full analysis object
      const fullAnalysis = {
        symbol,
        price: currentPrice,
        multiTimeframe,
        momentum: primary.momentum,
        volume: primary.volume,
        levels: primary.levels,
        structure: primary.structure,
        sweep: primary.sweep,
        setup: { ...setup, riskReward },
      };

      // Confidence scoring
      console.log(`🎲 Calculating confidence score for ${symbol}...`);
      const confidence = this.confidence.calculate(fullAnalysis);
      console.log(`📊 Confidence for ${symbol}: ${confidence.score}% (${confidence.tier})`);
      
      return {
        ...fullAnalysis,
        confidence,
        timestamp: Date.now(),
      };

    } catch (err) {
      logger.error(`Analysis failed for ${symbol}:`, err.message);
      console.error(`❌ Analysis failed for ${symbol}:`, err.message);
      return null;
    }
  }

  runAnalysis(ohlcv) {
    const closes = ohlcv.map(c => c[4]);
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);

    // EMAs
    const ema50 = this.ta.calculateEMA(closes, 50);
    const ema200 = this.ta.calculateEMA(closes, 200);

    const trend = {
      primary: ema50[ema50.length - 1] > ema200[ema200.length - 1] ? 'bullish' :
               ema50[ema50.length - 1] < ema200[ema200.length - 1] ? 'bearish' : 'neutral',
      alignment: null, // Set by multi-TF analysis
    };

    // RSI & MACD
    const rsi = this.ta.calculateRSI(closes);
    const macd = this.ta.calculateMACD(closes);

    // Volume
    const volume = this.ta.analyzeVolume(ohlcv);

    // Levels
    const levels = this.ta.findKeyLevels(ohlcv);

    // Structure
    const structure = this.ta.analyzeStructure(ohlcv);

    // Divergence
    const divergence = this.ta.detectDivergence(closes, rsi);

    // Sweep
    const sweep = this.ta.detectLiquiditySweep(ohlcv, levels);

    // Fibonacci
    const fibRange = {
      high: Math.max(...highs.slice(-30)),
      low: Math.min(...lows.slice(-30)),
    };
    const fibonacci = this.ta.calculateFibonacci(fibRange.high, fibRange.low);

    return {
      trend,
      ema50: ema50[ema50.length - 1],
      ema200: ema200[ema200.length - 1],
      momentum: {
        rsi: rsi[rsi.length - 1],
        macd,
        divergence,
      },
      volume,
      levels,
      structure,
      sweep,
      fibonacci,
    };
  }

  async generateSignal(symbol, force = false) {
    console.log(`🎯 Generating signal for ${symbol} (force=${force})...`);
    const analysis = await this.analyzeSymbol(symbol);
    
    if (!analysis) {
      console.log(`❌ No analysis available for ${symbol}`);
      return null;
    }
    if (!force && !analysis.confidence.passed) {
      console.log(`❌ Confidence too low for ${symbol}: ${analysis.confidence.score}%`);
      return null;
    }

    // Build complete signal
    console.log(`🏗️ Building signal for ${symbol}...`);
    const signal = this.buildSignal(analysis);
    
    // Log and emit
    await this.tradeLogger.log('SIGNAL_GENERATED', {
      symbol,
      direction: signal.direction,
      confidence: signal.confidence.score,
      strategy: signal.strategy,
    });

    this.emit('signal', signal);
    this.activeSignals.set(signal.id, signal);
    
    console.log(`✅ Signal generated: ${signal.id} for ${symbol}`);

    return signal;
  }

  buildSignal(analysis) {
    const { symbol, price, confidence, setup, multiTimeframe, momentum, volume, levels } = analysis;
    
    // Position sizing
    const currentCapital = CONFIG.CHALLENGE.CURRENT_CAPITAL;
    const riskPct = confidence.score >= 90 ? 5 : 
                    confidence.score >= 85 ? 4 : 
                    confidence.score >= 80 ? 3 : 2;
    
    const riskAmount = currentCapital * (riskPct / 100);
    const riskPrice = Math.abs(setup.entry - setup.stop);
    const positionSize = (riskAmount / riskPrice) * setup.entry;
    
    const leverage = confidence.score >= 90 ? 20 :
                     confidence.score >= 85 ? 15 :
                     confidence.score >= 80 ? 10 : 5;

    const margin = positionSize / leverage;

    // Challenge progress
    const progress = ((currentCapital - CONFIG.CHALLENGE.START_CAPITAL) / 
                     (CONFIG.CHALLENGE.TARGET - CONFIG.CHALLENGE.START_CAPITAL) * 100);

    return {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      validUntil: new Date(Date.now() + 4 * 3600000).toISOString(),
      
      symbol,
      direction: setup.direction === 'bullish' ? 'LONG' : 'SHORT',
      strategy: setup.type,
      quality: setup.quality,
      
      confidence: {
        score: confidence.score,
        tier: confidence.tier,
        details: confidence.details,
        bonuses: confidence.bonuses,
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
      
      riskReward: setup.riskReward.toFixed(2),
      
      position: {
        riskPct,
        riskAmount: riskAmount.toFixed(2),
        leverage,
        positionSize: positionSize.toFixed(2),
        margin: margin.toFixed(2),
        estProfit: (positionSize * (Math.abs(setup.target - setup.entry) / setup.entry)).toFixed(2),
        estLoss: riskAmount.toFixed(2),
      },

      analysis: {
        trend: multiTimeframe.primary.primary,
        trendAlignment: multiTimeframe.alignment,
        rsi: momentum.rsi.toFixed(1),
        macdDirection: momentum.macd.trend,
        macdCrossover: momentum.macd.crossover,
        volumeRatio: volume.ratio.toFixed(2),
        volumeTrend: volume.trend,
        support: levels.support.toFixed(4),
        resistance: levels.resistance.toFixed(4),
        supportTouches: levels.supportTouches,
        resistanceTouches: levels.resistanceTouches,
      },

      rationale: confidence.details,

      challenge: {
        startCapital: CONFIG.CHALLENGE.START_CAPITAL,
        currentCapital: currentCapital.toFixed(2),
        target: CONFIG.CHALLENGE.TARGET,
        progress: Math.max(0, Math.min(100, progress)).toFixed(1),
        daysLeft: CONFIG.CHALLENGE.DAYS,
      },

      execution: {
        step1: `Enter on ${setup.timeframe} confirmation with volume`,
        step2: `Invalidation: Close beyond $${setup.stop.toFixed(4)}`,
        step3: `Scale 50% at 1:1 R:R, move SL to breakeven`,
      },
    };
  }

  async startContinuousScanning() {
    if (this.isScanning) {
      console.log('⚠️ Scanning already active');
      return;
    }
    this.isScanning = true;
    console.log('🚀 Starting continuous market scanning...');

    const scanLoop = async () => {
      while (this.isScanning) {
        try {
          console.log('🔄 New scan cycle started...');
          // Get top volume pairs
          const symbols = await this.marketData.getTopVolumeSymbols(15);
          console.log(`📊 Scanning ${symbols.length} symbols...`);
          
          let signalsFound = 0;
          for (const symbol of symbols) {
            // Skip if already have active signal for this symbol
            const hasActive = Array.from(this.activeSignals.values())
              .some(s => s.symbol === symbol && Date.now() - new Date(s.timestamp).getTime() < 3600000);
            
            if (!hasActive) {
              const signal = await this.generateSignal(symbol);
              if (signal) {
                logger.info(`🎯 Signal generated: ${symbol} ${signal.direction} @ ${signal.confidence.score}%`);
                console.log(`🎯 SIGNAL: ${symbol} ${signal.direction} @ ${signal.confidence.score}% confidence`);
                signalsFound++;
                // Wait between signals to respect rate limits
                await new Promise(r => setTimeout(r, 2000));
              }
            } else {
              console.log(`⏭️ Skipping ${symbol} - active signal exists`);
            }
          }
          
          console.log(`✅ Scan cycle complete. Signals found: ${signalsFound}`);
          // Wait before next scan cycle
          await new Promise(r => setTimeout(r, 10000));
          
        } catch (err) {
          logger.error('Scan loop error:', err.message);
          console.error('❌ Scan loop error:', err.message);
          await new Promise(r => setTimeout(r, 30000));
        }
      }
    };

    scanLoop();
  }

  stopScanning() {
    console.log('⏹️ Stopping market scanning...');
    this.isScanning = false;
  }

  async monitorSignal(signalId) {
    const signal = this.activeSignals.get(signalId);
    if (!signal) {
      console.log(`⚠️ Cannot monitor unknown signal: ${signalId}`);
      return;
    }
    
    console.log(`👁️  Starting monitor for signal ${signalId} (${signal.symbol})`);

    const checkInterval = setInterval(async () => {
      try {
        const currentPrice = await this.marketData.getCurrentPrice(signal.symbol);
        console.log(`💰 Monitor check ${signal.symbol}: $${currentPrice} (SL: $${signal.stopLoss}, TP: $${signal.takeProfit})`);
        
        // Check stop loss
        if (signal.direction === 'LONG' && currentPrice <= signal.stopLoss) {
          console.log(`🛑 STOP LOSS hit for ${signal.symbol} @ $${currentPrice}`);
          this.emit('signal_closed', { signal, result: 'stop_loss', price: currentPrice });
          clearInterval(checkInterval);
          this.activeSignals.delete(signalId);
        }
        // Check take profit
        else if (signal.direction === 'LONG' && currentPrice >= signal.takeProfit) {
          console.log(`🎯 TAKE PROFIT hit for ${signal.symbol} @ $${currentPrice}`);
          this.emit('signal_closed', { signal, result: 'take_profit', price: currentPrice });
          clearInterval(checkInterval);
          this.a
