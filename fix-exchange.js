const fs = require('fs');
const file = 'signalpha-live-trading-bot.js';
let code = fs.readFileSync(file, 'utf8');

// Fix 1: Replace exchange initialization
code = code.replace(
  /\/\/ Initialize CCXT exchange[\s\S]*?console\.log\('✅ MarketDataEngine constructed'\);/,
  `// Initialize CCXT exchange with aggressive rate limiting
    try {
      this.exchange = new ccxt.binance({
        enableRateLimit: true,
        rateLimit: 100,
        options: {
          defaultType: 'future',
          adjustForTimeDifference: true,
        },
      });
      
      if (CONFIG.EXCHANGE.SANDBOX) {
        this.exchange.setSandboxMode(true);
      }
      
      console.log('✅ Exchange initialized: binance (USDT-M Futures)');
      
    } catch (err) {
      console.error('❌ Failed to initialize binance:', err.message);
      throw err;
    }

    this.priceCache = new Map();
    this.ohlcvCache = new Map();
    this.wsConnections = new Map();
    this.isRunning = false;
    this.perpetualMarkets = [];
    this.lastUpdate = Date.now();
    
    console.log('✅ MarketDataEngine constructed');`
);

// Fix 2: Replace symbol methods
const oldMethods = /isValidSymbol\(symbol\)[\s\S]*?return cached\?\.data \|\| null;[\s\S]*?\}/;
const newMethods = `isValidSymbol(symbol) {
    if (!symbol || !this.exchange.markets) return false;
    if (this.exchange.markets[symbol]) return this.exchange.markets[symbol].active !== false;
    return false;
  }

  normalizeSymbol(symbol) {
    if (!symbol) return null;
    if (this.isValidSymbol(symbol)) return symbol;
    
    const variations = [
      symbol.replace(':USDT', ''),
      symbol.replace('/USDT:USDT', '/USDT'),
      symbol.replace('/USDT', '/USDT:USDT'),
      symbol + '/USDT',
    ];
    
    for (const v of variations) {
      if (this.isValidSymbol(v)) return v;
    }
    
    const base = symbol.split('/')[0].replace('USDT', '');
    const found = Object.keys(this.exchange.markets).find(m => {
      const market = this.exchange.markets[m];
      return market.base === base && market.quote === 'USDT' && market.active !== false;
    });
    
    return found || null;
  }

  async safeFetchOHLCV(symbol, timeframe, limit = 100) {
    if (!symbol) return null;
    
    const validSymbol = this.normalizeSymbol(symbol);
    if (!validSymbol) {
      console.log('⛔ Cannot normalize: ' + symbol);
      return null;
    }
    
    try {
      const market = this.exchange.markets[validSymbol];
      if (!market || market.active === false) return null;
      
      const ohlcv = await this.exchange.fetchOHLCV(validSymbol, timeframe, undefined, limit);
      return (ohlcv && ohlcv.length > 0) ? ohlcv : null;
      
    } catch (err) {
      if (err.message.includes('rate limit')) {
        await new Promise(r => setTimeout(r, 1000));
      }
      return null;
    }
  }

  async fetchOHLCV(symbol, timeframe, limit = 100) {
    const normalized = this.normalizeSymbol(symbol) || symbol;
    const key = normalized + '_' + timeframe;
    const cached = this.ohlcvCache.get(key);
    
    if (cached && Date.now() - cached.timestamp < 60000) {
      return cached.data;
    }
    
    const data = await this.safeFetchOHLCV(normalized, timeframe, limit);
    if (data) {
      this.ohlcvCache.set(key, { data, timestamp: Date.now() });
      return data;
    }
    
    return cached?.data || null;
  }`;

code = code.replace(oldMethods, newMethods);

fs.writeFileSync(file, code);
console.log('✅ Exchange fixes applied');
console.log('⚠️  Make sure you have binance available: npm install ccxt');
  
