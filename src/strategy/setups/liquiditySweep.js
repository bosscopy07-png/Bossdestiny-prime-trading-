// ==========================================
// LIQUIDITY SWEEP SETUP DETECTOR
// Clean institutional entry — SWING FOCUSED (4-24h holds)
// ==========================================

import { CONFIG } from '../../config/index.js';

/**
 * Detect liquidity sweep setup
 * RELAXED: OR condition for momentum, accepts weak sweeps, wider targets
 */
export function detectLiquiditySweep(analysis) {
  const { sweep, levels, trend, price, momentum, structure } = analysis;
  
  // Must have some sweep signal (strong or weak)
  if (!sweep?.bullish && !sweep?.bearish && !sweep?.weakBullish && !sweep?.weakBearish) {
    return null;
  }

  const isBullish = sweep.bullish || sweep.weakBullish;
  const isStrong = sweep.bullish || sweep.bearish; // Strong = clear sweep
  const direction = isBullish ? 'bullish' : 'bearish';

  // MOMENTUM: RELAXED — need RSI OR MACD, not both
  const rsi = momentum?.rsi?.value || 50;
  const rsiOk = (direction === 'bullish' && rsi < 65) || (direction === 'bearish' && rsi > 35);
  const macdOk = momentum?.macd?.trend?.includes(direction === 'bullish' ? 'bull' : 'bear') || 
                 momentum?.macd?.crossover !== 'none';
  
  // Accept if EITHER momentum indicator supports (was: &&)
  if (!rsiOk && !macdOk) return null;

  // Stop: sweep level with wider buffer for swing
  // Strong sweep = 1.5% buffer, weak = 2% buffer
  const stopBuffer = isStrong ? 0.985 : 0.98;
  const stop = sweep.level * (direction === 'bullish' ? stopBuffer : 1 / stopBuffer);

  // WIDE TARGETS for swing
  // Use next major S/R or measured move from sweep
  const sweepDepth = Math.abs(price - sweep.level);
  const measuredTarget = direction === 'bullish'
    ? price + (sweepDepth * 3)  // 3x the sweep depth
    : price - (sweepDepth * 3);

  const target = direction === 'bullish'
    ? Math.max(levels.resistance * 1.05, measuredTarget, price * 1.06)
    : Math.min(levels.support * 0.95, measuredTarget, price * 0.94);

  const rr = Math.abs(target - price) / Math.abs(price - stop);

  // RELAXED: Weak sweeps need 1.5 R:R minimum, strong need 1.2
  const minRR = isStrong ? 1.2 : 1.5;
  if (rr < minRR) return null;

  // Quality: strong sweep + momentum alignment = A, else B+
  const momentumAligned = (direction === 'bullish' && rsi < 50) || 
                          (direction === 'bearish' && rsi > 50);

  return {
    type: 'Liquidity Sweep',
    direction,
    quality: isStrong && momentumAligned ? 'A' : isStrong ? 'A-' : 'B+',
    entry: price,
    stop,
    target,
    rr,
    timeframe: '15M-1H',          // Entry TF
    maxHold: '4-12 hours',          // SWING: Was '5M-15M'
    note: isStrong 
      ? 'Clean liquidity grab — swing to next S/R' 
      : 'Weak sweep — manage tight, scale early',
    invalidation: `Close beyond $${stop.toFixed(4)} (2% buffer)`,
    confidence: isStrong ? 'high' : 'medium',
    context: isStrong ? 'Strong sweep with momentum' : 'Weak sweep — caution',
    warning: !isStrong ? 'Weak sweep — consider 50% size' : null,
  };
}
