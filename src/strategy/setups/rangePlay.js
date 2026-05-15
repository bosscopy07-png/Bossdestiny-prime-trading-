// ==========================================
// RANGE PLAY SETUP
// Mean reversion in consolidation — lowest priority
// ==========================================

/**
 * Detect range play / mean reversion setup
 */
export function detectRangePlay(analysis) {
  const { structure, levels, price, volume } = analysis;
  
  if (!structure?.consolidation) return null;
  if (!levels.range || levels.range / price < 0.015) return null;
  
  const rangeMid = (levels.support + levels.resistance) / 2;
  const nearMid = Math.abs(price - rangeMid) / price < 0.005;
  if (nearMid) return null;

  const atResistance = Math.abs(price - levels.resistance) / price < 0.008;
  const atSupport = Math.abs(price - levels.support) / price < 0.008;
  
  if (!atResistance && !atSupport) return null;

  const direction = atSupport ? 'bullish' : 'bearish';
  
  // Volume should be normal (not breakout)
  if (volume?.trend === 'breakout') return null;

  const stop = atSupport
    ? levels.support * 0.992
    : levels.resistance * 1.008;
  
  const target = rangeMid;
  
  const rr = Math.abs(target - price) / Math.abs(price - stop);
  if (rr < 1.2) return null; // Lower threshold for range plays

  return {
    type: 'Range Play',
    direction,
    quality: 'B',
    entry: price,
    stop,
    target,
    rr,
    timeframe: '15M-1H',
    note: 'Mean reversion in range',
    invalidation: `Break ${atSupport ? 'below support' : 'above resistance'}`,
    confidence: 'medium',
    warning: 'Counter-trend - reduce size',
  };
}
