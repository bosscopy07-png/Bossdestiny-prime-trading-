// ==========================================
// S/R PULLBACK SETUP
// RELAXED: Allows counter-trend at strong S/R, broader RSI
// ==========================================

import { CONFIG } from '../../config/index.js';

export function detectPullback(analysis) {
  const { levels, price, trend, momentum } = analysis;
  
  if (!levels.nearSupport && !levels.nearResistance) return null;
  
  const atSupport = levels.nearSupport;
  const direction = atSupport ? 'bullish' : 'bearish';
  
  // RELAXED: Allow counter-trend if S/R is strong (2+ touches)
  const srStrength = atSupport ? levels.supportTouches : levels.resistanceTouches;
  if (trend?.primary !== 'neutral' && trend?.primary !== direction) {
    if (trend?.strength > 70 && srStrength < 2) return null;  // Was 60 and no touch check
  }

  // RELAXED: Broader RSI — pullback zones
  const rsi = momentum?.rsi?.value || 50;
  const rsiOk = atSupport ? rsi < 60 : rsi > 40;  // Was 55/45
  if (!rsiOk) return null;

  const stop = atSupport
    ? levels.support * 0.988
    : levels.resistance * 1.012;
  
  const target = atSupport
    ? (levels.pivot || levels.resistance * 0.995)
    : (levels.pivot || levels.support * 1.005);
  
  const rr = Math.abs(target - price) / Math.abs(price - stop);
  if (rr < CONFIG.RISK.MIN_RR) return null;

  return {
    type: 'S/R Pullback',
    direction,
    quality: srStrength >= 2 ? 'A' : 'B+',
    entry: price,
    stop,
    target,
    rr,
    timeframe: '15M-30M',
    note: `Bounce from ${atSupport ? 'support' : 'resistance'}${srStrength >= 2 ? ' (tested)' : ''}`,
    invalidation: `Close beyond ${atSupport ? 'support' : 'resistance'}`,
    confidence: srStrength >= 2 ? 'high' : 'medium',
  };
}
