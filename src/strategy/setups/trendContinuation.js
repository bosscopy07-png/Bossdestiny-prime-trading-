// ==========================================
// TREND CONTINUATION SETUP
// Pullback to EMA/Fibonacci in established trend
// ==========================================

import { CONFIG } from '../../config/index.js';

export function detectTrendContinuation(analysis) {
  const { trend, price, levels, momentum, fibonacci } = analysis;
  
  if (trend?.primary === 'neutral' || trend?.strength < 40) return null;

  const direction = trend.primary;
  
  const ema20 = trend.ema20;
  const ema50 = trend.ema50;
  
  const nearEma20 = ema20 && Math.abs(price - ema20) / price < 0.015;
  const nearEma50 = ema50 && Math.abs(price - ema50) / price < 0.025;
  
  let nearFib = false;
  let fibLevel = null;
  if (fibonacci) {
    for (const f of [0.382, 0.5, 0.618]) {
      if (Math.abs(price - fibonacci[f]) / price < 0.012) {
        nearFib = true;
        fibLevel = f;
        break;
      }
    }
  }

  if (!nearEma20 && !nearEma50 && !nearFib) return null;

  const rsi = momentum?.rsi?.value || 50;
  const rsiResetting = direction === 'bullish' ? rsi < 60 : rsi > 40;
  if (!rsiResetting) return null;

  const stop = direction === 'bullish' 
    ? (levels.support * 0.992 || price * 0.97)
    : (levels.resistance * 1.008 || price * 1.03);
  
  const target = direction === 'bullish'
    ? levels.resistance || price * 1.03
    : levels.support || price * 0.97;
  
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
    note: trend.alignment ? 'Aligned trend pullback' : 'Single TF trend - caution',
    invalidation: `Break of ${direction === 'bullish' ? 'support' : 'resistance'}`,
    confidence: trend.alignment ? 'high' : 'medium',
    context: nearFib ? `Near ${fibLevel} Fib` : nearEma20 ? 'Near EMA20' : 'Near EMA50',
  };
                              }
      
