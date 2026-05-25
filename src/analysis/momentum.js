// ==========================================
// MOMENTUM ANALYSIS MODULE
// RSI + MACD with divergence detection
// ==========================================

import { calculateEMA } from '../utils/math.js';

/**
 * Calculate RSI with trend and condition
 * @param {number[]} prices - Close prices
 * @param {number} period - RSI period (default 14)
 */
export function calculateRSI(prices, period = 14) {
  if (!prices || prices.length < period + 5) {
    return { value: 50, trend: 'neutral', condition: 'neutral', divergence: null };
  }

  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  let gains = 0, losses = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) gains += changes[i];
    else losses += Math.abs(changes[i]);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  const rsiValues = [];
  let rs = avgGain / (avgLoss || 0.001);
  rsiValues.push(100 - (100 / (1 + rs)));

  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    
    rs = avgGain / (avgLoss || 0.001);
    rsiValues.push(100 - (100 / (1 + rs)));
  }

  const currentRSI = rsiValues[rsiValues.length - 1];
  const prevRSI = rsiValues[rsiValues.length - 3] || currentRSI;
  
  let condition = 'neutral';
  if (currentRSI > 70) condition = 'overbought';
  else if (currentRSI < 30) condition = 'oversold';
  else if (currentRSI > 55) condition = 'bullish';
  else if (currentRSI < 45) condition = 'bearish';

  return {
    value: Math.round(currentRSI * 10) / 10,
    trend: currentRSI > prevRSI ? 'rising' : 'falling',
    condition,
    divergence: detectRSIDivergence(prices, rsiValues),
  };
}

/**
 * Detect RSI divergence using swing points
 * @param {number[]} prices 
 * @param {number[]} rsiValues 
 */
function detectRSIDivergence(prices, rsiValues) {
  if (prices.length < 15 || rsiValues.length < 15) {
    return { bullish: false, bearish: false, strength: 0 };
  }

  // Find swing points in last 15 candles
  let priceLowIdx = prices.length - 15;
  let priceHighIdx = prices.length - 15;
  let rsiLowIdx = rsiValues.length - 15;
  let rsiHighIdx = rsiValues.length - 15;

  for (let i = prices.length - 14; i < prices.length; i++) {
    if (prices[i] < prices[priceLowIdx]) priceLowIdx = i;
    if (prices[i] > prices[priceHighIdx]) priceHighIdx = i;
    if (rsiValues[i - (prices.length - rsiValues.length)] < rsiValues[rsiLowIdx]) rsiLowIdx = i - (prices.length - rsiValues.length);
    if (rsiValues[i - (prices.length - rsiValues.length)] > rsiValues[rsiHighIdx]) rsiHighIdx = i - (prices.length - rsiValues.length);
  }

  const pLow = prices[priceLowIdx];
  const pHigh = prices[priceHighIdx];
  const rLow = rsiValues[rsiLowIdx];
  const rHigh = rsiValues[rsiHighIdx];

  const pPrevLow = prices[priceLowIdx - 5] || pLow;
  const pPrevHigh = prices[priceHighIdx - 5] || pHigh;
  const rPrevLow = rsiValues[rsiLowIdx - 5] || rLow;
  const rPrevHigh = rsiValues[rsiHighIdx - 5] || rHigh;

  // Bullish divergence: price makes lower low, RSI makes higher low
  const bullish = pLow < pPrevLow && rLow > rPrevLow && rLow < 60 && rPrevLow < 60;
  // Bearish divergence: price makes higher high, RSI makes lower high
  const bearish = pHigh > pPrevHigh && rHigh < rPrevHigh && rHigh > 40 && rPrevHigh > 40;

  return {
    bullish,
    bearish,
    strength: Math.abs(rHigh - rLow),
  };
}

/**
 * Calculate MACD with histogram analysis
 * @param {number[]} prices - Close prices
 * @param {number} fast - Fast EMA period
 * @param {number} slow - Slow EMA period
 * @param {number} signal - Signal EMA period
 */
export function calculateMACD(prices, fast = 12, slow = 26, signal = 9) {
  if (!prices || prices.length < slow + signal) return null;

  const ema12 = calculateEMA(prices, fast);
  const ema26 = calculateEMA(prices, slow);
  
  if (!ema12 || !ema26) return null;

  const macdLine = [];
  const startIdx = ema26.length - ema12.length;
  
  for (let i = 0; i < ema12.length; i++) {
    macdLine.push(ema12[i] - ema26[i + startIdx]);
  }

  const signalLine = calculateEMA(macdLine, signal);
  if (!signalLine) return null;

  const histogram = macdLine.slice(-signalLine.length).map((v, i) => v - signalLine[i]);
  
  const currentHist = histogram[histogram.length - 1];
  const prevHist = histogram[histogram.length - 2];
  const prevPrevHist = histogram[histogram.length - 3] || prevHist;
  
  // FIX: Improved trend detection for histogram
  let trend = 'neutral';
  if (currentHist > 0 && currentHist > prevHist) {
    trend = 'bullish';
  } else if (currentHist > 0 && currentHist <= prevHist) {
    trend = 'weak_bullish';
  } else if (currentHist < 0 && currentHist < prevHist) {
    trend = 'bearish';
  } else if (currentHist < 0 && currentHist >= prevHist) {
    trend = 'weak_bearish';
  } else if (currentHist === 0) {
    trend = 'neutral';
  }

  // Crossover detection
  let crossover = 'none';
  const macdCurrent = macdLine[macdLine.length - 1];
  const macdPrev = macdLine[macdLine.length - 2];
  const signalCurrent = signalLine[signalLine.length - 1];
  const signalPrev = signalLine[signalLine.length - 2];

  if (macdPrev < signalPrev && macdCurrent > signalCurrent) {
    crossover = 'bullish';
  } else if (macdPrev > signalPrev && macdCurrent < signalCurrent) {
    crossover = 'bearish';
  }

  const histAvg = (currentHist + prevHist + prevPrevHist) / 3;

  return {
    value: Math.round(macdCurrent * 10000) / 10000,
    signal: Math.round(signalCurrent * 10000) / 10000,
    histogram: Math.round(currentHist * 10000) / 10000,
    trend,
    crossover,
    histAvg: Math.round(histAvg * 10000) / 10000,
    momentum: Math.abs(histAvg),
  };
}
