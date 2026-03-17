const fs = require('fs');

const file = 'signalpha-live-trading-bot.js';
let code = fs.readFileSync(file, 'utf8');

// Fix 1: Add isValidSymbol and normalizeSymbol methods after constructor
const constructorEnd = "console.log('✅ MarketDataEngine constructed');";
const newMethods = `
console.log('✅ MarketDataEngine constructed');

  // Validate if symbol exists in loaded markets
  isValidSymbol(symbol) {
    if (!symbol) return false;
    if (!this.exchange.markets) return false;
    
    if (this.exchange.markets[symbol]) return true;
    
    const normalized = symbol.replace(':USDT', '/USDT');
    if (this.exchange.markets[normalized]) return true;
    
    const base = symbol.split('/')[0];
    return Object.keys(this.exchange.markets).some(m => 
      m.startsWith(base + '/') && m.includes('USDT')
    );
  }

  normalizeSymbol(symbol) {
    if (!symbol) return null;
    
    if (symbol.includes(':USDT') && this.exchange.markets[symbol]) {
      return symbol;
    }
    
    if (symbol.includes('/USDT') && !symbol.includes(':')) {
      const perpetual = symbol.replace('/USDT', '/USDT:USDT');
      if (this.exchange.markets[perpetual]) return perpetual;
    }
    
    if (!symbol.includes('/')) {
      const base = symbol.replace('USDT', '');
      const perpetual = \`\${base}/USDT:USDT\`;
      if (this.exchange.markets[perpetual]) return perpetual;
    }
    
    return symbol;
  }

  async safeFetchOHLCV(symbol, timeframe, limit = 100) {
    if (!this.isValidSymbol(symbol)) {
      console.log(\`⛔ Invalid symbol: \${symbol}\`);
      return null;
    }
    
    try {
      return await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    } catch (err) {
      if (err.message.includes('Invalid symbol')) {
        console.log(\`⛔ Invalid symbol (exchange): \${symbol}\`);
        return null;
      }
      throw err;
    }
  }`;

code = code.replace(constructorEnd, newMethods);

// Fix 2: Replace startOhlcvPolling
const oldPolling = /startOhlcvPolling\(\) \{[\s\S]*?console\.log\('✅ OHLCV polling active'\);[\s\S]*?\}/;
const newPolling = `startOhlcvPolling() {
    console.log('⏱️ Starting OHLCV polling (15s interval)...');
    
    const poll = async () => {
      if (!this.isRunning) return;
      
      try {
        const rawSymbols = this.perpetualMarkets.slice(0, 30);
        const validSymbols = rawSymbols.filter(s => this.isValidSymbol(s));
        
        if (validSymbols.length === 0) {
          console.log('⚠️ No valid symbols to poll');
          await new Promise(r => setTimeout(r, 30000));
          if (this.isRunning) setTimeout(poll, 15000);
          return;
        }
        
        console.log(\`🔄 Polling \${validSymbols.length} valid symbols...\`);
        
        for (const symbol of validSymbols) {
          if (!this.isRunning) break;
          
          for (const timeframe of CONFIG.TA.TIMEFRAMES) {
            try {
              const ohlcv = await this.safeFetchOHLCV(symbol, timeframe, 100);
              if (ohlcv && ohlcv.length > 0) {
                const key = \`\${symbol}_\${timeframe}\`;
                this.ohlcvCache.set(key, {
                  data: ohlcv,
                  timestamp: Date.now(),
                });
              }
              await new Promise(r => setTimeout(r, 100));
            } catch (err) {
              // Silent continue
            }
          }
        }
        
        this.lastUpdate = Date.now();
        console.log(\`✅ Poll cycle complete, cache size: \${this.ohlcvCache.size}\`);
        
      } catch (err) {
        console.error('❌ Polling error:', err.message);
      }
      
      if (this.isRunning) {
        setTimeout(poll, 15000);
      }
    };
    
    setTimeout(poll, 5000);
    console.log('✅ OHLCV polling active');
  }`;

code = code.replace(oldPolling, newPolling);

// Fix 3: Replace fetchOHLCV
const oldFetch = /async fetchOHLCV\(symbol, timeframe, limit = 100\) \{[\s\S]*?return cached\?\.data \|\| null;[\s\S]*?\}/;
const newFetch = `async fetchOHLCV(symbol, timeframe, limit = 100) {
    const normalizedSymbol = this.normalizeSymbol(symbol) || symbol;
    
    const key = \`\${normalizedSymbol}_\${timeframe}\`;
    const cached = this.ohlcvCache.get(key);
    
    if (cached && Date.now() - cached.timestamp < 45000) {
      return cached.data;
    }

    try {
      console.log(\`📊 Fetching OHLCV: \${normalizedSymbol} \${timeframe}\`);
      const data = await this.safeFetchOHLCV(normalizedSymbol, timeframe, limit);
      
      if (data && data.length > 0) {
        this.ohlcvCache.set(key, { data, timestamp: Date.now() });
        return data;
      }
      
      return cached?.data || null;
      
    } catch (err) {
      logger.error(\`Failed to fetch OHLCV for \${normalizedSymbol}:\`, err.message);
      return cached?.data || null;
    }
  }`;

code = code.replace(oldFetch, newFetch);

// Fix 4: Replace getCurrentPrice
const oldPrice = /async getCurrentPrice\(symbol\) \{[\s\S]*?return null;[\s\S]*?\}/;
const newPrice = `async getCurrentPrice(symbol) {
    if (!symbol) return null;
    
    const normalized = this.normalizeSymbol(symbol) || symbol;
    
    const wsKey = normalized.toLowerCase().replace('/', '').replace(':usdt', 'usdt');
    const wsData = this.priceCache.get(wsKey);
    if (wsData && Date.now() - wsData.timestamp < 10000) {
      return wsData.price;
    }
    
    try {
      if (!this.isValidSymbol(normalized)) {
        console.log(\`⛔ Cannot fetch price - invalid symbol: \${normalized}\`);
        return null;
      }
      
      const ticker = await this.exchange.fetchTicker(normalized);
      return ticker?.last || null;
    } catch (err) {
      logger.error(\`Failed to get price for \${normalized}:\`, err.message);
      return null;
    }
  }`;

code = code.replace(oldPrice, newPrice);

// Fix 5: Replace get24hVolume
const oldVolume = /async get24hVolume\(symbol\) \{[\s\S]*?return 0;[\s\S]*?\}/;
const newVolume = `async get24hVolume(symbol) {
    if (!symbol) return 0;
    
    const normalized = this.normalizeSymbol(symbol) || symbol;
    
    if (!this.isValidSymbol(normalized)) {
      return 0;
    }
    
    try {
      const ticker = await this.exchange.fetchTicker(normalized);
      return ticker?.quoteVolume || 0;
    } catch (err) {
      return 0;
    }
  }`;

code = code.replace(oldVolume, newVolume);

fs.writeFileSync(file, code);
console.log('✅ All fixes applied to ' + file);
console.log('🚀 Run: node ' + file);
  
