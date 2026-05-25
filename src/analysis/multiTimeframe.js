// ==========================================
// MULTI-TIMEFRAME CONFLUENCE MODULE
// Aggregates analysis across timeframes
// ==========================================

import { analyzeTrend } from './trend.js';
import { calculateRSI, calculateMACD } from './momentum.js';
import { analyzeVolume } from './volume.js';
import { findKeyLevels, calculateFibonacci } from './levels.js';
import { analyzeStructure, detectLiquiditySweep } from './structure.js';
import { calculateATR } from '../utils/math.js';

/**
 * Run full analysis on single timeframe
 * @param {number[][]} ohlcv 
 * @param {string} timeframe 
 */
export function runTimeframeAnalysis(ohlcv, timeframe = '15m') {
  if (!ohlcv || ohlcv.length < 30) return null;

  const closes = ohlcv.map(c => c[4]);
  const currentPrice = closes[closes.length - 1];

  const trend = analyzeTrend(ohlcv);
  const rsi = calculateRSI(closes);
  const macd = calculateMACD(closes);
  const volume = analyzeVolume(ohlcv);
  const levels = findKeyLevels(ohlcv);
  const structure = analyzeStructure(ohlcv);
  const sweep = detectLiquiditySweep(ohlcv, levels);
  const atr = calculateATR(ohlcv);

  let fibonacci = null;
  if (levels.support && levels.resistance) {
    fibonacci = calculateFibonacci(levels.resistance, levels.support);
  }

  return {
    timeframe,
    price: currentPrice,
    trend,
    momentum: { rsi, macd },
    volume,
    levels,
    structure,
    sweep,
    fibonacci,
    atr,
    timestamp: Date.now(),
  };
}

/**
 * Build multi-timeframe confluence object
 * @param {object} primary - 15m analysis
 * @param {object} higher - 1h analysis
 * @param {object|null} fourHour - 4h analysis (optional)
 */
export function buildMultiTimeframe(primary, higher, fourHour = null) {
  const alignment = primary?.trend?.primary === higher?.trend?.primary && 
                    primary?.trend?.primary !== 'neutral' &&
                    higher?.trend?.strength > 30;

  return {
    primary: primary?.trend || { primary: 'neutral', strength: 0 },
    higherTF: higher?.trend || { primary: 'neutral', strength: 0 },
    fourHour: fourHour?.trend || { primary: 'neutral', strength: 0 },
    alignment,
    allBullish: [primary, higher, fourHour].every(t => !t || t.trend?.primary === 'bullish'),
    allBearish: [primary, higher, fourHour].every(t => !t || t.trend?.primary === 'bearish'),
  };
}
