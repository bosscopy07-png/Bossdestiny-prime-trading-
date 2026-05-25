// ==========================================
// POSITION SIZING MODULE
// Dynamic risk-based sizing — leverage is signal-driven, not capped
// VERSION: 3.3-community
// ==========================================

import { CONFIG } from '../config/index.js';
import { riskLogger } from '../utils/logger.js';

/**
 * Calculate position size based on setup quality, confidence, and risk parameters
 * @param {Object} setup - Strategy setup with entry, stop, target, rr
 * @param {Object} confidence - Confidence score object
 * @param {Object} atr - ATR data
 * @param {number} currentCapital - Available trading capital
 * @param {Object} streakData - Win/loss streak and daily P&L tracking
 * @returns {Object|null} Position sizing or null if invalid
 */
export function calculatePosition(setup, confidence, atr, currentCapital, streakData = {}) {
  const { winStreak = 0, lossStreak = 0, dailyPnL = 0 } = streakData;

  // ─── GUARD: Minimum R:R ─────────────────────────────────────
  const rr = setup.rr || 1;
  if (rr < 1.2) {
    riskLogger.warn(`R:R ${rr.toFixed(2)} below minimum 1.2 — rejecting position`);
    return null;
  }

  // ─── BASE RISK % (0.3% to 5%) ─────────────────────────────
  let riskPct = 0.3 + (confidence.score / 100) * 4.7;
  
  // Streak adjustments
  if (winStreak > 0) riskPct += Math.min(winStreak * 0.5, 2.0);
  if (lossStreak > 0) riskPct -= lossStreak * 0.3;
  
  // Kelly criterion adjustment (fractional Kelly 0.5)
  const kellyFraction = (rr - 1) / (rr + 1);
  riskPct *= (0.5 + Math.max(0, kellyFraction));
  
  // Daily P&L circuit breaker
  const dailyBuffer = currentCapital * 0.05;
  if (dailyPnL > dailyBuffer) riskPct *= 1.1;
  else if (dailyPnL < -dailyBuffer) riskPct *= 0.7;
  
  // Clamp: 0.2% minimum, 8% maximum
  riskPct = Math.max(0.2, Math.min(riskPct, 8.0));
  riskPct = Math.round(riskPct * 100) / 100;

  const riskAmount = currentCapital * (riskPct / 100);
  const riskPrice = Math.abs(setup.entry - setup.stop);
  
  // ─── GUARD: Valid stop distance ─────────────────────────────
  if (riskPrice <= 0 || riskPrice / setup.entry > 0.15) {
    riskLogger.warn(`Invalid risk: entry=${setup.entry}, stop=${setup.stop}`);
    return null;
  }

  // ─── LEVERAGE CALCULATION ───────────────────────────────────
  // Base: 3x at 40 confidence, scales up/down
  let leverage = Math.max(1, 3 + (confidence.score - 40) * 0.4);
  const atrPct = atr?.percent || 2;
  
  // ATR adjustments
  if (atrPct < 1) leverage *= 1.5;
  else if (atrPct < 2) leverage *= 1.2;
  else if (atrPct > 5) leverage *= 0.4;
  else if (atrPct > 4) leverage *= 0.6;
  else if (atrPct > 3) leverage *= 0.8;
  
  // R:R adjustments
  if (rr >= 4) leverage *= 1.4;
  else if (rr >= 3) leverage *= 1.2;
  else if (rr >= 2.5) leverage *= 1.1;
  else if (rr < 1.5) leverage *= 0.5;
  
  // Streak adjustments
  if (winStreak >= 3) leverage *= 1.2;
  else if (winStreak >= 2) leverage *= 1.1;
  if (lossStreak >= 3) leverage *= 0.5;
  else if (lossStreak >= 2) leverage *= 0.7;
  
  leverage = Math.max(1, Math.round(leverage));

  const baseQty = riskAmount / riskPrice;
  const notionalValue = baseQty * setup.entry;
  const margin = notionalValue / leverage;

  // ─── GUARD: Margin cap (60% of capital) ───────────────────
  if (margin > currentCapital * 0.9) {
    riskLogger.warn(`Margin $${margin.toFixed(2)} > 90% capital, reducing`);
    const adjustedLeverage = Math.max(1, Math.ceil(notionalValue / (currentCapital * 0.6)));
    leverage = adjustedLeverage;
  }

  const priceDiff = Math.abs(setup.target - setup.entry);
  const estProfit = baseQty * priceDiff;
  const estLoss = riskAmount;

  return {
    riskPct,
    riskAmount: riskAmount.toFixed(2),
    leverage,
    baseQty: baseQty.toFixed(6),
    notionalValue: notionalValue.toFixed(2),
    margin: margin.toFixed(2),
    estProfit: estProfit.toFixed(2),
    estLoss: estLoss.toFixed(2),
    unit: 'base',
    meta: {
      winStreakApplied: winStreak,
      lossStreakApplied: lossStreak,
      kellyFraction: kellyFraction.toFixed(3),
      atrDiscount: atrPct.toFixed(2) + '%',
    },
  };
                                   }
