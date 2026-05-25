import { CONFIG } from '../../config/index.js';

/**
 * Liquidity Sweep Setup Detection
 * Detects when price sweeps liquidity beyond a key level then reverses.
 * Uses ATR-based stops below the sweep level (not at it) to avoid wick stops.
 * 
 * @param {Object} analysis - Full market analysis object
 * @param {Object} analysis.sweep - Sweep detection results
 * @param {Object} analysis.levels - Key S/R levels
 * @param {number} analysis.price - Current price
 * @param {Object} analysis.momentum - Momentum indicators (RSI, MACD)
 * @param {Object} analysis.atr - ATR data for stop placement
 * @param {Object} analysis.volume - Volume data for confirmation
 * @returns {Object|null} Setup object or null if no valid setup
 */
export function detectLiquiditySweep(analysis) {
  const { sweep, levels, price, momentum, atr, volume } = analysis;
  
  // ─── GUARD: Sweep must exist ──────────────────────────────
  if (!sweep?.bullish && !sweep?.bearish && !sweep?.weakBullish && !sweep?.weakBearish) {
    return null;
  }

  // ─── GUARD: Minimum volume confirmation ───────────────────
  const volRatio = volume?.ratio || 0;
  if (volRatio < 0.5) return null;

  const isBullish = sweep.bullish || sweep.weakBullish;
  const isStrong = sweep.bullish || sweep.bearish;
  const direction = isBullish ? 'bullish' : 'bearish';

  // ─── MOMENTUM FILTERS ─────────────────────────────────────
  const rsi = momentum?.rsi?.value || 50;
  const rsiOk = (direction === 'bullish' && rsi < 65) || (direction === 'bearish' && rsi > 35);
  const macdOk = momentum?.macd?.trend?.includes(direction === 'bullish' ? 'bull' : 'bear') || 
                 momentum?.macd?.crossover !== 'none';
  
  if (!rsiOk && !macdOk) return null;

  // ─── STOP LOSS: Below sweep level + ATR buffer ──────────────
  // The sweep level is where dumb money stops are. 
  // We place SL at the NEXT structure level — where the setup is TRULY wrong.
  const atrBuffer = (atr?.value || price * 0.02) * 1.5;
  
  let stop;
  if (direction === 'bullish') {
    // For long: SL at the swing low BEFORE the sweep, or 3x ATR below sweep
    const priorSwingLow = levels.swingLows?.[1]?.price || levels.swingLows?.[0]?.price;
    const wideStop = sweep.level - atrBuffer * 2;
    
    stop = priorSwingLow 
      ? Math.min(priorSwingLow * 0.995, wideStop)
      : wideStop;
      
    // Sanity: stop shouldn't be more than 8% below entry
    if (stop < price * 0.92) stop = price * 0.92;
  } else {
    // For short: SL at swing high before sweep, or 3x ATR above
    const priorSwingHigh = levels.swingHighs?.[1]?.price || levels.swingHighs?.[0]?.price;
    const wideStop = sweep.level + atrBuffer * 2;
    
    stop = priorSwingHigh
      ? Math.max(priorSwingHigh * 1.005, wideStop)
      : wideStop;
      
    if (stop > price * 1.08) stop = price * 1.08;
  }

  // ─── TAKE PROFIT: Next major structure level ────────────────
  const target = direction === 'bullish'
    ? levels.resistance || price * 1.05
    : levels.support || price * 0.95;
  
  // ─── RISK:REWARD VALIDATION ────────────────────────────────
  const rr = Math.abs(target - price) / Math.abs(price - stop);
  const minRR = isStrong ? 1.8 : 2.0;
  if (rr < minRR || rr > 10 || !isFinite(rr)) return null;

  // ─── QUALITY ASSESSMENT ────────────────────────────────────
  const momentumAligned = (direction === 'bullish' && rsi < 50) || 
                          (direction === 'bearish' && rsi > 50);

  // ─── TP2: Extended target for strong setups ─────────────────
  const sweepDepth = Math.abs(price - sweep.level);
  const tp1Distance = Math.max(sweepDepth * 2, Math.abs(levels.resistance - levels.support) * 0.5);
  const tp2Distance = tp1Distance * 1.5;
  const takeProfit2 = direction === 'bullish'
    ? Math.max(target + (tp2Distance - tp1Distance), price * 1.08)
    : Math.min(target - (tp2Distance - tp1Distance), price * 0.92);

  return {
    type: 'Liquidity Sweep',
    direction,
    quality: isStrong && momentumAligned ? 'A' : isStrong ? 'A-' : 'B+',
    entry: price,
    stop,
    target,
    rr,
    takeProfit2,
    timeframe: '5M-15M',
    maxHold: '2-8 hours',
    note: isStrong ? 'Clean liquidity grab — swing to next S/R' : 'Weak sweep — manage tight, scale early',
    invalidation: `Close beyond structural level at $${stop.toFixed(4)} (${((Math.abs(stop - price) / price) * 100).toFixed(1)}%)`,
    confidence: isStrong ? 'high' : 'medium',
    context: isStrong ? 'Strong sweep with momentum' : 'Weak sweep — caution',
    warning: !isStrong ? 'Weak sweep — reduce size 50%' : null,
  };
      }
    
