const fs = require('fs');

let code = fs.readFileSync('signalpha-live-trading-bot.js', 'utf8');

// Fix 1: Add symbol normalization to MarketDataEngine
code = code.replace(
  'this.lastUpdate = Date.now();',
  `this.lastUpdate = Date.now();
    
    // Symbol format cache
    this.symbolMap = new Map();`
);

// Fix 2: Fix getTopVolumeSymbols to return proper format
code = code.replace(
  /async getTopVolumeSymbols\(count = 20\) \{[\s\S]*?return \['BTC\/USDT:USDT'[\s\S]*?\]\;[\s\S]*?\}/,
  `async getTopVolumeSymbols(count = 20) {
    console.log(\`🏆 Fetching top \${count} volume symbols...\`);
    try {
      const tickers = await this.exchange.fetchTickers();
      const perpetuals = Object.values(tickers)
        .filter(t => {
          const symbol = t.symbol || '';
          const isPerp = symbol.includes(':USDT') || symbol.includes('/USDT:');
          const hasVolume = (t.quoteVolume || 0) > CONFIG.TA.MIN_VOLUME_USD;
          const isActive = t.last !== undefined && t.last > 0;
          return isPerp && hasVolume && isActive;
        })
        .sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0))
        .slice(0, count)
        .map(t => t.symbol);
      
      console.log(\`✅ Top volumes: \${perpetuals.slice(0, 5).join(', ')}...\`);
      return perpetuals;
    } catch (err) {
      console.error('❌ Failed to fetch top volumes:', err.message);
      return ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'BNB/USDT:USDT', 'XRP/USDT:USDT'];
    }
  }`
);

// Fix 3: Fix hardcoded symbols in GET_SIGNAL
code = code.replace(
  "const majors = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'BNB/USDT:USDT', 'XRP/USDT:USDT'];",
  "const symbols = await this.marketData.getTopVolumeSymbols(10);"
);

fs.writeFileSync('signalpha-live-trading-bot-fixed.js', code);
console.log('✅ Patched file created: signalpha-live-trading-bot-fixed.js');
