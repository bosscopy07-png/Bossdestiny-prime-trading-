// ==========================================
// LIQUIDITY SWEEP SETUP DETECTOR
// Highest priority — clean institutional entry
// ==========================================

import { CONFIG } from '../../config/index.js';

/**
 * Detect liquidity sweep setup
 */
export function detectLiquiditySweep(analysis) {
  const { sweep, levels, trend, price, momentum } = analysis;
  
  if (!sweep?.bullish && !sweep?.bearish && !sweep?.weakBullish && !sweep?.weakBearish) {
    return null;
  }

  const isBullish = sweep.bullish || sweep.weakBullish;
  const isStrong = sweep.bullish || sweep.bearish;
  const direction = isBullish ? 'bullish' : 'bearish';
  
  // Verify momentum alignment
  const rsiOk = momentum?.rsi?.value > 30 && momentum?.rsi?.value < 70;
  const macdOk = momentum?.macd?.trend?.includes(direction === 'bullish' ? 'bull' : 'bear');
  
  if (!rsiOk && !macdOk) return null;

  const stop = sweep.level * (direction === 'bullish' ? 0.985 : 1.015);
  const target = direction === 'bullish' ? levels.resistance : levels.support;
  const rr = Math.abs(target - price) / Math.abs(price - stop);

  if (rr < CONFIG.RISK.MIN_RR) return null;

  return {
    type: 'Liquidity Sweep',
    direction,
    quality: isStrong ? 'A' : 'B+',
    entry: price,
    stop,
    target,
    rr,
    timeframe: '5M-15M',
    note: isStrong ? 'Clean liquidity grab' : 'Weak sweep - manage tight',
    invalidation: `Close beyond $${stop.toFixed(4)}`,
    confidence: isStrong ? 'high' : 'medium',
  };
}
