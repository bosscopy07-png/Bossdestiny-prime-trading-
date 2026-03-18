const fs = require('fs');
const file = 'signalpha-live-trading-bot.js';
let code = fs.readFileSync(file, 'utf8');

// Fix 1: Replace MarketDataEngine constructor
const oldConstructor = /class MarketDataEngine extends EventEmitter \{[\s\S]*?console\.log\('✅ MarketDataEngine constructed'\);/;
const newConstructor = `class MarketDataEngine extends EventEmitter {
  constructor() {
    super();
    
    // Initialize ALL properties FIRST
    this.priceCache = new Map();
    this.ohlcvCache = new Map();
    this.wsConnections = new Map();
    this.isRunning = false;
    this.perpetualMarkets = [];
    this.lastUpdate = Date.now();
    this.exchange = null;
    
    console.log('🏗️ Initializing MarketDataEngine...');
    
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
      
      console.log('✅ Exchange initialized: binance');
    } catch (err) {
      console.error('❌ Exchange init failed:', err.message);
      throw err;
    }

    console.log('✅ MarketDataEngine constructed');
  }`;

code = code.replace(oldConstructor, newConstructor);

// Fix 2: Replace startOhlcvPolling with safe version
const oldPolling = /startOhlcvPolling\(\) \{[\s\S]*?console\.log\('✅ Polling scheduled'\);[\s\S]*?\}/;
const newPolling = `startOhlcvPolling() {
    console.log('⏱️ Starting OHLCV polling...');
    const self = this;
    
    const poll = async function() {
      if (!self.isRunning) return;
      
      if (!self.ohlcvCache) {
        console.error('❌ ohlcvCache undefined!');
        self.ohlcvCache = new Map();
      }
      
      try {
        const symbols = (self.perpetualMarkets || [])
          .filter(s => self.isValidSymbol(s))
          .slice(0, 15);
        
        if (symbols.length === 0) {
          console.log('⚠️ No valid symbols');
          setTimeout(poll, 30000);
          return;
        }
        
        console.log(\`🔄 Polling \${symbols.length} symbols...\`);
        let fetched = 0;
        
        for (const symbol of symbols) {
          if (!self.isRunning) break;
          
          for (const tf of ['15m', '1h']) {
            try {
              const data = await self.safeFetchOHLCV(symbol, tf, 100);
              if (data) {
                self.ohlcvCache.set(\`\${symbol}_\${tf}\`, {
                  data,
                  timestamp: Date.now()
                });
                fetched++;
              }
              await new Promise(r => setTimeout(r, 250));
            } catch (e) {}
          }
        }
        
        console.log(\`✅ Fetched \${fetched}, cache: \${self.ohlcvCache.size}\`);
        
      } catch (err) {
        console.error('❌ Polling error:', err.message);
      }
      
      if (self.isRunning) {
        setTimeout(poll, 30000);
      }
    };
    
    setTimeout(poll, 10000);
    console.log('✅ Polling scheduled');
  }`;

code = code.replace(oldPolling, newPolling);

// Fix 3: Add safety to fetchOHLCV
const oldFetch = /async fetchOHLCV\(symbol, timeframe, limit = 100\) \{[\s\S]*?return cached\?\.data \|\| null;[\s\S]*?\}/;
const newFetch = `async fetchOHLCV(symbol, timeframe, limit = 100) {
    if (!this.ohlcvCache) {
      console.error('❌ ohlcvCache undefined!');
      this.ohlcvCache = new Map();
    }
    
    const normalized = this.normalizeSymbol(symbol) || symbol;
    const key = \`\${normalized}_\${timeframe}\`;
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

code = code.replace(oldFetch, newFetch);

fs.writeFileSync(file, code);
console.log('✅ Initialization fixes applied');
console.log('🚀 Run: node ' + file);
