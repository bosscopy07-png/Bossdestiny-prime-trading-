// ==========================================
// SUPPORT/RESISTANCE & LEVELS MODULE
// Swing point detection with clustering and touch counting
// ==========================================

/**
 * Cluster price levels within threshold
 * @param {number[]} levels - Array of price levels
 * @param {number} threshold - Clustering threshold (default 0.5%)
 * @returns {number[]} Clustered level averages
 */
function clusterLevels(levels, threshold = 0.005) {
  if (levels.length === 0) return [];
  
  const sorted = [...levels].sort((a, b) => a - b);
  const clusters = [];
  let currentCluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i] - currentCluster[0]) / currentCluster[0] < threshold) {
      currentCluster.push(sorted[i]);
    } else {
      clusters.push(currentCluster.reduce((a, b) => a + b, 0) / currentCluster.length);
      currentCluster = [sorted[i]];
    }
  }
  
  if (currentCluster.length > 0) {
    clusters.push(currentCluster.reduce((a, b) => a + b, 0) / currentCluster.length);
  }

  return clusters.sort((a, b) => a - b);
}

/**
 * Calculate Fibonacci retracement levels
 * @param {number} high - Swing high
 * @param {number} low - Swing low
 * @returns {Object} Fibonacci levels
 */
export function calculateFibonacci(high, low) {
  const diff = high - low;
  return {
    0: high,
    0.236: high - diff * 0.236,
    0.382: high - diff * 0.382,
    0.5: high - diff * 0.5,
    0.618: high - diff * 0.618,
    0.786: high - diff * 0.786,
    1: low,
    range: diff,
  };
}

/**
 * Find key support/resistance levels with proven touch counts
 * @param {number[][]} ohlcv - OHLCV array [timestamp, open, high, low, close, volume]
 * @param {number} touchesRequired - Minimum touches to consider level valid (default 2)
 * @returns {Object} Level data including support, resistance, pivot, touch counts, swing points
 */
export function findKeyLevels(ohlcv, touchesRequired = 2) {
  if (!ohlcv || ohlcv.length < 50) {
    return {
      support: null,
      resistance: null,
      pivot: null,
      supportList: [],
      resistanceList: [],
      supportTouches: 0,
      resistanceTouches: 0,
      valid: false,
      nearSupport: false,
      nearResistance: false,
      range: null,
      swingHighs: [],
      swingLows: [],
    };
  }

  const highs = ohlcv.map(c => c[2]);
  const lows = ohlcv.map(c => c[3]);
  const closes = ohlcv.map(c => c[4]);

  // Look back 100 candles for more history
  const lookback = Math.min(100, ohlcv.length - 6);
  
  // Find 3-bar swing points for stronger levels
  const swingHighs = [];
  const swingLows = [];

  for (let i = 3; i < lookback - 3; i++) {
    const idx = ohlcv.length - lookback + i;
    
    const isSwingHigh = 
      highs[idx] > highs[idx-1] && highs[idx] > highs[idx-2] && highs[idx] > highs[idx-3] &&
      highs[idx] > highs[idx+1] && highs[idx] > highs[idx+2] && highs[idx] > highs[idx+3];
    
    if (isSwingHigh) {
      swingHighs.push({ price: highs[idx], index: idx, touches: 0 });
    }
    
    const isSwingLow = 
      lows[idx] < lows[idx-1] && lows[idx] < lows[idx-2] && lows[idx] < lows[idx-3] &&
      lows[idx] < lows[idx+1] && lows[idx] < lows[idx+2] && lows[idx] < lows[idx+3];
    
    if (isSwingLow) {
      swingLows.push({ price: lows[idx], index: idx, touches: 0 });
    }
  }

  // Count how many times price came near each level in last 50 candles
  const recentCloses = closes.slice(-50);
  
  for (const level of swingHighs) {
    let touches = 0;
    for (const close of recentCloses) {
      if (Math.abs(close - level.price) / level.price < 0.008) {
        touches++;
      }
    }
    level.touches = touches;
  }
  
  for (const level of swingLows) {
    let touches = 0;
    for (const close of recentCloses) {
      if (Math.abs(close - level.price) / level.price < 0.008) {
        touches++;
      }
    }
    level.touches = touches;
  }

  // Only keep levels with 2+ touches (proven S/R)
  const provenHighs = swingHighs.filter(h => h.touches >= 2);
  const provenLows = swingLows.filter(l => l.touches >= 2);

  // Fallback: if no proven levels, use the strongest swing (most touches)
  if (provenHighs.length === 0 && swingHighs.length > 0) {
    provenHighs.push(swingHighs.sort((a, b) => b.touches - a.touches)[0]);
  }
  if (provenLows.length === 0 && swingLows.length > 0) {
    provenLows.push(swingLows.sort((a, b) => b.touches - a.touches)[0]);
  }

  // Cluster nearby levels
  const resistance = clusterLevels(provenHighs.map(h => h.price), 0.005);
  const support = clusterLevels(provenLows.map(l => l.price), 0.005);

  const currentPrice = closes[closes.length - 1];
  
  // Find nearest valid levels
  const validSupport = support.filter(s => s < currentPrice);
  const validResistance = resistance.filter(r => r > currentPrice);
  
  const nearestSupport = validSupport.length > 0 
    ? Math.max(...validSupport)
    : support[0];
  
  const nearestResistance = validResistance.length > 0
    ? Math.min(...validResistance)
    : resistance[0];

  const pivot = nearestSupport && nearestResistance 
    ? (nearestSupport + nearestResistance) / 2 
    : null;

  // Count recent touches on FINAL levels
  let supportTouches = 0;
  let resistanceTouches = 0;
  for (const close of recentCloses.slice(-20)) {
    if (nearestSupport && Math.abs(close - nearestSupport) / nearestSupport < 0.005) supportTouches++;
    if (nearestResistance && Math.abs(close - nearestResistance) / nearestResistance < 0.005) resistanceTouches++;
  }

  const valid = support.length > 0 && resistance.length > 0 &&
                (supportTouches >= touchesRequired || resistanceTouches >= touchesRequired);

  return {
    support: nearestSupport,
    resistance: nearestResistance,
    pivot,
    supportList: support.slice(0, 3),
    resistanceList: resistance.slice(0, 3),
    supportTouches,
    resistanceTouches,
    valid,
    nearSupport: nearestSupport ? Math.abs(currentPrice - nearestSupport) / currentPrice < 0.015 : false,
    nearResistance: nearestResistance ? Math.abs(currentPrice - nearestResistance) / currentPrice < 0.015 : false,
    range: nearestResistance && nearestSupport ? nearestResistance - nearestSupport : null,
    swingHighs: provenHighs.slice(0, 5),
    swingLows: provenLows.slice(0, 5),
  };
                                        }
      
