// ==========================================
// LIQUIDITY SWEEP SETUP DETECTOR
// RELAXED: OR condition for momentum, accepts weak sweeps
// ==========================================

import { CONFIG } from '../../config/index.js';

export function detectLiquiditySweep(analysis) {
  const { sweep, levels, trend, price, momentum } = analysis;
  
  if (!sweep?.bullish && !sweep?.bearish && !sweep?.weakBullish && !sweep?.weakBearish) {
    return null;
  }

  const isBullish = sweep.bullish || sweep.weakBullish;
  const isStrong = sweep.bullish || sweep.bearish;
  const direction = isBullish ? 'bullish' : 'bearish';
  
  // RELAXED: OR condition — only need one momentum confirmation
  const rsi = momentum?.rsi?.value || 50;
  const rsiOk = (direction === 'bullish' && rsi < 65) || (direction === 'bearish' && rsi > 35);
  const macdOk = momentum?.macd?.trend?.includes(direction === 'bullish' ? 'bull' : 'bear');
  
  if (!rsiOk && !macdOk) return null;  // Was: && — now OR via this logic

  // RELAXED: Wider stop for weak sweeps
  const stopBuffer = isStrong ? 0.985 : 0.98;
  const stop = sweep.level * (direction === 'bullish' ? stopBuffer : 1 / stopBuffer);
  
  const target = direction === 'bullish' ? levels.resistance : levels.support;
  const rr = Math.abs(target - price) / Math.abs(price - stop);

  // RELAXED: Lower R:R for weak sweeps if structure is good
  const minRR = isStrong ? CONFIG.RISK.MIN_RR : 1.5;
  if (rr < minRR) return null;

  return {
    type: 'Liquidity Sweep',
    direction,
    quality: isStrong ? 'A' : 'B+',
    entry: price,
    stop,
    target,
    rr,
    timeframe: '5M-15M',
    note: isStrong ? 'Clean liquidity grab' : 'Weak sweep — manage tight',
    invalidation: `Close beyond $${stop.toFixed(4)}`,
    confidence: isStrong ? 'high' : 'medium',
  };
}
