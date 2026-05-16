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

  normalizeSymbol(symbol) {
    return normalizeUtil(symbol, this.exchange);
  }

  isValidSymbol(symbol) {
    return isValidUtil(symbol, this.exchange);
  }

  toWsFormat(symbol) {
    return toWsFormatUtil(symbol);
  }

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

  async _fetchWithTimeout(fn, ms = 10000, context = 'fetch') {
    return Promise.race([
      fn(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(`${context} timeout after ${ms}ms`)), ms)
      )
    ]);
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

      const ohlcv = await this._fetchWithTimeout(
        () => this.exchange.fetchOHLCV(validSymbol, timeframe, undefined, limit),
        10000,
        `fetchOHLCV ${validSymbol} ${timeframe}`
      );
      
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

    async getTopVolumeSymbols(count = 20) {
    marketLogger.info(`Fetching top ${count} volume symbols...`);

    // ─── FILTER CONFIGURATION ───────────────────────────────────
    const COMMODITY_BASES = ['XAG', 'XAU', 'GOLD', 'SILVER', 'OIL', 'NATGAS', 'GAS', 'COPPER', 'WHEAT', 'CORN', 'SOY'];
    
    const FOREX_BASES = ['EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'SGD', 'HKD', 'CNY', 'MXN', 'ZAR', 'TRY', 'SEK', 'NOK'];
    
    const STOCK_COIN_BASES = [
      'TSLA', 'AAPL', 'NVDA', 'AMZN', 'GOOGL', 'MSFT', 'META', 'NFLX', 'COIN', 'AMD', 'INTC', 'BABA', 
      'PLTR', 'DIS', 'BA', 'JPM', 'V', 'MA', 'WMT', 'T', 'KO', 'PEP', 'MCD', 'NKE', 'PYPL', 'UBER', 
      'LYFT', 'ZM', 'SNOW', 'CRM', 'ORCL', 'IBM', 'GE', 'F', 'GM', 'TSM', 'ASML', 'ARM', 'QCOM', 
      'AVGO', 'TXN', 'MU', 'LRCX', 'KLAC', 'SNPS', 'CDNS', 'ANSS', 'ADSK', 'PANW', 'CRWD', 'FTNT', 
      'CYBR', 'SPLK', 'DDOG', 'MDB', 'NET', 'FSLY', 'OKTA', 'DOCU', 'SQ', 'SHOP', 'SE', 'MELI', 
      'ABNB', 'DASH', 'U', 'RBLX', 'HOOD', 'SOFI', 'AFRM', 'UPST', 'LMND', 'ROOT', 'HCP', 'TOST', 
      'GTLB', 'ASAN', 'MNDY', 'SMAR', 'AI', 'PATH', 'BIG', 'CFLT'
    ];
    
    const INDEX_BASES = ['US500', 'US100', 'US30', 'DE40', 'UK100', 'JP225', 'HK50', 'AU200', 'EU50', 'FR40', 'ES35', 'IT40', 'CH20', 'CA60'];
    // ─────────────────────────────────────────────────────────────

    const isExcluded = (base, quote, symbol) => {
      // Commodities
      if (COMMODITY_BASES.includes(base)) return true;
      
      // Forex (fiat crosses)
      if (FOREX_BASES.includes(base) || FOREX_BASES.includes(quote)) return true;
      
      // Stock coins
      if (STOCK_COIN_BASES.includes(base)) return true;
      
      // Indices
      if (INDEX_BASES.includes(base)) return true;
      
      // Leveraged tokens
      if (/(3L|3S|5L|5S|UP|DOWN)$/.test(base)) return true;
      
      return false;
    };

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
          
          const base = market.base || '';
          const quote = market.quote || '';
          
          if (isExcluded(base, quote, market.symbol)) return false;
          
          const isUSDT = market.settle === 'USDT' || quote === 'USDT';
          const isPerp = market.type === 'swap' || (market.type === 'future' && !market.expiry);
          const isLinear = market.linear !== false;
          
          const volume = t.quoteVolume || t.baseVolume * t.last || 0;
          
          return isUSDT && isPerp && isLinear && volume > CONFIG.TA.MIN_VOLUME_USD;
        })
        .sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0))
        .slice(0, count);

      const symbols = validTickers.map(t => t.symbol);
      
      if (symbols.length === 0) {
        marketLogger.warn('No symbols passed filter, using fallback');
        return this._getFilteredFallback(count, isExcluded);
      }

      marketLogger.info(`Top volumes: ${symbols.slice(0, 10).join(', ')}`);
      return symbols;

    } catch (err) {
      marketLogger.error({ err }, 'Volume fetch failed');
      return this._getFilteredFallback(count, isExcluded);
    }
  }

  /**
   * Fallback that applies the SAME filters to perpetualMarkets
   */
  _getFilteredFallback(count, isExcludedFn) {
    const filtered = this.perpetualMarkets.filter(symbol => {
      const market = this.exchange.markets?.[symbol];
      if (!market) return false;
      const base = market.base || '';
      const quote = market.quote || '';
      return !isExcludedFn(base, quote, symbol);
    });
    
    marketLogger.warn(`Fallback returned ${filtered.length} symbols after filtering`);
    return filtered.slice(0, count);
        }
  
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
      const { calculateEMA, calculateATR } = await import('../utils/math.js');
      
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

      return { primary, strength, volatile: atr.percent > 3, atr: atr.percent };

    } catch (err) {
      marketLogger.error({ err }, 'BTC trend error');
      return { primary: 'neutral', strength: 0, volatile: false };
    }
  }

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
        
