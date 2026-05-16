import { CONFIG } from '../../config/index.js';

export function detectBreakout(analysis) {
  const { structure, volume, levels, momentum, price, ohlcv, trend } = analysis;
  
  if (structure?.bos === 'none') return null;

  const volRatio = volume?.ratio || 1;
  if (volRatio < 1.0) return null;

  const direction = structure.bos.includes('bullish') ? 'bullish' : 'bearish';
  
  const macdAligns = momentum?.macd?.trend?.includes(direction === 'bullish' ? 'bull' : 'bear');
  if (!macdAligns && volRatio < 1.5) return null;

  const recentCandles = ohlcv?.slice(-3) || [];
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
  
  const range = Math.abs(levels.resistance - levels.support);
  const measuredMove = range * 1.5;
  
  const target = direction === 'bullish'
    ? Math.max(levels.resistance * 1.06, price + measuredMove, price * 1.08)
    : Math.min(levels.support * 0.94, price - measuredMove, price * 0.92);
  
  const rr = Math.abs(target - entry) / Math.abs(entry - stop);
  if (rr < 1.5) return null;

  const isClean = volRatio > 1.5 && structure.strength > 50 && trend?.alignment;

  return {
    type: 'Breakout Play',
    direction,
    quality: isClean ? 'A' : 'B+',
    entry,
    stop,
    target,
    rr,
    timeframe: '1H-4H',
    maxHold: '8-24 hours',
    note: isClean ? 'Clean BOS with volume — swing target' : 'Moderate breakout — manage on lower TF',
    invalidation: `Close back beyond ${direction === 'bullish' ? 'breakout' : 'breakdown'} level ($${stop.toFixed(4)})`,
    confidence: isClean ? 'high' : 'medium',
    context: volRatio > 2 ? 'High volume breakout' : 'Standard breakout',
  };
}
