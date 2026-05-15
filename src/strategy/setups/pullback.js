// ==========================================
// S/R PULLBACK SETUP
// Bounce from range extremes
// ==========================================

import { CONFIG } from '../../config/index.js';

/**
 * Detect pullback to support/resistance setup
 */
export function detectPullback(analysis) {
  const { levels, price, trend, momentum } = analysis;
  
  if (!levels.nearSupport && !levels.nearResistance) return null;
  
  const atSupport = levels.nearSupport;
  const direction = atSupport ? 'bullish' : 'bearish';
  
  // Don't fight strong opposing trend
  if (trend?.primary !== 'neutral' && trend?.primary !== direction) {
    if (trend?.strength > 60) return null;
  }

  // RSI should support the bounce direction
  const rsi = momentum?.rsi?.value || 50;
  const rsiOk = atSupport ? rsi < 55 : rsi > 45;
  if (!rsiOk) return null;

  const stop = atSupport
    ? levels.support * 0.99
    : levels.resistance * 1.01;
  
  const target = atSupport
    ? (levels.pivot || levels.resistance)
    : (levels.pivot || levels.support);
  
  const rr = Math.abs(target - price) / Math.abs(price - stop);
  if (rr < CONFIG.RISK.MIN_RR) return null;

  return {
    type: 'S/R Pullback',
    direction,
    quality: 'B+',
    entry: price,
    stop,
    target,
    rr,
    timeframe: '15M-30M',
    note: `Bounce from ${atSupport ? 'support' : 'resistance'}`,
    invalidation: `Close beyond ${atSupport ? 'support' : 'resistance'}`,
    confidence: 'medium',
  };
}
