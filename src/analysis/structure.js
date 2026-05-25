// ==========================================
// MARKET STRUCTURE ANALYSIS
// BOS/CHoCH, HH/HL/LH/LL detection
// ==========================================

/**
 * Analyze market structure
 * @param {number[][]} ohlcv 
 */
export function analyzeStructure(ohlcv) {
  if (!ohlcv || ohlcv.length < 20) {
    return { type: 'unknown', bos: 'none', strength: 0 };
  }

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

  let type = 'ranging';
  let strength = 0;

  if (hh > lh && hl > ll) {
    type = 'uptrend';
    strength = (hh + hl) / recentHighs.length;
  } else if (lh > hh && ll > hl) {
    type = 'downtrend';
    strength = (lh + ll) / recentHighs.length;
  } else if (Math.abs(hh - lh) < 3 && Math.abs(hl - ll) < 3) {
    type = 'consolidation';
  }

  // BOS detection
  // FIX: Use non-overlapping windows to avoid double-counting candles
  // Window 1: candles [-15, -6] (10 candles)
  // Window 2: candles [-5, -1] (5 candles)
  const prevWindowHighs = highs.slice(-16, -6);
  const prevWindowLows = lows.slice(-16, -6);
  const lastWindowHighs = highs.slice(-5);
  const lastWindowLows = lows.slice(-5);

  const prevWindowHigh = prevWindowHighs.length > 0 ? Math.max(...prevWindowHighs) : 0;
  const prevWindowLow = prevWindowLows.length > 0 ? Math.min(...prevWindowLows) : Infinity;
  const lastWindowHigh = lastWindowHighs.length > 0 ? Math.max(...lastWindowHighs) : 0;
  const lastWindowLow = lastWindowLows.length > 0 ? Math.min(...lastWindowLows) : Infinity;

  let bos = 'none';
  let breakLevel = null;

  // Breakout: last window high exceeds previous window high by 0.2%
  if (lastWindowHigh > prevWindowHigh * 1.002) {
    bos = type === 'uptrend' ? 'continuation' : 'bullish_break';
    breakLevel = prevWindowHigh;
  } 
  // Breakdown: last window low below previous window low by 0.2%
  else if (lastWindowLow < prevWindowLow * 0.998) {
    bos = type === 'downtrend' ? 'continuation' : 'bearish_break';
    breakLevel = prevWindowLow;
  }

  return {
    type,
    bos,
    breakLevel,
    strength: Math.round(strength * 100),
    consolidation: type === 'consolidation' || type === 'ranging',
    trending: type === 'uptrend' || type === 'downtrend',
  };
}

/**
 * Detect liquidity sweeps beyond key levels
 * @param {number[][]} ohlcv 
 * @param {object} levels - Key levels from findKeyLevels
 */
export function detectLiquiditySweep(ohlcv, levels) {
  if (!levels?.support || !levels?.resistance || !ohlcv || ohlcv.length < 3) {
    return { 
      bullish: false, 
      bearish: false, 
      weakBullish: false, 
      weakBearish: false, 
      level: null 
    };
  }

  const lastCandle = ohlcv[ohlcv.length - 1];
  const prevCandle = ohlcv[ohlcv.length - 2];

  // FIX: Capture open prices (o1, o2) — they were used but never defined
  const [o1, h1, l1, c1] = [lastCandle[1], lastCandle[2], lastCandle[3], lastCandle[4]];
  const [o2, h2, l2, c2] = [prevCandle[1], prevCandle[2], prevCandle[3], prevCandle[4]];

  // Strong sweep: Wick beyond level, close back above/below
  const bullishSweep = l2 < levels.support && c1 > levels.support && c1 > o1;
  const bearishSweep = h2 > levels.resistance && c1 < levels.resistance && c1 < o1;

  // Weak sweep: Current or previous candle wicked beyond level but didn't close properly
  const weakBullish = !bullishSweep && (
    (l1 < levels.support && c1 > levels.support) || 
    (l2 < levels.support && c2 > levels.support)
  );
  
  const weakBearish = !bearishSweep && (
    (h1 > levels.resistance && c1 < levels.resistance) ||
    (h2 > levels.resistance && c2 < levels.resistance)
  );

  return {
    bullish: bullishSweep,
    bearish: bearishSweep,
    weakBullish,
    weakBearish,
    level: bullishSweep || weakBullish ? levels.support : 
           (bearishSweep || weakBearish ? levels.resistance : null),
  };
}
