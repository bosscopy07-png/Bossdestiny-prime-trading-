import { CONFIG } from '../../config/index.js';

/**
 * Breakout Setup Detection
 * Detects clean breakouts with volume confirmation.
 * Uses ATR-based stops below the broken structure level.
 * 
 * @param {Object} analysis - Full market analysis object
 * @param {Object} analysis.structure - Market structure (BOS, strength)
 * @param {Object} analysis.volume - Volume data
 * @param {Object} analysis.levels - Key S/R levels
 * @param {Object} analysis.momentum - Momentum indicators
 * @param {number} analysis.price - Current price
 * @param {Object} analysis.atr - ATR data
 * @param {number[][]} analysis.ohlcv - Recent OHLCV data
 * @returns {Object|null} Setup object or null if no valid setup
 */
export function detectBreakout(analysis) {
  const { structure, volume, levels, momentum, price, atr, ohlcv } = analysis;
  
  // ─── GUARD: Structure break must exist ──────────────────────
  if (structure?.bos === 'none') return null;

  // ─── GUARD: Volume confirmation ─────────────────────────────
  const volRatio = volume?.ratio || 1;
  if (volRatio < 1.3) return null;

  const direction = structure.bos.includes('bullish') ? 'bullish' : 'bearish';
  
  // ─── MOMENTUM ALIGNMENT ───────────────────────────────────
  const macdAligns = momentum?.macd?.trend?.includes(direction === 'bullish' ? 'bull' : 'bear');
  if (!macdAligns && volRatio < 1.5) return null;

  // ─── AVOID OVEREXTENDED ENTRIES ─────────────────────────────
  const recentCandles = ohlcv?.slice(-3) || [];
  if (recentCandles.length >= 2) {
    const lastClose = recentCandles[recentCandles.length - 1][4];
    const prevClose = recentCandles[recentCandles.length - 2][4];
    const pctMove = Math.abs((lastClose - prevClose) / prevClose) * 100;
    if (pctMove > 5) return null;
  }

  // ─── STOP LOSS: Below broken structure + ATR buffer ─────────
  const atrBuffer = (atr?.value || price * 0.015) * 1.0;
  
  const breakoutLevel = direction === 'bullish'
    ? structure.breakLevel || levels.pivot || levels.support
    : structure.breakLevel || levels.pivot || levels.resistance;
  
  const stop = direction === 'bullish'
    ? breakoutLevel - atrBuffer
    : breakoutLevel + atrBuffer;

  // ─── TAKE PROFIT: Measured move (1.618x range height) ──────
  const rangeHeight = levels.range || price * 0.03;
  const target = direction === 'bullish'
    ? price + rangeHeight * 1.618
    : price - rangeHeight * 1.618;
  
  // ─── RISK:REWARD VALIDATION ────────────────────────────────
  const rr = Math.abs(target - price) / Math.abs(price - stop);
  if (rr < (CONFIG.RISK?.MIN_RR || 1.5) || rr > 10 || !isFinite(rr)) return null;

  const isClean = volRatio > 1.8 && structure.strength > 60;

  return {
    type: 'Breakout Play',
    direction,
    quality: isClean ? 'A' : 'B+',
    entry: price,
    stop,
    target,
    rr,
    timeframe: '1H-4H',
    maxHold: '8-24 hours',
    note: isClean ? 'Clean BOS with volume — swing target' : 'Moderate breakout — manage on lower TF',
    invalidation: `Close back beyond ${direction === 'bullish' ? 'breakout' : 'breakdown'} level at $${stop.toFixed(4)}`,
    confidence: isClean ? 'high' : 'medium',
    context: volRatio > 2 ? 'High volume breakout' : 'Standard breakout',
  };
            }
