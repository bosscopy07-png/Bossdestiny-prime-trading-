import { CONFIG } from '../../config/index.js';

/**
 * Trend Continuation Setup Detection
 * Detects pullbacks to EMA/Fib within established trends.
 * Uses wider ATR-based stops to let trends breathe.
 * 
 * @param {Object} analysis - Full market analysis object
 * @param {Object} analysis.trend - Trend data (primary, strength, ema20, ema50)
 * @param {number} analysis.price - Current price
 * @param {Object} analysis.levels - Key S/R levels
 * @param {Object} analysis.momentum - Momentum indicators
 * @param {Object} analysis.fibonacci - Fibonacci retracement levels
 * @param {Object} analysis.atr - ATR data
 * @returns {Object|null} Setup object or null if no valid setup
 */
export function detectTrendContinuation(analysis) {
  const { trend, price, levels, momentum, fibonacci, atr } = analysis;
  
  // ─── GUARD: Minimum trend strength ──────────────────────────
  if (trend?.primary === 'neutral' || trend?.strength < 40) return null;

  const direction = trend.primary;
  
  const ema20 = trend.ema20;
  const ema50 = trend.ema50;
  
  // ─── PULLBACK DETECTION: Near EMA or Fib ────────────────────
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

  // ─── RSI FILTER: Must be resetting (not overbought/oversold) ─
  const rsi = momentum?.rsi?.value || 50;
  const rsiResetting = direction === 'bullish' ? rsi < 60 : rsi > 40;
  if (!rsiResetting) return null;

  // ─── STOP LOSS: Below EMA50 or recent swing + ATR buffer ─────
  // Use the looser stop (further from entry) to avoid noise stops
  const atrBuffer = (atr?.value || price * 0.02) * 1.5;
  
  const swingBasedStop = direction === 'bullish'
    ? (levels.supportList?.[0] || price * 0.95) - atrBuffer
    : (levels.resistanceList?.[0] || price * 1.05) + atrBuffer;
  
  const emaBasedStop = direction === 'bullish'
    ? (ema50 || price * 0.97) - atrBuffer
    : (ema50 || price * 1.03) + atrBuffer;
  
  let stop = direction === 'bullish'
    ? Math.min(swingBasedStop, emaBasedStop)
    : Math.max(swingBasedStop, emaBasedStop);

  // Sanity checks: stop must be reasonably far from entry
  if (direction === 'bullish' && stop >= price * 0.995) {
    stop = price * 0.96;
  }
  if (direction === 'bearish' && stop <= price * 1.005) {
    stop = price * 1.04;
  }
  
  // ─── TAKE PROFIT: Next major structure level ─────────────────
  const target = direction === 'bullish'
    ? levels.resistance || price * 1.04
    : levels.support || price * 0.96;
  
  // ─── RISK:REWARD VALIDATION ────────────────────────────────
  const rr = Math.abs(target - price) / Math.abs(price - stop);
  if (rr < (CONFIG.RISK?.MIN_RR || 1.5) || rr > 10 || !isFinite(rr)) return null;

  return {
    type: 'Trend Continuation',
    direction,
    quality: trend.alignment ? 'A' : 'B+',
    entry: price,
    stop,
    target,
    rr,
    timeframe: '15M-1H',
    maxHold: '8-16 hours',
    note: trend.alignment ? 'Aligned trend pullback' : 'Single TF trend — caution',
    invalidation: `Break of ${direction === 'bullish' ? 'swing low/EMA50' : 'swing high/EMA50'} at $${stop.toFixed(4)}`,
    confidence: trend.alignment ? 'high' : 'medium',
    context: nearFib ? `Near ${fibLevel} Fib` : nearEma20 ? 'Near EMA20' : 'Near EMA50',
  };
}
