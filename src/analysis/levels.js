// ==========================================
// SUPPORT/RESISTANCE & LEVELS MODULE
// Swing point detection with clustering
// ==========================================

/**
 * Find key support/resistance levels
 * @param {number[][]} ohlcv 
 * @param {number} touchesRequired 
 */
export function findKeyLevels(ohlcv, touchesRequired = 2) {
  if (!ohlcv || ohlcv.length < 30) {
    return {
      support: null,
      resistance: null,
      pivot: null,
      valid: false,
      touches: 0,
    };
  }

  const highs = ohlcv.map(c => c[2]);
  const lows = ohlcv.map(c => c[3]);
  const closes = ohlcv.map(c => c[4]);

  const lookback = Math.min(50, ohlcv.length - 4);
  const swingHighs = [];
  const swingLows = [];

  for (let i = 2; i < lookback - 2; i++) {
    const idx = ohlcv.length - lookback + i;
    
    if (highs[idx] > highs[idx-1] && highs[idx] > highs[idx-2] &&
        highs[idx] > highs[idx+1] && highs[idx] > highs[idx+2]) {
      swingHighs.push({ price: highs[idx], strength: 2 });
    }
    
    if (lows[idx] < lows[idx-1] && lows[idx] < lows[idx-2] &&
        lows[idx] < lows[idx+1] && lows[idx] < lows[idx+2]) {
      swingLows.push({ price: lows[idx], strength: 2 });
    }
  }

  // Recent extremes
  const recentHigh = Math.max(...highs.slice(-10));
  const recentLow = Math.min(...lows.slice(-10));
  
  if (recentHigh > highs[highs.length - 11] * 0.99) {
    swingHighs.push({ price: recentHigh, strength: 1 });
  }
  if (recentLow < lows[lows.length - 11] * 1.01) {
    swingLows.push({ price: recentLow, strength: 1 });
  }

  const resistance = clusterLevels(swingHighs.map(h => h.price), 0.005);
  const support = clusterLevels(swingLows.map(l => l.price), 0.005);

  const currentPrice = closes[closes.length - 1];
  
  // Count touches
  const recentCloses = closes.slice(-20);
  let supportTouches = 0;
  let resistanceTouches = 0;

  for (const close of recentCloses) {
    if (support.some(s => Math.abs(close - s) / s < 0.003)) supportTouches++;
    if (resistance.some(r => Math.abs(close - r) / r < 0.003)) resistanceTouches++;
  }

  const nearestSupport = support.find(s => s < currentPrice) || support[0];
  const nearestResistance = resistance.find(r => r > currentPrice) || resistance[0];
  
  const pivot = nearestSupport && nearestResistance ? 
    (nearestSupport + nearestResistance) / 2 : null;

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
    nearSupport: nearestSupport ? Math.abs(currentPrice - nearestSupport) / currentPrice < 0.01 : false,
    nearResistance: nearestResistance ? Math.abs(currentPrice - nearestResistance) / currentPrice < 0.01 : false,
    range: nearestResistance && nearestSupport ? nearestResistance - nearestSupport : null,
  };
}

/**
 * Cluster price levels within threshold
 */
function clusterLevels(levels, threshold = 0.01) {
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
  
