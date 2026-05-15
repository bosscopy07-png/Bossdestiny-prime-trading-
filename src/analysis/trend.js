// ==========================================
// TREND ANALYSIS MODULE
// EMA-based trend detection with strength scoring
// ==========================================

import { calculateEMA, calculateSMA, clamp } from '../utils/math.js';
import { analysisLogger } from '../utils/logger.js';

/**
 * Analyze trend from OHLCV data
 * @param {number[][]} ohlcv - CCXT OHLCV format
 * @returns {object} Trend analysis result
 */
export function analyzeTrend(ohlcv) {
  if (!ohlcv || ohlcv.length < 50) {
    return { primary: 'neutral', strength: 0, alignment: false };
  }

  const closes = ohlcv.map(c => c[4]);
  const highs = ohlcv.map(c => c[2]);
  const lows = ohlcv.map(c => c[3]);

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);

  if (!ema20 || !ema50) {
    return { primary: 'neutral', strength: 0, alignment: false };
  }

  const currentPrice = closes[closes.length - 1];
  const ema20Current = ema20[ema20.length - 1];
  const ema50Current = ema50[ema50.length - 1];
  const ema200Current = ema200?.[ema200.length - 1];

  // Price action patterns
  const higherHighs = countHigherHighs(highs.slice(-20));
  const higherLows = countHigherLows(lows.slice(-20));
  const lowerHighs = countLowerHighs(highs.slice(-20));
  const lowerLows = countLowerLows(lows.slice(-20));

  // Scoring
  let bullishScore = 0;
  let bearishScore = 0;

  if (ema20Current > ema50Current) bullishScore += 1;
  if (ema20Current < ema50Current) bearishScore += 1;
  
  if (higherHighs > lowerHighs && higherLows > lowerLows) bullishScore += 1;
  if (lowerHighs > higherHighs && lowerLows > higherLows) bearishScore += 1;
  
  if (currentPrice > ema50Current) bullishScore += 1;
  if (currentPrice < ema50Current) bearishScore += 1;

  let primary = 'neutral';
  let strength = 0;
  let alignment = false;

  if (bullishScore >= 2) {
    primary = 'bullish';
    strength = Math.round((bullishScore / 3) * 100);
    alignment = ema200Current ? currentPrice > ema200Current : true;
  } else if (bearishScore >= 2) {
    primary = 'bearish';
    strength = Math.round((bearishScore / 3) * 100);
    alignment = ema200Current ? currentPrice < ema200Current : true;
  }

  // EMA slope as momentum indicator
  const slope = ema20.length > 5 
    ? ((ema20Current - ema20[ema20.length - 5]) / ema20Current) * 100 
    : 0;

  return {
    primary,
    strength,
    alignment,
    ema20: ema20Current,
    ema50: ema50Current,
    ema200: ema200Current,
    slope: round(slope, 3),
    higherHighs,
    higherLows,
    lowerHighs,
    lowerLows,
  };
}

function countHigherHighs(highs) {
  let count = 0;
  for (let i = 2; i < highs.length; i++) {
    if (highs[i] > highs[i-1] && highs[i-1] > highs[i-2]) count++;
  }
  return count;
}

function countHigherLows(lows) {
  let count = 0;
  for (let i = 2; i < lows.length; i++) {
    if (lows[i] > lows[i-1] && lows[i-1] > lows[i-2]) count++;
  }
  return count;
}

function countLowerHighs(highs) {
  let count = 0;
  for (let i = 2; i < highs.length; i++) {
    if (highs[i] < highs[i-1] && highs[i-1] < highs[i-2]) count++;
  }
  return count;
}

function countLowerLows(lows) {
  let count = 0;
  for (let i = 2; i < lows.length; i++) {
    if (lows[i] < lows[i-1] && lows[i-1] < lows[i-2]) count++;
  }
  return count;
}

function round(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
