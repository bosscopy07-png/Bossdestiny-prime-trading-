// ==========================================
// MATHEMATICAL UTILITIES
// Pure functions, zero side effects
// ==========================================

/**
 * Calculate EMA series from price array
 * @param {number[]} prices - Array of prices
 * @param {number} period - EMA period
 * @returns {number[]|null} EMA values or null if insufficient data
 */
export function calculateEMA(prices, period) {
  if (!Array.isArray(prices) || prices.length < period) return null;

  const k = 2 / (period + 1);
  const ema = [];
  
  // Start with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += prices[i];
  }
  ema.push(sum / period);

  for (let i = period; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[ema.length - 1] * (1 - k));
  }

  return ema;
}

/**
 * Calculate SMA
 * @param {number[]} prices 
 * @param {number} period 
 */
export function calculateSMA(prices, period) {
  if (!Array.isArray(prices) || prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Standard deviation
 */
export function calculateStdDev(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period;
  return Math.sqrt(variance);
}

/**
 * Clamp value between min and max
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Round to N decimal places
 */
export function round(value, decimals = 4) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Percentage change
 */
export function pctChange(current, previous) {
  if (!previous || previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

/**
 * Average true range from OHLCV
 * @param {number[][]} ohlcv - [[ts, open, high, low, close, volume], ...]
 * @param {number} period 
 */
export function calculateATR(ohlcv, period = 14) {
  if (!Array.isArray(ohlcv) || ohlcv.length < period + 1) {
    return { value: 0, percent: 0 };
  }

  const trs = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const high = ohlcv[i][2];
    const low = ohlcv[i][3];
    const prevClose = ohlcv[i - 1][4];
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }

  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  const currentPrice = ohlcv[ohlcv.length - 1][4];
  const atrPercent = (atr / currentPrice) * 100;

  return {
    value: round(atr, 8),
    percent: round(atrPercent, 2),
  };
}

/**
 * Linear regression slope
 */
export function linearRegressionSlope(values, period) {
  if (!Array.isArray(values) || values.length < period) return 0;
  
  const slice = values.slice(-period);
  const n = slice.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += slice[i];
    sumXY += i * slice[i];
    sumX2 += i * i;
  }
  
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  
  return (n * sumXY - sumX * sumY) / denom;
}

/**
 * Normalize value to 0-100 scale
 */
export function normalizeScore(value, min, max) {
  if (max === min) return 50;
  return clamp(((value - min) / (max - min)) * 100, 0, 100);
                  }
