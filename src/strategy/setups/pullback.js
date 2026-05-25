import { CONFIG } from '../../config/index.js';

/**
 * S/R Pullback Setup Detection
 * Detects bounces from tested support/resistance levels.
 * Allows counter-trend at strong S/R (2+ touches).
 * 
 * @param {Object} analysis - Full market analysis object
 * @param {Object} analysis.levels - Key S/R levels with touch counts
 * @param {number} analysis.price - Current price
 * @param {Object} analysis.trend - Trend data
 * @param {Object} analysis.momentum - Momentum indicators
 * @param {Object} analysis.atr - ATR data
 * @returns {Object|null} Setup object or null if no valid setup
 */
export function detectPullback(analysis) {
  const { levels, price, trend, momentum, atr } = analysis;
  
  // ─── GUARD: Must be near support or resistance ──────────────
  if (!levels.nearSupport && !levels.nearResistance) return null;
  
  const atSupport = levels.nearSupport;
  const direction = atSupport ? 'bullish' : 'bearish';
  
  // ─── TREND FILTER: Allow counter-trend at strong S/R ────────
  const srStrength = atSupport ? levels.supportTouches : levels.resistanceTouches;
  if (trend?.primary !== 'neutral' && trend?.primary !== direction) {
    if (trend?.strength > 70 && srStrength < 2) return null;
  }

  // ─── RSI FILTER: Broader pullback zones ─────────────────────
  const rsi = momentum?.rsi?.value || 50;
  const rsiOk = atSupport ? rsi < 60 : rsi > 40;
  if (!rsiOk) return null;

  // ─── STOP LOSS: Below/above S/R level + ATR buffer ───────────
  const atrBuffer = (atr?.value || price * 0.015) * 1.0;
  
  const stop = atSupport
    ? levels.support - atrBuffer
    : levels.resistance + atrBuffer;
  
  // ─── TAKE PROFIT: Next major level or pivot ─────────────────
  const target = atSupport
    ? (levels.pivot || levels.resistance)
    : (levels.pivot || levels.support);
  
  // ─── RISK:REWARD VALIDATION ────────────────────────────────
  const rr = Math.abs(target - price) / Math.abs(price - stop);
  if (rr < (CONFIG.RISK?.MIN_RR || 1.5) || rr > 10 || !isFinite(rr)) return null;

  return {
    type: 'S/R Pullback',
    direction,
    quality: srStrength >= 2 ? 'A' : 'B+',
    entry: price,
    stop,
    target,
    rr,
    timeframe: '15M-30M',
    maxHold: '4-12 hours',
    note: `Bounce from ${atSupport ? 'support' : 'resistance'}${srStrength >= 2 ? ' (tested)' : ''}`,
    invalidation: `Close beyond ${atSupport ? 'support' : 'resistance'} at $${stop.toFixed(4)}`,
    confidence: srStrength >= 2 ? 'high' : 'medium',
  };
}
