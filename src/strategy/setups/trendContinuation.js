// ==========================================
// TREND CONTINUATION SETUP
// RELAXED: Near EMA optional, broader RSI zone
// ==========================================

import { CONFIG } from '../../config/index.js';

export function detectTrendContinuation(analysis) {
  const { trend, price, levels, momentum, fibonacci } = analysis;
  
  // RELAXED: Accept weaker trends if structure is good
  if (trend?.primary === 'neutral' || trend?.strength < 25) return null;

  const direction = trend.primary;
  
  const ema20 = trend.ema20;
  const ema50 = trend.ema50;
  
  // RELAXED: Near EMA is bonus, not requirement
  const nearEma20 = ema20 && Math.abs(price - ema20) / price < 0.02;
  const nearEma50 = ema50 && Math.abs(price - ema50) / price < 0.035;
  
  let nearFib = false;
  let fibLevel = null;
  if (fibonacci) {
    for (const f of [0.382, 0.5, 0.618, 0.786]) {  // Added 0.786
      if (Math.abs(price - fibonacci[f]) / price < 0.015) {
        nearFib = true;
        fibLevel = f;
        break;
      }
    }
  }

  // RELAXED: Must be near EMA OR Fib OR in trend direction with pullback
  const inTrendDirection = direction === 'bullish' ? price > ema50 : price < ema50;
  const hasPullback = nearEma20 || nearEma50 || nearFib || inTrendDirection;

  if (!hasPullback) return null;

  // RELAXED: Broader RSI zone
  const rsi = momentum?.rsi?.value || 50;
  const rsiOk = direction === 'bullish' ? rsi < 70 : rsi > 30;
  if (!rsiOk) return null;

  // Dynamic stop: EMA50 or structure level
  const stop = direction === 'bullish' 
    ? (ema50 * 0.99 || levels.support * 0.995 || price * 0.965)
    : (ema50 * 1.01 || levels.resistance * 1.005 || price * 1.035);
  
  const target = direction === 'bullish'
    ? (levels.resistance || price * 1.04)
    : (levels.support || price * 0.96);
  
  const rr = Math.abs(target - price) / Math.abs(price - stop);
  if (rr < CONFIG.RISK.MIN_RR) return null;

  return {
    type: 'Trend Continuation',
    direction,
    quality: trend.alignment ? 'A' : 'B+',
    entry: price,
    stop,
    target,
    rr,
    timeframe: '15M-1H',
    note: trend.alignment ? 'Aligned trend pullback' : 'Single TF trend — caution',
    invalidation: `Break of ${direction === 'bullish' ? 'EMA50/support' : 'EMA50/resistance'}`,
    confidence: trend.alignment ? 'high' : 'medium',
    context: nearFib ? `Near ${fibLevel} Fib` : nearEma20 ? 'Near EMA20' : nearEma50 ? 'Near EMA50' : 'Trend pullback',
  };
}
