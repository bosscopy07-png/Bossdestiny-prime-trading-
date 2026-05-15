// ==========================================
// BREAKOUT PLAY SETUP
// Structure break with volume confirmation
// ==========================================

import { CONFIG } from '../../config/index.js';

/**
 * Detect breakout setup — structure break with volume confirmation
 */
export function detectBreakout(analysis) {
  const { structure, volume, levels, momentum, price } = analysis;
  
  if (structure?.bos === 'none') return null;
  if (volume?.ratio < 1.3) return null;

  const direction = structure.bos.includes('bullish') ? 'bullish' : 'bearish';
  
  const macdAligns = momentum?.macd?.trend?.includes(direction === 'bullish' ? 'bull' : 'bear');
  if (!macdAligns) return null;

  // Avoid entering after overextended candles
  const recentCandles = analysis.ohlcv?.slice(-3) || [];
  if (recentCandles.length >= 2) {
    const lastClose = recentCandles[recentCandles.length - 1][4];
    const prevClose = recentCandles[recentCandles.length - 2][4];
    const pctMove = Math.abs((lastClose - prevClose) / prevClose) * 100;
    if (pctMove > 5) return null; // Too extended, wait for pullback
  }

  const entry = price;
  const stop = direction === 'bullish'
    ? levels.pivot || levels.support || price * 0.985
    : levels.pivot || levels.resistance || price * 1.015;
  
  const target = direction === 'bullish'
    ? (levels.resistance * 1.02 || price * 1.04)
    : (levels.support * 0.98 || price * 0.96);
  
  const rr = Math.abs(target - entry) / Math.abs(entry - stop);
  if (rr < CONFIG.RISK.MIN_RR) return null;

  const isClean = volume.ratio > 1.8 && structure.strength > 60;
  
  return {
    type: 'Breakout Play',
    direction,
    quality: isClean ? 'A' : 'B+',
    entry,
    stop,
    target,
    rr,
    timeframe: '5M-15M',
    note: isClean ? 'Clean BOS with volume' : 'Moderate breakout',
    invalidation: `Close back below ${direction === 'bullish' ? 'breakout' : 'breakdown'} level`,
    confidence: isClean ? 'high' : 'medium',
  };
}
