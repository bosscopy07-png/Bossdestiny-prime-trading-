// ==========================================
// MOMENTUM ANALYSIS MODULE
// RSI + MACD with divergence detection
// ==========================================

import { calculateEMA } from '../utils/math.js';

/**
 * Calculate RSI with trend and condition
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
  if (currentRSI > 65) condition = 'overbought';
  else if (currentRSI < 35) condition = 'oversold';
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
 * Detect RSI divergence (bullish/bearish)
 */
function detectRSIDivergence(prices, rsiValues) {
  if (prices.length < 15 || rsiValues.length < 15) {
    return { bullish: false, bearish: false, strength: 0 };
  }

  const p1 = prices[prices.length - 10];
  const p2 = prices[prices.length - 1];
  const r1 = rsiValues[rsiValues.length - 10];
  const r2 = rsiValues[rsiValues.length - 1];

  const bullish = p2 < p1 && r2 > r1 && r2 < 70 && r1 < 60;
  const bearish = p2 > p1 && r2 < r1 && r2 > 30 && r1 > 40;

  return {
    bullish,
    bearish,
    strength: Math.abs(r2 - r1),
  };
}

/**
 * Calculate MACD with histogram analysis
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
  
  let trend = 'neutral';
  if (currentHist > prevHist && currentHist > 0) trend = 'bullish';
  else if (currentHist < prevHist && currentHist < 0) trend = 'bearish';
  else if (currentHist > 0) trend = 'weak_bullish';
  else if (currentHist < 0) trend = 'weak_bearish';

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
