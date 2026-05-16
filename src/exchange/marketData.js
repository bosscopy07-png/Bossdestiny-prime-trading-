// ==========================================
// MARKET DATA ENGINE
// Handles all exchange interaction, caching, WebSocket feeds
// ==========================================

import ccxt from 'ccxt';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { CONFIG } from '../config/index.js';
import { marketLogger } from '../utils/logger.js';
import { sleep } from '../utils/time.js';
import { 
  normalizeSymbol as normalizeUtil, 
  isValidSymbol as isValidUtil,
  toWsFormat as toWsFormatUtil,
  filterPerpetualMarkets 
} from './symbols.js';

export class MarketDataEngine extends EventEmitter {
  constructor() {
    super();
    
    this.priceCache = new Map();
    this.ohlcvCache = new Map();
    this.wsConnections = new Map();
    this.isRunning = false;
    this.perpetualMarkets = [];
    this.lastUpdate = Date.now();
    this.exchange = null;
    this.pollingTimer = null;

    marketLogger.info('MarketDataEngine instantiated');
  }

  // ─── SYMBOL WRAPPERS (REQUIRED: exposed for SignalGenerator) ───

  normalizeSymbol(symbol) {
    return normalizeUtil(symbol, this.exchange);
  }

  isValidSymbol(symbol) {
    return isValidUtil(symbol, this.exchange);
  }

  toWsFormat(symbol) {
    return toWsFormatUtil(symbol);
  }

  // ─── INITIALIZATION ─────────────────────────────────────────────

  async initialize() {
    marketLogger.info('Initializing MarketDataEngine...');

    try {
      await this._initExchange();
      await this._loadMarketsWithRetry();
      this.perpetualMarkets = filterPerpetualMarkets(this.exchange);
      
      if (this.perpetualMarkets.length === 0) {
        throw new Error('No perpetual markets found');
      }

      this.startWebSocketFeeds();
      setTimeout(() => this.startOhlcvPolling(), 5000);
      
      this.isRunning = true;
      marketLogger.info('MarketDataEngine ready');
      
    } catch (err) {
      marketLogger.error({ err: err.message, stack: err.stack }, 'Initialization failed');
      throw err;
    }
  }

  async _initExchange() {
    const exchangeClass = ccxt[CONFIG.EXCHANGE.ID];
    if (!exchangeClass) {
      throw new Error(`Unsupported exchange: ${CONFIG.EXCHANGE.ID}`);
    }

    const options = {
      enableRateLimit: true,
      options: {
        defaultType: CONFIG.EXCHANGE.DEFAULT_TYPE,
        adjustForTimeDifference: true,
      },
    };

    if (CONFIG.EXCHANGE.API_KEY) {
      options.apiKey = CONFIG.EXCHANGE.API_KEY;
      options.secret = CONFIG.EXCHANGE.SECRET;
      if (CONFIG.EXCHANGE.PASSPHRASE) {
        options.password = CONFIG.EXCHANGE.PASSPHRASE;
      }
    }

    this.exchange = new exchangeClass(options);

    if (CONFIG.EXCHANGE.SANDBOX && this.exchange.setSandboxMode) {
      this.exchange.setSandboxMode(true);
      marketLogger.info('Sandbox mode enabled');
    }

    marketLogger.info(`Exchange initialized: ${CONFIG.EXCHANGE.ID}`);
  }

  async _loadMarketsWithRetry(maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        marketLogger.info(`Loading markets (attempt ${attempt}/${maxRetries})...`);
        await this.exchange.loadMarkets();
        const count = Object.keys(this.exchange.markets).length;
        marketLogger.info(`Loaded ${count} markets`);
        return;
      } catch (err) {
        marketLogger.warn(`Market load failed: ${err.message}`);
        if (attempt === maxRetries) throw err;
        await sleep(2000 * attempt);
      }
    }
  }

  // ─── WEBSOCKET FEEDS ────────────────────────────────────────────

  startWebSocketFeeds() {
    const majorBases = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'MATIC'];
    const pairs = majorBases.map(b => `${b}USDT`.toLowerCase());
    
    marketLogger.info(`Starting WebSocket feeds for ${pairs.length} pairs`);

    for (const pair of pairs) {
      this._connectWebSocket(pair);
    }
  }

  _connectWebSocket(pair) {
    const wsUrl = `${CONFIG.DATA.BINANCE_FUTURES_WS}/${pair}@kline_1m`;
    
    try {
      const ws = new WebSocket(wsUrl);
      let reconnectTimer = null;

      ws.on('open', () => {
        marketLogger.debug(`WS connected: ${pair}`);
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
        } catch {
          // Silent parse errors
        }
      });

      ws.on('error', (err) => {
        marketLogger.warn(`WS error ${pair}: ${err.message}`);
      });

      ws.on('close', () => {
        marketLogger.warn(`WS closed ${pair}, reconnecting in ${CONFIG.SCAN.WS_RECONNECT_DELAY_MS}ms`);
        
        this.wsConnections.delete(pair);
        
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          this._connectWebSocket(pair);
        }, CONFIG.SCAN.WS_RECONNECT_DELAY_MS);
      });

      this.wsConnections.set(pair, ws);
    } catch (err) {
      marketLogger.error(`Failed to connect WS ${pair}: ${err.message}`);
    }
  }

  // ─── OHLCV POLLING ──────────────────────────────────────────────

  startOhlcvPolling() {
    marketLogger.info('Starting OHLCV polling...');

    const poll = async () => {
      if (!this.isRunning) {
        marketLogger.info('Polling stopped');
        return;
      }

      try {
        const symbols = this.perpetualMarkets
          .filter(s => this.isValidSymbol(s))
          .slice(0, CONFIG.SCAN.SYMBOLS_PER_SCAN);

        if (symbols.length === 0) {
          this.pollingTimer = setTimeout(poll, CONFIG.SCAN.POLL_DELAY_MS);
          return;
        }

        let fetched = 0;
        for (const symbol of symbols) {
          if (!this.isRunning) break;

          for (const tf of ['15m', '1h']) {
            try {
              const data = await this.safeFetchOHLCV(symbol, tf, CONFIG.SCAN.OHLCV_LIMIT);
              if (data) {
                this.ohlcvCache.set(`${symbol}_${tf}`, {
                  data,
                  timestamp: Date.now(),
                });
                fetched++;
              }
              await sleep(CONFIG.SCAN.RATE_LIMIT_MS);
            } catch {
              // Continue to next
            }
          }
        }

        marketLogger.debug(`Polled ${fetched} OHLCV entries, cache: ${this.ohlcvCache.size}`);
        
      } catch (err) {
        marketLogger.error(`Polling error: ${err.message}`);
      }

      if (this.isRunning) {
        this.pollingTimer = setTimeout(poll, CONFIG.SCAN.POLL_DELAY_MS);
      }
    };

    setTimeout(poll, 10000);
  }

  async safeFetchOHLCV(symbol, timeframe, limit = 100) {
    if (!symbol) {
      marketLogger.debug('No symbol provided for OHLCV');
      return null;
    }

    const validSymbol = this.normalizeSymbol(symbol);
    if (!validSymbol) {
      marketLogger.debug(`Cannot normalize: ${symbol}`);
      return null;
    }

    try {
      const market = this.exchange.markets[validSymbol];
      if (!market) {
        marketLogger.debug(`Market not found: ${validSymbol}`);
        return null;
      }
      if (market.active === false) {
        marketLogger.debug(`Market inactive: ${validSymbol}`);
        return null;
      }

      const ohlcv = await this.exchange.fetchOHLCV(validSymbol, timeframe, undefined, limit);
      
      if (!Array.isArray(ohlcv) || ohlcv.length === 0) {
        marketLogger.debug(`Empty OHLCV: ${validSymbol} ${timeframe}`);
        return null;
      }

      return ohlcv;

    } catch (err) {
      if (err.message?.toLowerCase().includes('rate limit')) {
        marketLogger.debug(`Rate limit: ${validSymbol}`);
        await sleep(1000);
        return null;
      }
      if (!err.message?.includes('Invalid symbol')) {
        marketLogger.debug(`OHLCV error ${validSymbol}: ${err.message}`);
      }
      return null;
    }
  }

  async fetchOHLCV(symbol, timeframe, limit = 100) {
    const normalized = this.normalizeSymbol(symbol) || symbol;
    const key = `${normalized}_${timeframe}`;
    const cached = this.ohlcvCache.get(key);

    if (cached && Date.now() - cached.timestamp < CONFIG.SCAN.OHLCV_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const data = await this.safeFetchOHLCV(normalized, timeframe, limit);
      if (data?.length > 0) {
        this.ohlcvCache.set(key, { data, timestamp: Date.now() });
        return data;
      }
      return cached?.data || null;
    } catch (err) {
      marketLogger.error({ err: err.message, stack: err.stack }, 'fetchOHLCV failed');
      return cached?.data || null;
    }
  }

  // ─── PRICE & VOLUME ─────────────────────────────────────────────

  async getCurrentPrice(symbol) {
    if (!symbol) return null;

    const normalized = this.normalizeSymbol(symbol) || symbol;
    const wsKey = this.toWsFormat(normalized);

    const wsData = this.priceCache.get(wsKey);
    if (wsData && Date.now() - wsData.timestamp < CONFIG.SCAN.PRICE_CACHE_TTL_MS) {
      return wsData.price;
    }

    try {
      if (!this.isValidSymbol(normalized)) {
        marketLogger.debug(`Invalid symbol for price: ${normalized}`);
        return null;
      }
      const ticker = await this.exchange.fetchTicker(normalized);
      return ticker?.last || null;
    } catch (err) {
      marketLogger.error({ err: err.message }, `Price fetch failed ${normalized}`);
      return null;
    }
  }

  async get24hVolume(symbol) {
    if (!symbol) return 0;
    
    const normalized = this.normalizeSymbol(symbol) || symbol;
    if (!this.isValidSymbol(normalized)) return 0;

    try {
      const ticker = await this.exchange.fetchTicker(normalized);
      return ticker?.quoteVolume || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get top volume symbols with timeout protection
   */
  async getTopVolumeSymbols(count = 20) {
    marketLogger.info(`Fetching top ${count} volume symbols...`);

    try {
      const tickers = await this._fetchWithTimeout(
        () => this.exchange.fetchTickers(),
        15000,
        'fetchTickers'
      );
      
      marketLogger.info(`Fetched ${Object.keys(tickers).length} tickers`);

      const validTickers = Object.values(tickers)
        .filter(t => {
          const market = this.exchange.markets[t.symbol];
          if (!market) return false;
          if (market.active === false) return false;
          
          const isUSDT = market.quote === 'USDT' || 
                         market.settle === 'USDT' || 
                         market.symbol?.includes('USDT');
          
          const isPerp = market.type === 'swap' || 
                         market.type === 'future' ||
                         market.linear === true;
          
          return isUSDT && isPerp;
        })
        .sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0))
        .slice(0, count);

      const symbols = validTickers.map(t => t.symbol);
      
      if (symbols.length === 0) {
        marketLogger.warn('No symbols from tickers, using perpetualMarkets fallback');
        return this.perpetualMarkets.slice(0, count);
      }

      marketLogger.info(`Top volumes: ${symbols.slice(0, 10).join(', ')}`);
      return symbols;

    } catch (err) {
      marketLogger.error({ err: err.message, stack: err.stack }, 'Volume fetch failed');
      return this.perpetualMarkets.slice(0, count);
    }
  }

  // ─── BTC TREND ──────────────────────────────────────────────────

  async getBTCTrend() {
    const btcSymbols = this.perpetualMarkets.filter(s => s.includes('BTC/'));
    const btcSymbol = btcSymbols.find(s => s.includes('USDT')) || btcSymbols[0];
    
    if (!btcSymbol) {
      marketLogger.warn('No BTC market found for trend analysis');
      return { primary: 'neutral', strength: 0, volatile: false };
    }

    try {
      const h1 = await this.fetchOHLCV(btcSymbol, '1h', 100);
      const h4 = await this.fetchOHLCV(btcSymbol, '4h', 50);
      
      if (!h1 || h1.length < 50) {
        return { primary: 'neutral', strength: 0, volatile: false };
      }

      const closes = h1.map(c => c[4]);
      const { calculateEMA } = await import('../utils/math.js');
      
      const ema20 = calculateEMA(closes, 20);
      const ema50 = calculateEMA(closes, 50);
      const ema200 = calculateEMA(closes, 200);
      
      if (!ema20 || !ema50) {
        return { primary: 'neutral', strength: 0, volatile: false };
      }

      const current = closes[closes.length - 1];
      const ema20Val = ema20[ema20.length - 1];
      const ema50Val = ema50[ema50.length - 1];
      const ema200Val = ema200?.[ema200.length - 1];

      const { calculateATR } = await import('../utils/math.js');
      const atr = calculateATR(h1, 14);

      let primary = 'neutral';
      let strength = 0;

      if (current > ema20Val && ema20Val > ema50Val) {
        primary = 'bullish';
        strength = ema200Val ? (current > ema200Val ? 80 : 60) : 60;
      } else if (current < ema20Val && ema20Val < ema50Val) {
        // FIXED: was ema50Val > ema50Val (always false)
        primary = 'bearish';
        strength = ema200Val ? (current < ema200Val ? 80 : 60) : 60;
      }

      const volatile = atr.percent > 3;

      return { primary, strength, volatile, atr: atr.percent };

    } catch (err) {
      marketLogger.error({ err: err.message, stack: err.stack }, 'BTC trend error');
      return { primary: 'neutral', strength: 0, volatile: false };
    }
  }

  // ─── SHUTDOWN ───────────────────────────────────────────────────

  shutdown() {
    marketLogger.info('Shutting down MarketDataEngine...');
    this.isRunning = false;
    
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }

    for (const [pair, ws] of this.wsConnections) {
      try {
        ws.terminate();
      } catch {
        // Ignore
      }
    }
    this.wsConnections.clear();

    marketLogger.info('MarketDataEngine shut down');
  }

  // ─── TIMEOUT UTILITY ────────────────────────────────────────────

  /**
   * Wrap any promise with a timeout
   */
  async _fetchWithTimeout(promiseFn, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);

      promiseFn()
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(err => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
  }
    
