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
import chalk from 'chalk'; // Add chalk for colors: npm install chalk

config();

// ==========================================
// ENHANCED CONSOLE UTILITY
// ==========================================

class ConsoleLogger {
  constructor() {
    this.startTime = Date.now();
    this.stats = {
      signals: 0,
      errors: 0,
      apiCalls: 0,
      wsMessages: 0
    };
  }

  // Color-coded log levels with icons
  success(msg, data = null) { this.log('✅', 'green', 'SUCCESS', msg, data); }
  error(msg, err = null) { this.stats.errors++; this.log('❌', 'red', 'ERROR', msg, err); }
  warn(msg, data = null) { this.log('⚠️', 'yellow', 'WARN', msg, data); }
  info(msg, data = null) { this.log('ℹ️', 'blue', 'INFO', msg, data); }
  debug(msg, data = null) { this.log('🔍', 'gray', 'DEBUG', msg, data); }
  signal(msg, data = null) { this.stats.signals++; this.log('🎯', 'magenta', 'SIGNAL', msg, data); }
  trade(msg, data = null) { this.log('💰', 'cyan', 'TRADE', msg, data); }
  system(msg, data = null) { this.log('⚙️', 'white', 'SYSTEM', msg, data); }
  network(msg, data = null) { this.stats.apiCalls++; this.log('🌐', 'blue', 'NETWORK', msg, data); }
  ws(msg, data = null) { this.stats.wsMessages++; this.log('🔌', 'green', 'WS', msg, data); }
  ta(msg, data = null) { this.log('📊', 'yellow', 'TA', msg, data); }
  risk(msg, data = null) { this.log('🛡️', 'red', 'RISK', msg, data); }

  log(icon, color, level, msg, data) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const uptime = ((Date.now() - this.startTime) / 1000).toFixed(0);
    
    // Use chalk if available, fallback to plain text
    const colored = typeof chalk !== 'undefined' ? chalk[color] : (t) => t;
    
    console.log(
      colored(`[${timestamp}][${uptime}s][${level}]`),
      icon,
      msg,
      data ? '\n  └─>' + JSON.stringify(data, null, 2).replace(/\n/g, '\n  ') : ''
    );
  }

  // Visual separator for major sections
  section(title) {
    const line = '═'.repeat(60);
    console.log(`\n╔${line}╗`);
    console.log(`║${title.padStart(30 + title.length/2).padEnd(60)}║`);
    console.log(`╚${line}╝\n`);
  }

  // Progress bar for visual feedback
  progress(current, total, label = 'Progress') {
    const pct = Math.round((current / total) * 100);
    const filled = Math.round((pct / 100) * 20);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    process.stdout.write(`\r${label}: [${bar}] ${pct}% (${current}/${total})`);
    if (current === total) process.stdout.write('\n');
  }

  // Table output for structured data
  table(data, title = null) {
    if (title) console.log(`\n📋 ${title}:`);
    console.table(data);
  }

  // Real-time stats display
  showStats() {
    console.log('\n┌─────────────────────────────────────────┐');
    console.log('│           📈 RUNTIME STATISTICS         │');
    console.log('├─────────────────────────────────────────┤');
    console.log(`│ ⏱️  Uptime: ${((Date.now() - this.startTime) / 1000 / 60).toFixed(1)} minutes        │`);
    console.log(`│ 🎯 Signals Generated: ${this.stats.signals.toString().padStart(3)}             │`);
    console.log(`│ 🌐 API Calls: ${this.stats.apiCalls.toString().padStart(6)}                 │`);
    console.log(`│ 🔌 WS Messages: ${this.stats.wsMessages.toString().padStart(5)}                │`);
    console.log(`│ ❌ Errors: ${this.stats.errors.toString().padStart(9)}                    │`);
    console.log('└─────────────────────────────────────────┘\n');
  }

  // Clear screen with header
  clear() {
    console.clear();
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║           🚀 SIGNALALPHA TRADING BOT v2.0                  ║');
    console.log('║           Enhanced Console & Real-time Monitoring          ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
  }
}

const console = new ConsoleLogger();

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
  
  // Risk Management (BALANCED - from previous fix)
  RISK: {
    DAILY_LOSS_LIMIT_PCT: 5,
    WEEKLY_LOSS_LIMIT_PCT: 15,
    MAX_CONSECUTIVE_LOSSES: 3,
    MAX_SIGNALS_PER_DAY: 6,
    MIN_CONFIDENCE: 55, // Lowered from 70 for balanced approach
    MIN_RR: 1.5,        // Lowered from 2.0
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
    VOLUME_THRESHOLD: 1.3, // Lowered from 1.5
  },
  
  // Exchange Configuration
  EXCHANGE: {
    SANDBOX: process.env.SANDBOX === 'true',
    DEFAULT_TYPE: 'swap',
    ID: 'bitget', // Updated to working exchange
  },
  
  // Market Data
  DATA: {
    COINGECKO_API: 'https://api.coingecko.com/api/v3',
    BINANCE_FUTURES_WS: 'wss://fstream.binance.com/ws',
    UPDATE_INTERVAL_MS: 5000,
    MIN_VOLUME_USD: 5000000, // Lowered from 10M for more opportunities
  },
  
  // Referral
  REFERRAL: {
    LINK: 'https://bingxdao.com/invite/4UAWNP/',
    CODE: '4UAWNP',
  },
  
  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};

console.section('CONFIGURATION');
console.info('Environment loaded', { 
  exchange: CONFIG.EXCHANGE.ID,
  sandbox: CONFIG.EXCHANGE.SANDBOX,
  minConfidence: CONFIG.RISK.MIN_CONFIDENCE,
  minRR: CONFIG.RISK.MIN_RR
});
console.success(`Challenge: $${CONFIG.CHALLENGE.START_CAPITAL} → $${CONFIG.CHALLENGE.TARGET} in ${CONFIG.CHALLENGE.DAYS} days`);
console.info(`Admin IDs: ${CONFIG.ADMIN_IDS.length > 0 ? CONFIG.ADMIN_IDS.join(', ') : 'None set'}`);

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

console.success('Logger initialized');

// File logger for trade history
class TradeLogger {
  constructor(filename = 'trades.log') {
    this.filename = filename;
    this.tradeCount = 0;
    console.success(`TradeLogger initialized: ${filename}`);
  }

  async log(type, data) {
    this.tradeCount++;
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      ...data,
    };
    
    try {
      await fs.appendFile(this.filename, JSON.stringify(entry) + '\n');
      console.trade(`Logged #${this.tradeCount}: ${type}`, { symbol: data.symbol || 'system' });
    } catch (err) {
      console.error('Failed to log trade:', err.message);
    }
  }

  async getRecentTrades(hours = 24) {
    console.info(`Reading recent trades from last ${hours}h...`);
    try {
      const content = await fs.readFile(this.filename, 'utf8');
      const lines = content.trim().split('\n');
      const cutoff = Date.now() - (hours * 3600000);
      
      const trades = lines
        .map(line => JSON.parse(line))
        .filter(trade => new Date(trade.timestamp).getTime() > cutoff);
      
      console.success(`Found ${trades.length} trades in last ${hours}h`);
      return trades;
    } catch (err) {
      console.warn(`Could not read ${this.filename}: ${err.message}`);
      return [];
    }
  }
}

// ==========================================
// REAL-TIME MARKET DATA ENGINE (ENHANCED)
// ==========================================

class MarketDataEngine extends EventEmitter {
  constructor() {
    super();
    console.section('MARKET DATA ENGINE');
    
    this.exchange = null;
    this.priceCache = new Map();
    this.ohlcvCache = new Map();
    this.orderBookCache = new Map();
    this.fundingRates = new Map();
    this.wsConnections = new Map();
    this.isRunning = false;
    this.perpetualMarkets = [];
    this.retryAttempts = 0;
    this.maxRetries = 3;
    
    this.initializeExchange();
  }

  initializeExchange() {
    try {
      console.info('Initializing CCXT exchange...');
      this.exchange = new ccxt.bitget({
        enableRateLimit: true,
        options: { 
          defaultType: "swap",
          adjustForTimeDifference: true
        }
      });
      
      if (CONFIG.EXCHANGE.SANDBOX) {
        this.exchange.setSandboxMode(true);
        console.warn('Sandbox mode enabled - paper trading only');
      }
      
      console.success(`Exchange initialized: ${CONFIG.EXCHANGE.ID}`);
    } catch (err) {
      console.error('Failed to initialize exchange:', err.message);
      throw err;
    }
  }

  async initialize() {
    console.section('INITIALIZATION');
    try {
      console.network('Loading markets from exchange...');
      await this.exchange.loadMarkets();
      const marketCount = Object.keys(this.exchange.markets).length;
      console.success(`Loaded ${marketCount} markets`);

      // Filter USDT perpetual futures
      console.info('Filtering perpetual markets...');
      this.perpetualMarkets = Object.values(this.exchange.markets)
        .filter(m => m.type === 'swap' && m.quote === 'USDT' && m.active)
        .map(m => m.symbol);
      
      console.success(`Found ${this.perpetualMarkets.length} active perpetual markets`);
      console.table(
        this.perpetualMarkets.slice(0, 5).map((m, i) => ({ 
          Rank: i + 1, 
          Symbol: m,
          Type: 'Perpetual'
        })),
        'Top 5 Markets'
      );

      // Start WebSocket feeds
      this.startWebSocketFeeds();
      
      // Start polling for OHLCV
      this.startOhlcvPolling();
      
      this.isRunning = true;
      console.success('MarketDataEngine fully initialized and running');
      
    } catch (err) {
      console.error('MarketDataEngine initialization failed:', err.message);
      if (this.retryAttempts < this.maxRetries) {
        this.retryAttempts++;
        console.warn(`Retrying initialization (${this.retryAttempts}/${this.maxRetries})...`);
        await new Promise(r => setTimeout(r, 5000));
        return this.initialize();
      }
      throw err;
    }
  }

  startWebSocketFeeds() {
    const majorPairs = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'xrpusdt', 'dogeusdt'];
    console.section('WEBSOCKET CONNECTIONS');
    console.info(`Starting ${majorPairs.length} WebSocket connections...`);
    
    let connected = 0;
    
    for (const pair of majorPairs) {
      const wsUrl = `${CONFIG.DATA.BINANCE_FUTURES_WS}/${pair}@kline_1m`;
      
      const ws = new WebSocket(wsUrl);
      
      ws.on('open', () => {
        connected++;
        console.ws(`Connected: ${pair.toUpperCase()} (${connected}/${majorPairs.length})`);
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
          // Silent fail for parse errors
        }
      });
      
      ws.on('error', (err) => {
        console.error(`WebSocket error for ${pair}:`, err.message);
      });
      
      ws.on('close', (code, reason) => {
        console.warn(`WebSocket closed for ${pair}: ${code} ${reason || ''}`);
        setTimeout(() => {
          console.info(`Reconnecting ${pair}...`);
          this.startWebSocketFeeds();
        }, 5000);
      });
      
      this.wsConnections.set(pair, ws);
    }
  }

  startOhlcvPolling() {
    console.section('OHLCV POLLING');
    console.info('Starting OHLCV polling (10s interval)...');
    
    let pollCount = 0;
    
    setInterval(async () => {
      pollCount++;
      const symbolsToPoll = this.perpetualMarkets.slice(0, 20);
      
      if (pollCount % 6 === 0) { // Log every minute
        console.info(`Poll cycle #${pollCount}, scanning ${symbolsToPoll.length} symbols...`);
      }
      
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
            if (err.message.includes('rate limit')) {
              console.warn('Rate limit hit, backing off...');
              await new Promise(r => setTimeout(r, 2000));
            }
          }
        }
      }
    }, 10000);
  }

  async fetchOHLCV(symbol, timeframe, limit = 100) {
    const key = `${symbol}_${timeframe}`;
    const cached = this.ohlcvCache.get(key);
    
    if (cached && Date.now() - cached.timestamp < 30000) {
      return cached.data;
    }

    try {
      console.network(`Fetching OHLCV: ${symbol} ${timeframe}`);
      const data = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      this.ohlcvCache.set(key, { data, timestamp: Date.now() });
      return data;
    } catch (err) {
      console.error(`OHLCV fetch failed for ${symbol}:`, err.message);
      return null;
    }
  }

  async getCurrentPrice(symbol) {
    const wsKey = symbol.toLowerCase().replace('/', '');
    const wsData = this.priceCache.get(wsKey);
    
    if (wsData && Date.now() - wsData.timestamp < 5000) {
      return wsData.price;
    }

    try {
      console.network(`Fetching price via REST: ${symbol}`);
      const ticker = await this.exchange.fetchTicker(symbol);
      return ticker.last;
    } catch (err) {
      console.error(`Price fetch failed for ${symbol}:`, err.message);
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

  async getTopVolumeSymbols(count = 10) {
    console.network(`Fetching top ${count} volume symbols...`);
    try {
      const tickers = await this.exchange.fetchTickers();
      const sorted = Object.values(tickers)
        .filter(t => t.symbol && t.symbol.includes('USDT') && (t.quoteVolume || 0) > CONFIG.DATA.MIN_VOLUME_USD)
        .sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0))
        .slice(0, count)
        .map(t => t.symbol);
      
      console.success(`Top volumes: ${sorted.slice(0, 5).join(', ')}...`);
      return sorted;
    } catch (err) {
      console.error('Failed to fetch top volumes:', err.message);
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
    console.success('InstitutionalTA initialized');
  }

  calculateEMA(prices, period) {
    const k = 2 / (period + 1);
    const ema = [prices[0]];
    for (let i = 1; i < prices.length; i++) {
      ema.push(prices[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
  }

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

  analyzeVolume(ohlcv) {
    const volumes = ohlcv.map(c => c[5]);
    const closes = ohlcv.map(c => c[4]);
    const avgVolume = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
    const currentVolume = volumes[volumes.length - 1];
    const ratio = currentVolume / avgVolume;
    
    let obv = 0;
    for (let i = 1; i < ohlcv.length; i++) {
      if (closes[i] > closes[i - 1]) obv += volumes[i];
      else if (closes[i] < closes[i - 1]) obv -= volumes[i];
    }
    
    return {
      ratio,
      trend: ratio > CONFIG.TA.VOLUME_THRESHOLD ? 'breakout' : ratio > 1 ? 'above_avg' : 'normal',
      obvTrend: obv > 0 ? 'positive' : 'negative',
      confirmation: (obv > 0 && closes[closes.length - 1] > closes[closes.length - 5]) ||
                    (obv < 0 && closes[closes.length - 1] < closes[closes.length - 5]),
    };
  }

  findKeyLevels(ohlcv, touchesRequired = 2) {
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    const closes = ohlcv.map(c => c[4]);
    
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
    
    const resistance = this.clusterLevels(swingHighs);
    const support = this.clusterLevels(swingLows);
    
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

  analyzeStructure(ohlcv) {
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    const recentHighs = highs.slice(-20);
    const recentLows = lows.slice(-20);
    
    let hh = 0, hl = 0, lh = 0, ll = 0;
    for (let i = 1; i < recentHighs.length; i++) {
      if (recentHighs[i] > recentHighs[i - 1]) hh++;
      else lh++;
      if (recentLows[i] > recentLows[i - 1]) hl++;
      else ll++;
    }
    
    const trend = hh > lh && hl > ll ? 'bullish' : 
                  lh > hh && ll > hl ? 'bearish' : 'neutral';
    
    const lastHigh = Math.max(...recentHighs.slice(-5));
    const lastLow = Math.min(...recentLows.slice(-5));
    const prevHigh = Math.max(...recentHighs.slice(-10, -5));
    const prevLow = Math.min(...recentLows.slice(-10, -5));
    
    const bos = lastHigh > prevHigh ? 'bullish_break' :
                lastLow < prevLow ? 'bearish_break' : 'none';
    
    return { trend, bos, strength: Math.abs(hh - lh + hl - ll) / recentHighs.length };
  }

  detectDivergence(prices, rsi) {
    const priceLen = prices.length;
    const rsiLen = rsi.length;
    const p1 = prices[priceLen - 10], p2 = prices[priceLen - 1];
    const r1 = rsi[rsiLen - 10], r2 = rsi[rsiLen - 1];
    
    const bullish = p2 < p1 && r2 > r1 && r2 < 50;
    const bearish = p2 > p1 && r2 < r1 && r2 > 50;
    
    return { bullish, bearish, strength: Math.abs(r2 - r1) };
  }

  detectLiquiditySweep(ohlcv, levels) {
    const lastCandle = ohlcv[ohlcv.length - 1];
    const prevCandle = ohlcv[ohlcv.length - 2];
    
    const bullishSweep = prevCandle[3] < levels.support && 
                         lastCandle[4] > levels.support &&
                         lastCandle[4] > lastCandle[1];
    
    const bearishSweep = prevCandle[2] > levels.resistance && 
                         lastCandle[4] < levels.resistance &&
                         lastCandle[4] < lastCandle[1];

    const weakBullishSweep = (prevCandle[3] < levels.support || lastCandle[3] < levels.support) &&
                              lastCandle[4] > levels.support &&
                              lastCandle[4] < levels.support * 1.005 &&
                              lastCandle[4] > lastCandle[1];
    
    const weakBearishSweep = (prevCandle[2] > levels.resistance || lastCandle[2] > levels.resistance) &&
                              lastCandle[4] < levels.resistance &&
                              lastCandle[4] > levels.resistance * 0.995 &&
                              lastCandle[4] < lastCandle[1];

    return {
      bullish: bullishSweep,
      bearish: bearishSweep,
      weakBullish: weakBullishSweep,
      weakBearish: weakBearishSweep,
      level: bullishSweep || weakBullishSweep ? levels.support : 
             bearishSweep || weakBearishSweep ? levels.resistance : null,
      strength: bullishSweep || bearishSweep ? 'strong' : 
                weakBullishSweep || weakBearishSweep ? 'weak' : 'none',
    };
  }

  calculateATR(ohlcv, period = 14) {
    const tr = [];
    for (let i = 1; i < ohlcv.length; i++) {
      const high = ohlcv[i][2];
      const low = ohlcv[i][3];
      const prevClose = ohlcv[i - 1][4];
      
      const trueRange = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      tr.push(trueRange);
    }
    
    const atr = [];
    let sum = tr.slice(0, period).reduce((a, b) => a + b, 0);
    atr.push(sum / period);
    
    for (let i = period; i < tr.length; i++) {
      sum = sum - tr[i - period] + tr[i];
      atr.push(sum / period);
    }
    
    const currentATR = atr[atr.length - 1];
    const currentPrice = ohlcv[ohlcv.length - 1][4];
    
    return {
      atr: currentATR,
      atrPercent: (currentATR / currentPrice) * 100,
      volatility: currentATR > atr[atr.length - 2] ? 'increasing' : 'decreasing',
    };
  }

  detectOrderFlowImbalance(ohlcv) {
    const last5 = ohlcv.slice(-5);
    const buyingPressure = last5.filter(c => c[4] > c[1]).length;
    const sellingPressure = last5.filter(c => c[4] < c[1]).length;
    
    return {
      bias: buyingPressure > sellingPressure ? 'bullish' : 
            sellingPressure > buyingPressure ? 'bearish' : 'neutral',
      buyingPressure,
      sellingPressure,
      strength: Math.abs(buyingPressure - sellingPressure) / 5,
    };
  }

  checkConfluence(analyses) {
    const trends = analyses.map(a => a.trend.primary);
    const allBullish = trends.every(t => t === 'bullish');
    const allBearish = trends.every(t => t === 'bearish');
    const mixed = new Set(trends).size > 1;
    
    return {
      alignment: allBullish || allBearish,
      direction: allBullish ? 'bullish' : allBearish ? 'bearish' : 'mixed',
      strength: mixed ? 'weak' : 'strong',
      timeframesAligned: trends.filter(t => t === (allBullish ? 'bullish' : 'bearish')).length,
    };
  }

  calculateVolatilityAdjustedSize(atrPercent, baseRiskPct) {
    if (atrPercent > 5) return baseRiskPct * 0.5;
    if (atrPercent > 3) return baseRiskPct * 0.75;
    if (atrPercent < 1) return baseRiskPct * 1.25;
    return baseRiskPct;
  }

  detectMarketRegime(ohlcv) {
    const closes = ohlcv.map(c => c[4]);
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    
    const ema20 = this.calculateEMA(closes, 20);
    const ema50 = this.calculateEMA(closes, 50);
    
    const trending = Math.abs(ema20[ema20.length - 1] - ema50[ema50.length - 1]) / ema50[ema50.length - 1] > 0.02;
    
    const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const stdDev = Math.sqrt(closes.slice(-20).map(c => Math.pow(c - sma20, 2)).reduce((a, b) => a + b, 0) / 20);
    const upperBand = sma20 + (2 * stdDev);
    const lowerBand = sma20 - (2 * stdDev);
    const currentPrice = closes[closes.length - 1];
    
    const nearUpper = currentPrice > upperBand * 0.98;
    const nearLower = currentPrice < lowerBand * 1.02;
    
    return {
      regime: trending ? (ema20[ema20.length - 1] > ema50[ema50.length - 1] ? 'uptrend' : 'downtrend') : 'ranging',
      volatility: stdDev / sma20 > 0.03 ? 'high' : stdDev / sma20 > 0.015 ? 'normal' : 'low',
      nearResistance: nearUpper,
      nearSupport: nearLower,
      meanReversionOpportunity: nearUpper || nearLower,
    };
  }
}

// ==========================================
// BALANCED CONFIDENCE ENGINE
// ==========================================

class ConfidenceEngine {
  calculate(analysis) {
    let score = 0;
    const details = [];
    const bonuses = [];

    const { trend, higherTF } = analysis.multiTimeframe;
    
    if (trend.alignment && higherTF.alignment) {
      score += 22;
      details.push('✅ Strong trend alignment (+22)');
    } else if (trend.primary !== 'neutral' && higherTF.primary !== 'neutral') {
      score += 14;
      details.push('⚖️ Mixed timeframe signals (+14)');
    } else if (trend.primary !== 'neutral') {
      score += 10;
      details.push('⚠️ Single timeframe trend (+10)');
    } else {
      score += 4;
      details.push('❌ No clear trend (+4)');
    }

    const vol = analysis.volume;
    if (vol.ratio > 1.6) {
      score += 18;
      details.push('✅ Strong volume (+18)');
    } else if (vol.ratio > 1.2) {
      score += 12;
      details.push('⚖️ Moderate volume (+12)');
    } else if (vol.ratio > 0.8) {
      score += 6;
      details.push('⚠️ Weak volume (+6)');
    } else {
      score += 2;
      details.push('❌ Very low volume (+2)');
    }

    if (vol.confirmation || vol.ratio > 1.3) {
      score += 7;
      bonuses.push('📈 Volume flow (+7)');
    }

    const mom = analysis.momentum;
    const rsiStrong = mom.rsi > 40 && mom.rsi < 70;
    const rsiWeak = mom.rsi > 30 && mom.rsi < 80;
    const macdHist = mom.macd.histogram.slice(-2);
    const macdAvg = Math.abs(macdHist.reduce((a,b)=>a+b,0)/2);
    const macdStrong = macdAvg > 0.001;
    const macdWeak = macdAvg > 0.0003;
    
    if (rsiStrong && macdStrong) {
      score += 18;
      details.push('✅ Strong momentum (+18)');
    } else if ((rsiStrong && macdWeak) || (rsiWeak && macdStrong)) {
      score += 12;
      details.push('⚖️ Mixed momentum (+12)');
    } else if (rsiWeak || macdWeak) {
      score += 7;
      details.push('⚠️ Weak momentum (+7)');
    } else {
      score += 3;
      details.push('❌ Poor momentum (+3)');
    }

    if (mom.divergence.bullish || mom.divergence.bearish) {
      score += 5;
      bonuses.push('🔄 Divergence signal (+5)');
    }

    const sr = analysis.levels;
    if (sr.valid && (sr.supportTouches >= 2 || sr.resistanceTouches >= 2)) {
      score += 17;
      details.push('✅ Tested S/R levels (+17)');
    } else if (sr.valid || sr.supportTouches >= 1 || sr.resistanceTouches >= 1) {
      score += 11;
      details.push('⚖️ Basic S/R present (+11)');
    } else if (sr.nearSupport || sr.nearResistance) {
      score += 6;
      details.push('⚠️ Near S/R zone (+6)');
    } else {
      score += 2;
      details.push('❌ No clear S/R (+2)');
    }

    const rr = analysis.setup?.riskReward || 0;
    if (rr >= 2.2) {
      score += 14;
      details.push('✅ Good R:R (+14)');
    } else if (rr >= 1.6) {
      score += 10;
      details.push('⚖️ Acceptable R:R (+10)');
    } else if (rr >= 1.2) {
      score += 6;
      details.push('⚠️ Tight R:R (+6)');
    } else {
      score += 2;
      details.push('❌ Poor R:R (+2)');
    }

    if (analysis.structure?.bos !== 'none') {
      score += 4;
      bonuses.push('🏗️ Structure break (+4)');
    }

    if (analysis.structure?.strength > 0.5) {
      score += 3;
      bonuses.push('💪 Solid structure (+3)');
    }

    const hour = new Date().getUTCHours();
    const isActiveSession = (hour >= 7 && hour <= 11) || (hour >= 13 && hour <= 17) || (hour >= 0 && hour <= 3);
    if (isActiveSession) {
      score += 4;
      bonuses.push('🌏 Active hours (+4)');
    } else {
      score += 2;
      bonuses.push('🌏 Off-hours (+2)');
    }

    if (analysis.volatility?.atrPercent > 0.3) {
      score += 3;
      bonuses.push('📊 Sufficient volatility (+3)');
    }

    const finalScore = Math.min(100, score);
    
    let tier, passed;
    if (finalScore >= 75) {
      tier = 'Strong';
      passed = true;
    } else if (finalScore >= 55) {
      tier = 'Moderate';
      passed = true;
    } else if (finalScore >= 40) {
      tier = 'Weak';
      passed = true;
    } else {
      tier = 'Insufficient';
      passed = false;
    }
    
    return {
      score: finalScore,
      tier,
      passed,
      confidence: finalScore >= 75 ? 'high' : finalScore >= 55 ? 'medium' : 'low',
      details,
      bonuses,
      recommendation: passed 
        ? (finalScore >= 75 ? 'Execute' : finalScore >= 55 ? 'Execute with caution' : 'High risk - reduce size')
        : 'No trade',
    };
  }
}

// ==========================================
// BALANCED STRATEGY DETECTOR
// ==========================================

class StrategyDetector {
  detect(analysis) {
    const { trend, momentum, volume, levels, structure, sweep } = analysis;
    
    if (trend.primary !== 'neutral' && !structure.consolidation && 
        (volume.trend === 'normal' || volume.trend === 'rising')) {
      
      const pullbackToEma50 = Math.abs(analysis.price - analysis.ema50) / analysis.price < 0.035;
      const pullbackToEma200 = analysis.ema200 && Math.abs(analysis.price - analysis.ema200) / analysis.price < 0.05;
      
      const fibLevels = analysis.fibonacci;
      const nearFib = fibLevels && (
        Math.abs(analysis.price - fibLevels[0.382]) / analysis.price < 0.015 ||
        Math.abs(analysis.price - fibLevels[0.5]) / analysis.price < 0.015 ||
        Math.abs(analysis.price - fibLevels[0.618]) / analysis.price < 0.015 ||
        Math.abs(analysis.price - fibLevels[0.786]) / analysis.price < 0.015
      );
      
      if (pullbackToEma50 || pullbackToEma200 || nearFib) {
        const quality = trend.alignment ? 'A' : 'B+';
        return {
          type: 'Trend Pullback',
          direction: trend.primary,
          quality,
          entry: analysis.price,
          stop: trend.primary === 'bullish' ? levels.support * 0.992 : levels.resistance * 1.008,
          target: trend.primary === 'bullish' ? levels.resistance : levels.support,
          timeframe: trend.alignment ? '15M-1H' : '5M-15M',
          note: trend.alignment ? 'Aligned trend' : 'Single TF - manage risk',
          confidence: trend.alignment ? 'high' : 'medium'
        };
      }
    }
    
    if ((structure.consolidation || structure.rangeBound) && 
        (volume.trend === 'breakout' || volume.ratio > 1.4) &&
        (levels.supportTouches >= 2 || levels.resistanceTouches >= 2) &&
        (momentum.macd.crossover !== 'none' || momentum.macd.trendChange)) {
      
      const direction = momentum.macd.crossover === 'bearish' || momentum.macd.trend === 'falling' 
        ? 'bearish' 
        : 'bullish';
      
      const isClean = volume.ratio > 2 && levels.supportTouches >= 3;
      
      return {
        type: 'Breakout Play',
        direction,
        quality: isClean ? 'A' : 'B+',
        entry: direction === 'bullish' ? levels.resistance * 1.002 : levels.support * 0.998,
        stop: levels.pivot || (direction === 'bullish' ? levels.support * 0.995 : levels.resistance * 1.005),
        target: direction === 'bullish' 
          ? (levels.resistance * 1.04 || analysis.price * 1.03)
          : (levels.support * 0.96 || analysis.price * 0.97),
        timeframe: '5M-15M',
        note: isClean ? 'Clean breakout' : 'Moderate breakout - watch volume',
        confidence: isClean ? 'high' : 'medium'
      };
    }
    
    if (sweep.bullish || sweep.bearish || sweep.weakBullish || sweep.weakBearish) {
      const direction = (sweep.bullish || sweep.weakBullish) ? 'bullish' : 'bearish';
      const isWeak = sweep.weakBullish || sweep.weakBearish;
      
      return {
        type: 'Liquidity Sweep',
        direction,
        quality: isWeak ? 'B' : 'A',
        entry: analysis.price,
        stop: sweep.level * (direction === 'bullish' ? 0.988 : 1.012),
        target: direction === 'bullish' ? levels.resistance : levels.support,
        timeframe: '5M',
        note: isWeak ? 'Weak sweep - quick target' : 'Clean sweep',
        confidence: isWeak ? 'medium' : 'high',
        timeLimit: isWeak ? '5-10 bars' : '10-20 bars'
      };
    }
    
    if (volume.ratio > 2.2 && 
        Math.abs(momentum.macd.histogram.slice(-3).reduce((a,b)=>a+b,0)/3) > 0.006 &&
        momentum.rsi > 35 && momentum.rsi < 75) {
      
      const isStrong = volume.ratio > 3 && momentum.rsi > 45 && momentum.rsi < 65;
      const direction = (momentum.macd.trend === 'rising' || momentum.rsi > 55) ? 'bullish' : 'bearish';
      
      return {
        type: 'Momentum Scalp',
        direction,
        quality: isStrong ? 'B+' : 'B',
        entry: analysis.price,
        stop: analysis.price * (direction === 'bullish' ? 0.982 : 1.018),
        target: analysis.price * (direction === 'bullish' ? 1.022 : 0.978),
        timeframe: '1M-5M',
        note: isStrong ? 'Strong momentum' : 'Quick scalp - tight management',
        confidence: isStrong ? 'medium' : 'low',
        maxHold: '10-15 bars'
      };
    }
    
    if (structure.rangeBound && !trend.alignment && 
        levels.support && levels.resistance && 
        volume.trend === 'normal') {
      
      const rangeSize = (levels.resistance - levels.support) / analysis.price;
      const nearResistance = Math.abs(analysis.price - levels.resistance) / analysis.price < 0.008;
      const nearSupport = Math.abs(analysis.price - levels.support) / analysis.price < 0.008;
      const midRange = Math.abs(analysis.price - (levels.support + levels.resistance)/2) / analysis.price < 0.01;
      
      if (rangeSize > 0.015 && !midRange) {
        if (nearResistance) {
          return {
            type: 'Range Short',
            direction: 'bearish',
            quality: 'B',
            entry: analysis.price,
            stop: levels.resistance * 1.008,
            target: (levels.support + levels.resistance) / 2,
            timeframe: '5M-15M',
            note: 'Mean reversion - take profit at mid-range',
            confidence: 'medium',
            invalidation: 'Break above resistance'
          };
        }
        if (nearSupport) {
          return {
            type: 'Range Long',
            direction: 'bullish',
            quality: 'B',
            entry: analysis.price,
            stop: levels.support * 0.992,
            target: (levels.support + levels.resistance) / 2,
            timeframe: '5M-15M',
            note: 'Mean reversion - take profit at mid-range',
            confidence: 'medium',
            invalidation: 'Break below support'
          };
        }
      }
    }
    
    if (analysis.structure?.bos !== 'none' && 
        trend.primary !== 'neutral' &&
        volume.ratio > 1.2) {
      
      const direction = analysis.structure.bos === 'bullish' ? 'bullish' : 'bearish';
      const isWithTrend = direction === trend.primary;
      
      return {
        type: 'Structure Continuation',
        direction,
        quality: isWithTrend ? 'B+' : 'B',
        entry: analysis.price,
        stop: analysis.structure.breakLevel * (direction === 'bullish' ? 0.995 : 1.005),
        target: direction === 'bullish' ? levels.resistance : levels.support,
        timeframe: '5M-15M',
        note: isWithTrend ? 'With trend BOS' : 'Counter-trend BOS - caution',
        confidence: isWithTrend ? 'medium' : 'low'
      };
    }
    
    return null;
  }
}

// ==========================================
// ENHANCED REAL-TIME SIGNAL GENERATOR
// ==========================================

class RealTimeSignalGenerator extends EventEmitter { constructor(marketData, ta, confidence, strategy) { super(); this.marketData = marketData; this.ta = ta; this.confidence = confidence; this.strategy = strategy; this.activeSignals = new Map(); this.tradeLogger = new TradeLogger(); this.isScanning = false; this.scanStats = { scanned: 0, signals: 0, errors: 0 };
console.success('RealTimeSignalGenerator initialized');
}
async analyzeSymbol(symbol) { console.info(Analyzing ${symbol}...); try { console.network(Fetching multi-timeframe data for ${symbol}...); const [m5, m15, h1, h4] = await Promise.all([ this.marketData.fetchOHLCV(symbol, ‘5m’, 100), this.marketData.fetchOHLCV(symbol, ‘15m’, 100), this.marketData.fetchOHLCV(symbol, ‘1h’, 100), this.marketData.fetchOHLCV(symbol, ‘4h’, 50), ]);
  if (!m5 || !m15 || !h1 || !h4) {
    console.warn(`Insufficient data for ${symbol}`);
    return null;
  }

  const currentPrice = await this.marketData.getCurrentPrice(symbol);
  if (!currentPrice) {
    console.warn(`Could not get current price for ${symbol}`);
    return null;
  }
  console.success(`Current price for ${symbol}: $${currentPrice.toFixed(4)}`);

  // Volume check
  const volume24h = await this.marketData.get24hVolume(symbol);
  if (volume24h < CONFIG.DATA.MIN_VOLUME_USD) {
    console.warn(`Insufficient volume for ${symbol}: $${volume24h.toLocaleString()}`);
    return null;
  }

  // Technical Analysis
  console.ta(`Running technical analysis on ${symbol}...`);
  const analysis5m = this.runAnalysis(m5);
  const analysis15m = this.runAnalysis(m15);
  const analysis1h = this.runAnalysis(h1);
  const analysis4h = this.runAnalysis(h4);

  const multiTimeframe = {
    primary: analysis15m.trend,
    higherTF: analysis1h.trend,
    alignment: analysis15m.trend.primary === analysis1h.trend.primary && 
               analysis1h.trend.primary !== 'neutral',
  };

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
    console.debug(`No strategy detected for ${symbol}`);
    return null;
  }
  console.signal(`Strategy detected: ${setup.type} ${setup.direction} [${setup.quality}]`);

  // Calculate R:R
  const risk = Math.abs(setup.entry - setup.stop);
  const reward = Math.abs(setup.target - setup.entry);
  const riskReward = reward / risk;

  if (riskReward < CONFIG.RISK.MIN_RR) {
    console.warn(`R:R too low for ${symbol}: ${riskReward.toFixed(2)} (min: ${CONFIG.RISK.MIN_RR})`);
    return null;
  }
  console.success(`R:R acceptable: ${riskReward.toFixed(2)}`);

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
  console.info(`Calculating confidence score for ${symbol}...`);
  const confidence = this.confidence.calculate(fullAnalysis);
  
  console.table({
    Symbol: symbol,
    Score: confidence.score + '%',
    Tier: confidence.tier,
    Passed: confidence.passed ? '✅' : '❌',
    Recommendation: confidence.recommendation
  }, 'Confidence Result');

  return {
    ...fullAnalysis,
    confidence,
    timestamp: Date.now(),
  };

} catch (err) {
  this.scanStats.errors++;
  console.error(`Analysis failed for ${symbol}:`, err.message);
  return null;
}
}
runAnalysis(ohlcv) { const closes = ohlcv.map(c => c[4]); const highs = ohlcv.map(c => c[2]); const lows = ohlcv.map(c => c[3]);
const ema50 = this.ta.calculateEMA(closes, 50);
const ema200 = this.ta.calculateEMA(closes, 200);

const trend = {
  primary: ema50[ema50.length - 1] > ema200[ema200.length - 1] ? 'bullish' :
           ema50[ema50.length - 1] < ema200[ema200.length - 1] ? 'bearish' : 'neutral',
  alignment: null,
};

const rsi = this.ta.calculateRSI(closes);
const macd = this.ta.calculateMACD(closes);
const volume = this.ta.analyzeVolume(ohlcv);
const levels = this.ta.findKeyLevels(ohlcv);
const structure = this.ta.analyzeStructure(ohlcv);
const divergence = this.ta.detectDivergence(closes, rsi);
const sweep = this.ta.detectLiquiditySweep(ohlcv, levels);

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
async generateSignal(symbol, force = false) { console.info(Generating signal for ${symbol} (force=${force})...); const analysis = await this.analyzeSymbol(symbol);
if (!analysis) {
  return null;
}
if (!force && !analysis.confidence.passed) {
  console.warn(`Confidence too low for ${symbol}: ${analysis.confidence.score}%`);
  return null;
}

console.success(`Building signal for ${symbol}...`);
const signal = this.buildSignal(analysis);

await this.tradeLogger.log('SIGNAL_GENERATED', {
  symbol,
  direction: signal.direction,
  confidence: signal.confidence.score,
  strategy: signal.strategy,
});

this.emit('signal', signal);
this.activeSignals.set(signal.id, signal);
this.scanStats.signals++;

console.signal(`Signal generated: ${signal.id} for ${signal.symbol} ${signal.direction} @ ${signal.confidence.score}%`);

return signal;
}
buildSignal(analysis) { const { symbol, price, confidence, setup, multiTimeframe, momentum, volume, levels } = analysis;
const currentCapital = CONFIG.CHALLENGE.CURRENT_CAPITAL;
const riskPct = confidence.score >= 90 ? 5 : 
                confidence.score >= 85 ? 4 : 
                confidence.score >= 80 ? 3 : 
                confidence.score >= 70 ? 2.5 : 2;

const riskAmount = currentCapital * (riskPct / 100);
const riskPrice = Math.abs(setup.entry - setup.stop);
const positionSize = (riskAmount / riskPrice) * setup.entry;

const leverage = confidence.score >= 90 ? 20 :
                 confidence.score >= 85 ? 15 :
                 confidence.score >= 80 ? 10 : 
                 confidence.score >= 70 ? 7 : 5;

const margin = positionSize / leverage;
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
async startContinuousScanning() { if (this.isScanning) { console.warn(‘Scanning already active’); return; } this.isScanning = true; console.section(‘CONTINUOUS SCANNING’); console.success(‘Starting market scanning…’);
const scanLoop = async () => {
  while (this.isScanning) {
    try {
      this.scanStats.scanned = 0;
      const symbols = await this.marketData.getTopVolumeSymbols(15);
      console.info(`New scan cycle: ${symbols.length} symbols`);
      
      let cycleSignals = 0;
      
      for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];
        this.scanStats.scanned++;
        
        if (i % 5 === 0) {
          console.progress(i + 1, symbols.length, 'Scanning');
        }
        
        const hasActive = Array.from(this.activeSignals.values())
          .some(s => s.symbol === symbol && Date.now() - new Date(s.timestamp).getTime() < 3600000);
        
        if (!hasActive) {
          const signal = await this.generateSignal(symbol);
          if (signal) {
            cycleSignals++;
            console.signal(`Signal #${cycleSignals}: ${symbol} ${signal.direction} @ ${signal.confidence.score}%`);
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }
      
      if (cycleSignals === 0) {
        console.info('No signals this cycle - markets consolidating');
      } else {
        console.success(`Cycle complete: ${cycleSignals} signals generated`);
      }
      
      await new Promise(r => setTimeout(r, 10000));
      
    } catch (err) {
      console.error('Scan loop error:', err.message);
      await new Promise(r => setTimeout(r, 30000));
    }
  }
};

scanLoop();
}
stopScanning() { console.info(‘Stopping market scanning…’); this.isScanning = false; console.table(this.scanStats, ‘Scan Statistics’); }
async monitorSignal(signalId) { const signal = this.activeSignals.get(signalId); if (!signal) { console.warn(Cannot monitor unknown signal: ${signalId}); return; }
console.info(`Starting monitor for ${signal.symbol} (SL: $${signal.stopLoss}, TP: $${signal.takeProfit})`);

const checkInterval = setInterval(async () => {
  try {
    const currentPrice = await this.marketData.getCurrentPrice(signal.symbol);
    
    let status = '';
    if (signal.direction === 'LONG') {
      if (currentPrice <= signal.stopLoss) status = 'STOP LOSS';
      else if (currentPrice >= signal.takeProfit) status = 'TAKE PROFIT';
    } else {
      if (currentPrice >= signal.stopLoss) status = 'STOP LOSS';
      else if (currentPrice <= signal.takeProfit) status = 'TAKE PROFIT';
    }

    if (status) {
      console.trade(`${status} hit for ${signal.symbol} @ $${currentPrice.toFixed(4)}`);
      this.emit('signal_closed', { signal, result: status.toLowerCase().replace(' ', '_'), price: currentPrice });
      clearInterval(checkInterval);
      this.activeSignals.delete(signalId);
    }
    
  } catch (err) {
    console.error(`Monitor error for ${signal.symbol}:`, err.message);
  }
}, 5000);

setTimeout(() => {
  console.info(`Signal ${signalId} expired (4h timeout)`);
  clearInterval(checkInterval);
  this.activeSignals.delete(signalId);
}, 4 * 3600000);
} }
