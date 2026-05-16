// ==========================================
// RANGE PLAY SETUP
// RELAXED: Lower R:R threshold, volume breakout allowed
// ==========================================

/**
 * Detect range play / mean reversion setup
 */
export function detectRangePlay(analysis) {
  const { structure, levels, price, volume } = analysis;
  
  if (!structure?.consolidation) return null;
  if (!levels.range || levels.range / price < 0.012) return null;  // Was 0.015
  
  const rangeMid = (levels.support + levels.resistance) / 2;
  const nearMid = Math.abs(price - rangeMid) / price < 0.008;  // Was 0.005
  if (nearMid) return null;

  const atResistance = Math.abs(price - levels.resistance) / price < 0.012;  // Was 0.008
  const atSupport = Math.abs(price - levels.support) / price < 0.012;
  
  if (!atResistance && !atSupport) return null;

  const direction = atSupport ? 'bullish' : 'bearish';
  
  // RELAXED: Allow volume if it's rejecting (not breaking out)
  if (volume?.trend === 'breakout' && volume?.ratio > 2) return null;

  const stop = atSupport
    ? levels.support * 0.99
    : levels.resistance * 1.01;
  
  const target = rangeMid;
  
  const rr = Math.abs(target - price) / Math.abs(price - stop);
  if (rr < 1.0) return null;  // Was 1.2

  return {
    type: 'Range Play',
    direction,
    quality: 'B+',  // Was 'B'
    entry: price,
    stop,
    target,
    rr,
    timeframe: '15M-1H',
    note: 'Mean reversion in range',
    invalidation: `Break ${atSupport ? 'below support' : 'above resistance'}`,
    confidence: 'medium',
    warning: 'Counter-trend — reduce size 25%',
  };
}
