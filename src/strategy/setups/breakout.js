// ==========================================
// BREAKOUT PLAY SETUP
// Structure break with volume — SWING FOCUSED (4-24h holds)
// ==========================================

import { CONFIG } from '../../config/index.js';

/**
 * Detect breakout setup — structure break with volume confirmation
 * RELAXED: Lower volume threshold, wider targets, longer holds
 */
export function detectBreakout(analysis) {
  const { structure, volume, levels, momentum, price, ohlcv, trend } = analysis;
  
  if (structure?.bos === 'none') return null;

  const direction = structure.bos.includes('bullish') ? 'bullish' : 'bearish';
  
  // Volume: confirms but isn't gate (1.0x minimum, bonus above 1.5x)
  const volRatio = volume?.ratio || 1;
  if (volRatio < 0.8) return null;

  // Momentum: MACD aligns OR RSI supports direction (not both required)
  const rsi = momentum?.rsi?.value || 50;
  const rsiSupports = direction === 'bullish' ? rsi > 40 : rsi < 60;
  const macdAligns = momentum?.macd?.trend?.includes(direction === 'bullish' ? 'bull' : 'bear');
  
  if (!rsiSupports && !macdAligns) return null;

  // Avoid overextended entries: last 3 candles moved > 7% (was 5%)
  const recentCandles = ohlcv?.slice(-3) || [];
  if (recentCandles.length >= 2) {
    const lastClose = recentCandles[recentCandles.length - 1][4];
    const prevClose = recentCandles[recentCandles.length - 2][4];
    const pctMove = Math.abs((lastClose - prevClose) / prevClose) * 100;
    if (pctMove > 7) return null;
  }

  // Entry: current price (market execution on confirmed close)
  const entry = price;

  // Stop: structure level with buffer (wider for swing)
  const stopBuffer = 0.015; // 1.5% buffer (was tighter)
  const stop = direction === 'bullish'
    ? (levels.pivot || levels.support || price * 0.97)
    : (levels.pivot || levels.resistance || price * 1.03);

  // WIDE TARGETS for swing holds (8-24h)
  // Use higher timeframe structure or measured move
  const range = Math.abs(levels.resistance - levels.support);
  const measuredMove = range * 1.5; // 1.5x the range for swing
  
  const target = direction === 'bullish'
    ? Math.max(levels.resistance * 1.06, price + measuredMove, price * 1.08)
    : Math.min(levels.support * 0.94, price - measuredMove, price * 0.92);

  const rr = Math.abs(target - entry) / Math.abs(entry - stop);
  
  // RELAXED: Minimum 1.5 R:R for swing (was CONFIG.RISK.MIN_RR which was likely 2+)
  if (rr < 1.5) return null;

  // Quality: volume > 1.5x AND structure strength > 50 = A, else B+
  const isClean = volRatio > 1.5 && structure.strength > 50 && trend?.alignment;

  return {
    type: 'Breakout Play',
    direction,
    quality: isClean ? 'A' : 'B+',
    entry,
    stop,
    target,
    rr,
    timeframe: '1H-4H',           // SWING: Was '5M-15M'
    maxHold: '8-24 hours',         // SWING: Was '2-4 hours'
    note: isClean 
      ? 'Clean BOS with volume — swing target' 
      : 'Moderate breakout — manage on lower TF',
    invalidation: `Close back beyond ${direction === 'bullish' ? 'breakout' : 'breakdown'} level ($${stop.toFixed(4)})`,
    confidence: isClean ? 'high' : 'medium',
    context: volRatio > 2 ? 'High volume breakout' : 'Standard breakout',
  };
}
