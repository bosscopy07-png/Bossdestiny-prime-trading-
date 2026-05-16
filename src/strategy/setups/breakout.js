// ==========================================
// BREAKOUT PLAY SETUP
// RELAXED: Lower volume threshold, higher candle tolerance
// ==========================================

import { CONFIG } from '../../config/index.js';

export function detectBreakout(analysis) {
  const { structure, volume, levels, momentum, price } = analysis;
  
  if (structure?.bos === 'none') return null;
  
  // RELAXED: Volume confirms but isn't required
  const volRatio = volume?.ratio || 1;
  if (volRatio < 1.0) return null;  // Was 1.3

  const direction = structure.bos.includes('bullish') ? 'bullish' : 'bearish';
  
  // RELAXED: MACD preferred but not required if volume is strong
  const macdAligns = momentum?.macd?.trend?.includes(direction === 'bullish' ? 'bull' : 'bear');
  if (!macdAligns && volRatio < 1.5) return null;  // Need one or the other

  // RELAXED: 7% move threshold (was 5%)
  const recentCandles = analysis.ohlcv?.slice(-3) || [];
  if (recentCandles.length >= 2) {
    const lastClose = recentCandles[recentCandles.length - 1][4];
    const prevClose = recentCandles[recentCandles.length - 2][4];
    const pctMove = Math.abs((lastClose - prevClose) / prevClose) * 100;
    if (pctMove > 7) return null;
  }

  const entry = price;
  const stop = direction === 'bullish'
    ? (levels.pivot || levels.support || price * 0.98)
    : (levels.pivot || levels.resistance || price * 1.02);
  
  const target = direction === 'bullish'
    ? (levels.resistance * 1.025 || price * 1.05)
    : (levels.support * 0.975 || price * 0.95);
  
  const rr = Math.abs(target - entry) / Math.abs(entry - stop);
  if (rr < CONFIG.RISK.MIN_RR) return null;

  const isClean = volRatio > 1.5 && structure.strength > 50;
  
  return {
    type: 'Breakout Play',
    direction,
    quality: isClean ? 'A' : 'B+',
    entry,
    stop,
    target,
    rr,
    timeframe: '5M-15M',
    note: isClean ? 'Clean BOS with volume' : 'Moderate breakout — confirm on lower TF',
    invalidation: `Close back below ${direction === 'bullish' ? 'breakout' : 'breakdown'} level`,
    confidence: isClean ? 'high' : 'medium',
  };
}
