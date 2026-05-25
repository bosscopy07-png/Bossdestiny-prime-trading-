// ==========================================
// VOLUME ANALYSIS MODULE
// Volume confirmation and OBV trend
// ==========================================

/**
 * Analyze volume patterns
 * @param {number[][]} ohlcv - CCXT OHLCV [timestamp, open, high, low, close, volume]
 * @returns {object} Volume analysis
 */
export function analyzeVolume(ohlcv) {
  if (!ohlcv || ohlcv.length < 20) {
    return { 
      ratio: 1, 
      trend: 'normal', 
      confirmation: false, 
      obvTrend: 'neutral',
      avgVolume: 0,
      currentVolume: 0,
    };
  }

  const volumes = ohlcv.map(c => c[5]);
  const closes = ohlcv.map(c => c[4]);

  // Current vs 20-period average (exclude current candle from average)
  const avgVolume = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const currentVolume = volumes[volumes.length - 1];
  const ratio = avgVolume > 0 ? currentVolume / avgVolume : 1;

  // Volume trend (3-period vs previous 3-period)
  const recentVol = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const prevVol = volumes.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
  
  let trend = 'normal';
  if (ratio > 1.5) trend = 'breakout';
  else if (ratio > 1.2) trend = 'rising';
  else if (ratio < 0.8) trend = 'falling';

  // OBV: On-Balance Volume — cumulative volume flow
  // FIX: Start from index 0, properly initialize with first candle's volume
  let obv = volumes[0]; // Initialize with first candle's volume
  for (let i = 1; i < ohlcv.length; i++) {
    if (closes[i] > closes[i - 1]) {
      obv += volumes[i];
    } else if (closes[i] < closes[i - 1]) {
      obv -= volumes[i];
    }
    // If close equals previous close, OBV unchanged
  }

  // Use last 10 candles for short-term OBV trend
  let shortObv = volumes[Math.max(0, ohlcv.length - 10)];
  for (let i = Math.max(1, ohlcv.length - 10); i < ohlcv.length; i++) {
    if (closes[i] > closes[i - 1]) {
      shortObv += volumes[i];
    } else if (closes[i] < closes[i - 1]) {
      shortObv -= volumes[i];
    }
  }

  const confirmation = (shortObv > 0 && closes[closes.length - 1] > closes[closes.length - 5]) ||
                      (shortObv < 0 && closes[closes.length - 1] < closes[closes.length - 5]);

  return {
    ratio: Math.round(ratio * 100) / 100,
    trend,
    confirmation,
    obvTrend: shortObv > 0 ? 'positive' : shortObv < 0 ? 'negative' : 'neutral',
    avgVolume: Math.round(avgVolume),
    currentVolume: Math.round(currentVolume),
  };
}
  
