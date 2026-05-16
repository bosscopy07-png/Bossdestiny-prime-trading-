import { CONFIG } from '../../config/index.js';

export function detectLiquiditySweep(analysis) {
  const { sweep, levels, trend, price, momentum, volume, structure } = analysis;
  
  if (!sweep?.bullish && !sweep?.bearish && !sweep?.weakBullish && !sweep?.weakBearish) {
    return null;
  }

  const volRatio = volume?.ratio || 0;
  if (volRatio < 0.5) return null;

  const isBullish = sweep.bullish || sweep.weakBullish;
  const isStrong = sweep.bullish || sweep.bearish;
  const direction = isBullish ? 'bullish' : 'bearish';

  const rsi = momentum?.rsi?.value || 50;
  const rsiOk = (direction === 'bullish' && rsi < 65) || (direction === 'bearish' && rsi > 35);
  const macdOk = momentum?.macd?.trend?.includes(direction === 'bullish' ? 'bull' : 'bear') || 
                 momentum?.macd?.crossover !== 'none';
  
  if (!rsiOk && !macdOk) return null;

  const stopBuffer = isStrong ? 0.975 : 0.96;
  const stop = sweep.level * (direction === 'bullish' ? stopBuffer : 1 / stopBuffer);

  const sweepDepth = Math.abs(price - sweep.level);
  const tp1Distance = Math.max(sweepDepth * 2, Math.abs(levels.resistance - levels.support) * 0.5);
  
  const target = direction === 'bullish'
    ? Math.max(price + tp1Distance, levels.resistance * 1.03, price * 1.05)
    : Math.min(price - tp1Distance, levels.support * 0.97, price * 0.95);

  const tp2Distance = tp1Distance * 1.5;
  const takeProfit2 = direction === 'bullish'
    ? Math.max(target + (tp2Distance - tp1Distance), price * 1.08)
    : Math.min(target - (tp2Distance - tp1Distance), price * 0.92);

  const rr = Math.abs(target - price) / Math.abs(price - stop);
  const minRR = isStrong ? 1.8 : 2.0;
  if (rr < minRR) return null;

  const momentumAligned = (direction === 'bullish' && rsi < 50) || 
                          (direction === 'bearish' && rsi > 50);

  return {
    type: 'Liquidity Sweep',
    direction,
    quality: isStrong && momentumAligned ? 'A' : isStrong ? 'A-' : 'B+',
    entry: price,
    stop,
    target,
    rr,
    timeframe: '1H-4H',
    maxHold: '8-16 hours',
    note: isStrong ? 'Clean liquidity grab — swing to next S/R' : 'Weak sweep — manage tight, scale early',
    invalidation: `Close beyond $${stop.toFixed(4)} (${((Math.abs(stop - price) / price) * 100).toFixed(1)}%)`,
    confidence: isStrong ? 'high' : 'medium',
    context: isStrong ? 'Strong sweep with momentum' : 'Weak sweep — caution',
    warning: !isStrong ? 'Weak sweep — reduce size 50%' : null,
    takeProfit2,
  };
}
