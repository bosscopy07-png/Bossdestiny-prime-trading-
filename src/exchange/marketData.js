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
import { normalizeSymbol, isValidSymbol, toWsFormat, filterPerpetualMarkets } from './symbols.js';

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

  /**
   * Initialize exchange connection and load markets
   */
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
      
      // Delay polling to let WS establish
      setTimeout(() => this.startOhlcvPolling(), 5000);
      
      this.isRunning = true;
      marketLogger.info('MarketDataEngine ready');
      
    } catch (err) {
      marketLogger.error({ err: err.message }, 'Initialization failed');
      throw err;
    }
  }

  /**
   * Create and configure CCXT exchange instance
   */
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

  /**
   * Load markets with retry logic
   */
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

  /**
   * Start Binance WebSocket feeds for major pairs
   * Uses Binance WS for price data regardless of primary exchange
   */
  startWebSocketFeeds() {
    // Top pairs by liquidity — dynamic would be better but WS needs stability
    const majorBases = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'MATIC'];
    const pairs = majorBases.map(b => `${b}USDT`.toLowerCase());
    
    marketLogger.info(`Starting WebSocket feeds for ${pairs.length} pairs`);

    for (const pair of pairs) {
      this._connectWebSocket(pair);
    }
  }

  /**
   * Connect single WebSocket with auto-reconnect
   */
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
        
        // Clear old connection
        this.wsConnections.delete(pair);
        
        // Schedule reconnect
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

  /**
   * Start background OHLCV polling
   */
  startOhlcvPolling() {
    marketLogger.info('Starting OHLCV polling...');

    const poll = async () => {
      if (!this.isRunning) {
        marketLogger.info('Polling stopped');
        return;
      }

      try {
        // Get subset of markets to poll
        const symbols = this.perpetualMarkets
          .filter(s => isValidSymbol(s, this.exchange))
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

  /**
   * Safe OHLCV fetch with comprehensive error handling
   */
  async safeFetchOHLCV(symbol, timeframe, limit = 100) {
    if (!symbol) {
      marketLogger.debug('No symbol provided for OHLCV');
      return null;
    }

    const validSymbol = normalizeSymbol(symbol, this.exchange);
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

  /**
   * Fetch OHLCV with cache
   */
  async fetchOHLCV(symbol, timeframe, limit = 100) {
    const normalized = normalizeSymbol(symbol, this.exchange) || symbol;
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
      marketLogger.error(`fetchOHLCV failed: ${err.message}`);
      return cached?.data || null;
    }
  }

  /**
   * Get current price — WebSocket first, REST fallback
   */
  async getCurrentPrice(symbol) {
    if (!symbol) return null;

    const normalized = normalizeSymbol(symbol, this.exchange) || symbol;
    const wsKey = toWsFormat(normalized);

    // Try WebSocket cache
    const wsData = this.priceCache.get(wsKey);
    if (wsData && Date.now() - wsData.timestamp < CONFIG.SCAN.PRICE_CACHE_TTL_MS) {
      return wsData.price;
    }

    // Fallback to REST
    try {
      if (!isValidSymbol(normalized, this.exchange)) {
        marketLogger.debug(`Invalid symbol for price: ${normalized}`);
        return null;
      }
      const ticker = await this.exchange.fetchTicker(normalized);
      return ticker?.last || null;
    } catch (err) {
      marketLogger.error(`Price fetch failed ${normalized}: ${err.message}`);
      return null;
    }
  }

  /**
   * Get 24h volume
   */
  async get24hVolume(symbol) {
    if (!symbol) return 0;
    
    const normalized = normalizeSymbol(symbol, this.exchange) || symbol;
    if (!isValidSymbol(normalized, this.exchange)) return 0;

    try {
      const ticker = await this.exchange.fetchTicker(normalized);
      return ticker?.quoteVolume || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get top volume symbols
   */
  async getTopVolumeSymbols(count = 20) {
    marketLogger.info(`Fetching top ${count} volume symbols...`);

    try {
      const tickers = await this.exchange.fetchTickers();
      
      const validTickers = Object.values(tickers)
        .filter(t => {
          const market = this.exchange.markets[t.symbol];
          if (!market) return false;
          if (market.active === false) return false;
          if (market.quote !== 'USDT' && market.settle !== 'USDT') return false;
          if (market.type !== 'swap' && market.type !== 'future') return false;
          return (t.quoteVolume || 0) > CONFIG.TA.MIN_VOLUME_USD;
        })
        .sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0))
        .slice(0, count);

      const symbols = validTickers.map(t => t.symbol);
      marketLogger.info(`Top volumes: ${symbols.slice(0, 5).join(', ')}...`);
      return symbols;

    } catch (err) {
      marketLogger.error(`Volume fetch failed: ${err.message}`);
      // Safe fallback
      return this.perpetualMarkets.slice(0, 10);
    }
  }

  /**
   * Get BTC trend analysis for market filter
   */
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

      // ATR for volatility
      const { calculateATR } = await import('../utils/math.js');
      const atr = calculateATR(h1, 14);

      let primary = 'neutral';
      let strength = 0;

      if (current > ema20Val && ema20Val > ema50Val) {
        primary = 'bullish';
        strength = ema200Val ? (current > ema200Val ? 80 : 60) : 60;
      } else if (current < ema20Val && ema20Val < ema50Val) {
        primary = 'bearish';
        strength = ema200Val ? (current < ema200Val ? 80 : 60) : 60;
      }

      const volatile = atr.percent > 3;

      return { primary, strength, volatile, atr: atr.percent };

    } catch (err) {
      marketLogger.error(`BTC trend error: ${err.message}`);
      return { primary: 'neutral', strength: 0, volatile: false };
    }
  }

  /**
   * Graceful shutdown
   */
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
}
