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
  
  // Exchange (BingX via CCXT)
  EXCHANGE: {
    ID: 'bingx',
    API_KEY: process.env.BINGX_API_KEY,
    API_SECRET: process.env.BINGX_API_SECRET,
    SANDBOX: process.env.SANDBOX === 'true',
    DEFAULT_TYPE: 'swap', // perpetual futures
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

// File logger for trade history
class TradeLogger {
  constructor(filename = 'trades.log') {
    this.filename = filename;
  }

  async log(type, data) {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      ...data,
    };
    
    try {
      await fs.appendFile(this.filename, JSON.stringify(entry) + '\n');
    } catch (err) {
      logger.error('Failed to log trade:', err);
    }
  }

  async getRecentTrades(hours = 24) {
    try {
      const content = await fs.readFile(this.filename, 'utf8');
      const lines = content.trim().split('\n');
      const cutoff = Date.now() - (hours * 3600000);
      
      return lines
        .map(line => JSON.parse(line))
        .filter(trade => new Date(trade.timestamp).getTime() > cutoff);
    } catch {
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
    this.exchange = new ccxt[CONFIG.EXCHANGE.ID]({
      apiKey: CONFIG.EXCHANGE.API_KEY,
      secret: CONFIG.EXCHANGE.API_SECRET,
      enableRateLimit: true,
      options: {
        defaultType: CONFIG.EXCHANGE.DEFAULT_TYPE,
        adjustForTimeDifference: true,
      },
    });
    
    if (CONFIG.EXCHANGE.SANDBOX) {
      this.exchange.setSandboxMode(true);
    }

    this.priceCache = new Map();
    this.ohlcvCache = new Map();
    this.orderBookCache = new Map();
    this.fundingRates = new Map();
    this.wsConnections = new Map();
    this.isRunning = false;
  }

  async initialize() {
    try {
      await this.exchange.loadMarkets();
      logger.info(`Loaded ${Object.keys(this.exchange.markets).length} markets`);
      
      // Filter USDT perpetual futures
      this.perpetualMarkets = Object.values(this.exchange.markets)
        .filter(m => m.type === 'swap' && m.quote === 'USDT' && m.active)
        .map(m => m.symbol);
      
      logger.info(`Found ${this.perpetualMarkets.length} active perpetual markets`);
      
      // Start WebSocket feeds for major pairs
      this.startWebSocketFeeds();
      
      // Start polling for OHLCV
      this.startOhlcvPolling();
      
      this.isRunning = true;
    } catch (err) {
      logger.error('Failed to initialize market data:', err);
      throw err;
    }
  }

  startWebSocketFeeds() {
    const majorPairs = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'xrpusdt', 'dogeusdt'];
    
    for (const pair of majorPairs) {
      const wsUrl = `${CONFIG.DATA.BINANCE_FUTURES_WS}/${pair}@kline_1m`;
      const ws = new WebSocket(wsUrl);
      
      ws.on('open', () => {
        logger.info(`WebSocket connected: ${pair}`);
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
      });
      
      ws.on('close', () => {
        logger.warn(`WebSocket closed for ${pair}, reconnecting...`);
        setTimeout(() => this.startWebSocketFeeds(), 5000);
      });
      
      this.wsConnections.set(pair, ws);
    }
  }

  startOhlcvPolling() {
    // Poll OHLCV every 10 seconds for active timeframes
    setInterval(async () => {
      for (const symbol of this.perpetualMarkets.slice(0, 20)) { // Top 20 by volume
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
    }, 10000);
  }

  async fetchOHLCV(symbol, timeframe, limit = 100) {
    const key = `${symbol}_${timeframe}`;
    const cached = this.ohlcvCache.get(key);
    
    if (cached && Date.now() - cached.timestamp < 30000) {
      return cached.data;
    }

    try {
      const data = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      this.ohlcvCache.set(key, { data, timestamp: Date.now() });
      return data;
    } catch (err) {
      logger.error(`Failed to fetch OHLCV for ${symbol}:`, err.message);
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
    try {
      const tickers = await this.exchange.fetchTickers();
      const sorted = Object.values(tickers)
        .filter(t => t.symbol.endsWith(':USDT') && t.quoteVolume > CONFIG.DATA.MIN_VOLUME_USD)
        .sort((a, b) => b.quoteVolume - a.quoteVolume)
        .slice(0, count)
        .map(t => t.symbol);
      
      return sorted;
    } catch (err) {
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
  }

  async analyzeSymbol(symbol) {
    try {
      // Fetch multi-timeframe data
      const [m5, m15, h1, h4] = await Promise.all([
        this.marketData.fetchOHLCV(symbol, '5m', 100),
        this.marketData.fetchOHLCV(symbol, '15m', 100),
        this.marketData.fetchOHLCV(symbol, '1h', 100),
        this.marketData.fetchOHLCV(symbol, '4h', 50),
      ]);

      if (!m5 || !m15 || !h1 || !h4) return null;

      const currentPrice = await this.marketData.getCurrentPrice(symbol);
      if (!currentPrice) return null;

      // Volume check
      const volume24h = await this.marketData.get24hVolume(symbol);
      if (volume24h < CONFIG.DATA.MIN_VOLUME_USD) {
        return null; // Insufficient liquidity
      }

      // Technical Analysis on each timeframe
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

      if (!setup) return null;

      // Calculate R:R
      const risk = Math.abs(setup.entry - setup.stop);
      const reward = Math.abs(setup.target - setup.entry);
      const riskReward = reward / risk;

      if (riskReward < CONFIG.RISK.MIN_RR) return null;

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
      const confidence = this.confidence.calculate(fullAnalysis);
      
      return {
        ...fullAnalysis,
        confidence,
        timestamp: Date.now(),
      };

    } catch (err) {
      logger.error(`Analysis failed for ${symbol}:`, err.message);
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
    const analysis = await this.analyzeSymbol(symbol);
    
    if (!analysis) return null;
    if (!force && !analysis.confidence.passed) return null;

    // Build complete signal
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
    if (this.isScanning) return;
    this.isScanning = true;

    logger.info('Starting real-time market scanning...');

    const scanLoop = async () => {
      while (this.isScanning) {
        try {
          // Get top volume pairs
          const symbols = await this.marketData.getTopVolumeSymbols(15);
          
          for (const symbol of symbols) {
            // Skip if already have active signal for this symbol
            const hasActive = Array.from(this.activeSignals.values())
              .some(s => s.symbol === symbol && Date.now() - new Date(s.timestamp).getTime() < 3600000);
            
            if (!hasActive) {
              const signal = await this.generateSignal(symbol);
              if (signal) {
                logger.info(`🎯 Signal generated: ${symbol} ${signal.direction} @ ${signal.confidence.score}%`);
                // Wait between signals to respect rate limits
                await new Promise(r => setTimeout(r, 2000));
              }
            }
          }
          
          // Wait before next scan cycle
          await new Promise(r => setTimeout(r, 10000));
          
        } catch (err) {
          logger.error('Scan loop error:', err.message);
          await new Promise(r => setTimeout(r, 30000));
        }
      }
    };

    scanLoop();
  }

  stopScanning() {
    this.isScanning = false;
  }

  async monitorSignal(signalId) {
    const signal = this.activeSignals.get(signalId);
    if (!signal) return;

    const checkInterval = setInterval(async () => {
      try {
        const currentPrice = await this.marketData.getCurrentPrice(signal.symbol);
        
        // Check stop loss
        if (signal.direction === 'LONG' && currentPrice <= signal.stopLoss) {
          this.emit('signal_closed', { signal, result: 'stop_loss', price: currentPrice });
          clearInterval(checkInterval);
          this.activeSignals.delete(signalId);
        }
        // Check take profit
        else if (signal.direction === 'LONG' && currentPrice >= signal.takeProfit) {
          this.emit('signal_closed', { signal, result: 'take_profit', price: currentPrice });
          clearInterval(checkInterval);
          this.activeSignals.delete(signalId);
        }
        // Short variants
        else if (signal.direction === 'SHORT' && currentPrice >= signal.stopLoss) {
          this.emit('signal_closed', { signal, result: 'stop_loss', price: currentPrice });
          clearInterval(checkInterval);
          this.activeSignals.delete(signalId);
        }
        else if (signal.direction === 'SHORT' && currentPrice <= signal.takeProfit) {
          this.emit('signal_closed', { signal, result: 'take_profit', price: currentPrice });
          clearInterval(checkInterval);
          this.activeSignals.delete(signalId);
        }
        
      } catch (err) {
        logger.error(`Monitor error for ${signal.symbol}:`, err.message);
      }
    }, 5000);

    // Auto-expire after 4 hours
    setTimeout(() => {
      clearInterval(checkInterval);
      this.activeSignals.delete(signalId);
    }, 4 * 3600000);
  }
}

// ==========================================
// TELEGRAM BOT INTERFACE
// ==========================================

class SignalAlphaTelegramBot {
  constructor() {
    this.bot = new Telegraf(CONFIG.BOT_TOKEN);
    this.marketData = new MarketDataEngine();
    this.ta = new InstitutionalTA();
    this.confidence = new ConfidenceEngine();
    this.strategy = new StrategyDetector();
    this.generator = new RealTimeSignalGenerator(this.marketData, this.ta, this.confidence, this.strategy);
    this.tradeLogger = new TradeLogger();
    
    this.userSettings = new Map();
    this.setupBot();
  }

  setupBot() {
    // Middleware
    this.bot.use(async (ctx, next) => {
      ctx.isAdmin = CONFIG.ADMIN_IDS.includes(String(ctx.from?.id));
      await next();
    });

    // Commands
    this.setupCommands();
    
    // Actions
    this.setupActions();
    
    // Signal listener
    this.generator.on('signal', (signal) => this.broadcastSignal(signal));
    this.generator.on('signal_closed', (data) => this.handleSignalClose(data));
  }

  setupCommands() {
    this.bot.command('start', async (ctx) => {
      const welcome = [
        '🎯 *SignalAlpha - Institutional Grade Signals*',
        '',
        'Real-time analysis for the $10 → $100 challenge.',
        '',
        '*Features:*',
        '• Multi-timeframe trend analysis',
        '• Dynamic confidence scoring (70-100%)',
        '• Live market data from BingX',
        '• Auto position sizing & risk management',
        '',
        '📊 Use /dashboard to view progress',
        '🎯 Use /signal to get latest setup',
        '',
        `🎁 [Trade on BingX](${CONFIG.REFERRAL.LINK}) | Code: \`${CONFIG.REFERRAL.CODE}\``
      ].join('\n');

      await ctx.reply(welcome, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Dashboard', 'DASHBOARD'), Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL')],
          [Markup.button.callback('📈 Live Scan', 'LIVE_SCAN'), Markup.button.callback('⚙️ Settings', 'SETTINGS')]
        ])
      });
    });

    this.bot.command('dashboard', async (ctx) => {
      await this.sendDashboard(ctx);
    });

    this.bot.command('signal', async (ctx) => {
      await ctx.reply('🔍 Scanning for A+ setups...', { parse_mode: 'Markdown' });
      
      const symbols = await this.marketData.getTopVolumeSymbols(5);
      let found = false;
      
      for (const symbol of symbols) {
        const signal = await this.generator.generateSignal(symbol);
        if (signal) {
          await this.sendSignal(ctx.chat.id, signal);
          found = true;
          break;
        }
      }
      
      if (!found) {
        await ctx.reply('❌ No A+ setups found. Markets are consolidating. Patience pays.', 
          Markup.inlineKeyboard([
            [Markup.button.callback('🔔 Enable Auto-Alerts', 'ENABLE_ALERTS')],
            [Markup.button.callback('📊 View Dashboard', 'DASHBOARD')]
          ])
        );
      }
    });

    this.bot.command('scan', async (ctx) => {
      if (!ctx.isAdmin) return ctx.reply('⛔ Admin only');
      
      await ctx.reply('🔍 Force scanning all markets...');
      await this.generator.startContinuousScanning();
      await ctx.reply('✅ Live scanning activated. Signals will appear automatically.');
    });

    this.bot.command('stop', async (ctx) => {
      if (!ctx.isAdmin) return ctx.reply('⛔ Admin only');
      this.generator.stopScanning();
      await ctx.reply('⏹️ Scanning stopped.');
    });

    this.bot.command('stats', async (ctx) => {
      const recent = await this.tradeLogger.getRecentTrades(24);
      const signals = recent.filter(r => r.type === 'SIGNAL_GENERATED');
      
      await ctx.reply([
        '📊 *24H Statistics*',
        '',
        `Signals Generated: ${signals.length}`,
        `Active Scans: ${this.generator.isScanning ? '✅ ON' : '❌ OFF'}`,
        `Markets Tracked: ${this.marketData.perpetualMarkets?.length || 0}`,
        '',
        `Challenge Day: ${CONFIG.CHALLENGE.DAYS}`,
        `Current Capital: $${CONFIG.CHALLENGE.CURRENT_CAPITAL}`,
        `Target: $${CONFIG.CHALLENGE.TARGET}`
      ].join('\n'), { parse_mode: 'Markdown' });
    });
  }

  setupActions() {
    this.bot.action('DASHBOARD', async (ctx) => {
      await ctx.answerCbQuery();
      await this.sendDashboard(ctx);
    });

    
    this.bot.action('GET_SIGNAL', async (ctx) => {
      await ctx.answerCbQuery('Analyzing...');
      await ctx.reply('🔍 Scanning top volume pairs for A+ setups...');
      
      const symbols = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'BNB/USDT:USDT', 'DOGE/USDT:USDT'];
      
      for (const symbol of symbols) {
        const signal = await this.generator.generateSignal(symbol);
        if (signal) {
          await this.sendSignal(ctx.chat.id, signal);
          return;
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      
      await ctx.reply('❌ No high-confidence setups found. Check back in 15 minutes.');
    });

    this.bot.action('LIVE_SCAN', async (ctx) => {
      await ctx.answerCbQuery();
      if (!ctx.isAdmin) {
        return ctx.reply('⛔ Auto-scanning is admin-controlled. Use /signal for manual scan.');
      }
      await this.generator.startContinuousScanning();
      await ctx.reply('🔥 Live scanning activated! A+ signals will appear automatically.');
    });

    this.bot.action('SETTINGS', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply('⚙️ *Settings*', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Min Confidence: 70%', 'SET_CONF_70')],
          [Markup.button.callback('Min Confidence: 80%', 'SET_CONF_80')],
          [Markup.button.callback('Min Confidence: 85%', 'SET_CONF_85')],
          [Markup.button.callback('🔙 Back', 'MAIN_MENU')]
        ])
      });
    });

    this.bot.action(/SET_CONF_(\d+)/, async (ctx) => {
      const conf = ctx.match[1];
      this.userSettings.set(ctx.from.id, { minConfidence: parseInt(conf) });
      await ctx.answerCbQuery(`Min confidence set to ${conf}%`);
      await ctx.reply(`✅ Minimum confidence threshold: ${conf}%`);
    });

    this.bot.action('MAIN_MENU', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.reply('🏠 *Main Menu*', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Dashboard', 'DASHBOARD'), Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL')],
          [Markup.button.callback('📈 Live Scan', 'LIVE_SCAN'), Markup.button.callback('⚙️ Settings', 'SETTINGS')]
        ])
      });
    });
  }

  async sendDashboard(ctx) {
    const progressBar = (pct) => '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    const current = CONFIG.CHALLENGE.CURRENT_CAPITAL;
    const progress = ((current - CONFIG.CHALLENGE.START_CAPITAL) / 
                     (CONFIG.CHALLENGE.TARGET - CONFIG.CHALLENGE.START_CAPITAL) * 100);

    const text = [
      '🎯 *SIGNALALPHA DASHBOARD*',
      '',
      `💰 Capital: $${current.toFixed(2)} / $${CONFIG.CHALLENGE.TARGET}`,
      `📈 Progress: ${Math.max(0, progress).toFixed(1)}% ${progressBar(progress)}`,
      `📅 Challenge: Day 1/${CONFIG.CHALLENGE.DAYS}`,
      '',
      '*System Status:*',
      `🔍 Live Scan: ${this.generator.isScanning ? '🟢 ACTIVE' : '⚪ IDLE'}`,
      `📊 Markets: ${this.marketData.perpetualMarkets?.length || 0} tracked`,
      `🎯 Signals Today: 0/${CONFIG.RISK.MAX_SIGNALS_PER_DAY}`,
      '',
      '*Risk Limits:*',
      `Daily Loss: ${CONFIG.RISK.DAILY_LOSS_LIMIT_PCT}% ($${(CONFIG.CHALLENGE.START_CAPITAL * CONFIG.RISK.DAILY_LOSS_LIMIT_PCT / 100).toFixed(2)})`,
      `Consecutive Losses: 0/${CONFIG.RISK.MAX_CONSECUTIVE_LOSSES}`,
      '',
      `🎁 [Trade on BingX](${CONFIG.REFERRAL.LINK})`
    ].join('\n');

    const buttons = ctx.isAdmin ? [
      [Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL'), Markup.button.callback('🔥 Start Live Scan', 'LIVE_SCAN')],
      [Markup.button.callback('⏹️ Stop Scan', 'STOP_SCAN'), Markup.button.callback('📊 Stats', 'STATS')],
      [Markup.button.callback('⚙️ Settings', 'SETTINGS')]
    ] : [
      [Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL'), Markup.button.callback('📊 Stats', 'STATS')],
      [Markup.button.callback('⚙️ Settings', 'SETTINGS')]
    ];

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard(buttons)
    });
  }

  async sendSignal(chatId, signal) {
    const text = [
      '╔══════════════════════════════════════════════════════════════╗',
      '║           🎯 SIGNALALPHA CRYPTO SIGNAL                       ║',
      '║              [$10 → $100 Challenge]                          ║',
      '╚══════════════════════════════════════════════════════════════╝',
      '',
      '📊 *MARKET SNAPSHOT*',
      `Asset: ${signal.symbol}`,
      `Timeframe: 15M / 1H / 4H`,
      `Generated: ${new Date(signal.timestamp).toISOString().replace('T', ' ').substr(0, 16)} UTC`,
      `Valid Until: ${new Date(signal.validUntil).toISOString().replace('T', ' ').substr(0, 16)} UTC`,
      '',
      '🎯 *TRADE DIRECTIVE*',
      `Direction: ${signal.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}`,
      `Confidence: ${signal.confidence.score}% (TIER: ${signal.confidence.tier})`,
      `Strategy: ${signal.strategy} [${signal.quality}]`,
      '',
      '💰 *ENTRY PARAMETERS*',
      `Entry Zone: $${signal.entry.zone.min.toFixed(4)} - $${signal.entry.zone.max.toFixed(4)}`,
      `Stop Loss: $${signal.stopLoss.toFixed(4)}`,
      `Take Profit: $${signal.takeProfit.toFixed(4)}`,
      `Risk/Reward: 1:${signal.riskReward}`,
      '',
      '⚙️ *POSITION DETAILS*',
      `Risk: ${signal.position.riskPct}% ($${signal.position.riskAmount})`,
      `Leverage: ${signal.position.leverage}x`,
      `Position Size: $${signal.position.positionSize}`,
      `Margin Required: $${signal.position.margin}`,
      `Est. Profit: $${signal.position.estProfit} | Est. Loss: $${signal.position.estLoss}`,
      '',
      '📈 *TECHNICAL RATIONALE*',
      `• Trend: ${signal.analysis.trend} (Aligned: ${signal.analysis.trendAlignment ? 'Yes' : 'No'})`,
      `• Momentum: RSI ${signal.analysis.rsi}, MACD ${signal.analysis.macdDirection}`,
      `• Volume: ${signal.analysis.volumeRatio}x average (${signal.analysis.volumeTrend})`,
      `• Support: $${signal.analysis.support} (${signal.analysis.supportTouches} touches)`,
      `• Resistance: $${signal.analysis.resistance} (${signal.analysis.resistanceTouches} touches)`,
      '',
      '🎯 *EXECUTION PLAN*',
      `1. ${signal.execution.step1}`,
      `2. ${signal.execution.step2}`,
      `3. ${signal.execution.step3}`,
      '',
      '📊 *CHALLENGE TRACKER*',
      `Start: $${signal.challenge.startCapital}`,
      `Current: $${signal.challenge.currentCapital} (${((current - 10) / 10 * 100).toFixed(1)}%)`,
      `Target: $${signal.challenge.target}`,
      `Progress: ${signal.challenge.progress}% ${'█'.repeat(Math.round(signal.challenge.progress / 10))}${'░'.repeat(10 - Math.round(signal.challenge.progress / 10))}`,
      `Days Left: ${signal.challenge.daysLeft}`,
      '',
      '═══════════════════════════════════════════════════════════════',
      `🔗 EXECUTE ON BINGX: ${CONFIG.REFERRAL.LINK}`,
      `🎁 REFERRAL CODE: ${CONFIG.REFERRAL.CODE}`,
      '═══════════════════════════════════════════════════════════════',
      '',
      '⚡ *Disclaimer:* Educational analysis only. Crypto trading carries substantial risk.'
    ].join('\n');

    await this.bot.telegram.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Signal Taken', `TAKEN_${signal.id}`), Markup.button.callback('❌ Skipped', `SKIPPED_${signal.id}`)],
        [Markup.button.callback('📊 Dashboard', 'DASHBOARD')]
      ])
    });

    // Start monitoring this signal
    this.generator.monitorSignal(signal.id);
  }

  async broadcastSignal(signal) {
    // Send to all admin users
    for (const adminId of CONFIG.ADMIN_IDS) {
      try {
        await this.sendSignal(adminId, signal);
      } catch (err) {
        logger.error(`Failed to send to admin ${adminId}:`, err.message);
      }
    }
  }

  async handleSignalClose(data) {
    const { signal, result, price } = data;
    logger.info(`Signal closed: ${signal.symbol} ${result} @ $${price}`);
    
    await this.tradeLogger.log('SIGNAL_CLOSED', {
      signalId: signal.id,
      symbol: signal.symbol,
      result,
      exitPrice: price,
      pnl: result === 'take_profit' ? signal.position.estProfit : -signal.position.estLoss,
    });
  }

  async start() {
    // Initialize market data
    await this.marketData.initialize();
    
    // Launch bot
    await this.bot.launch();
    logger.info('🚀 SignalAlpha Bot LIVE - Real-time scanning active');
    
    // Start continuous scanning if auto-start enabled
    if (process.env.AUTO_START_SCAN === 'true') {
      this.generator.startContinuousScanning();
    }
    
    // Graceful shutdown
    process.once('SIGINT', () => {
      this.generator.stopScanning();
      this.bot.stop('SIGINT');
    });
    process.once('SIGTERM', () => {
      this.generator.stopScanning();
      this.bot.stop('SIGTERM');
    });
  }
}

// ==========================================
// MAIN ENTRY
// ==========================================

async function main() {
  if (!CONFIG.BOT_TOKEN) {
    console.error('❌ BOT_TOKEN required in .env');
    process.exit(1);
  }

  const bot = new SignalAlphaTelegramBot();
  await bot.start();
}

main().catch(err => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
