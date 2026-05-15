// ==========================================
// VOLUME ANALYSIS MODULE
// Volume confirmation and OBV trend
// ==========================================

/**
 * Analyze volume patterns
 * @param {number[][]} ohlcv 
 */
export function analyzeVolume(ohlcv) {
  if (!ohlcv || ohlcv.length < 20) {
    return { ratio: 1, trend: 'normal', confirmation: false, obvTrend: 'neutral' };
  }

  const volumes = ohlcv.map(c => c[5]);
  const closes = ohlcv.map(c => c[4]);

  // Current vs 20-period average
  const avgVolume = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const currentVolume = volumes[volumes.length - 1];
  const ratio = avgVolume > 0 ? currentVolume / avgVolume : 1;

  // Volume trend
  const recentVol = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const prevVol = volumes.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
  
  let trend = 'normal';
  if (ratio > 1.5) trend = 'breakout';
  else if (ratio > 1.2) trend = 'rising';
  else if (ratio < 0.8) trend = 'falling';

  // Simplified OBV
  let obv = 0;
  for (let i = 1; i < Math.min(ohlcv.length, 10); i++) {
    if (closes[i] > closes[i - 1]) obv += volumes[i];
    else if (closes[i] < closes[i - 1]) obv -= volumes[i];
  }

  const confirmation = (obv > 0 && closes[closes.length - 1] > closes[closes.length - 5]) ||
                      (obv < 0 && closes[closes.length - 1] < closes[closes.length - 5]);

  return {
    ratio: Math.round(ratio * 100) / 100,
    trend,
    confirmation,
    obvTrend: obv > 0 ? 'positive' : 'negative',
    avgVolume: Math.round(avgVolume),
    currentVolume: Math.round(currentVolume),
  };
}
