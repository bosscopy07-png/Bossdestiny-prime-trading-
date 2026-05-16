// ==========================================
// POSITION SIZING MODULE
// Dynamic risk-based sizing — leverage is signal-driven, not capped
// VERSION: 3.3-community
// ==========================================

import { CONFIG } from '../config/index.js';
import { riskLogger } from '../utils/logger.js';

export function calculatePosition(setup, confidence, atr, currentCapital, streakData = {}) {
  const { winStreak = 0, lossStreak = 0, dailyPnL = 0 } = streakData;

  let riskPct = 0.3 + (confidence.score / 100) * 4.7;
  
  if (winStreak > 0) riskPct += Math.min(winStreak * 0.5, 2.0);
  if (lossStreak > 0) riskPct -= lossStreak * 0.3;
  
  const rr = setup.rr || 1;
  const kellyFraction = (rr - 1) / (rr + 1);
  riskPct *= (0.5 + kellyFraction);
  
  const dailyBuffer = currentCapital * 0.05;
  if (dailyPnL > dailyBuffer) riskPct *= 1.1;
  else if (dailyPnL < -dailyBuffer) riskPct *= 0.7;
  
  riskPct = Math.max(0.2, Math.min(riskPct, 8.0));
  riskPct = Math.round(riskPct * 100) / 100;

  const riskAmount = currentCapital * (riskPct / 100);
  const riskPrice = Math.abs(setup.entry - setup.stop);
  
  if (riskPrice <= 0 || riskPrice / setup.entry > 0.15) {
    riskLogger.warn(`Invalid risk: entry=${setup.entry}, stop=${setup.stop}`);
    return null;
  }

  let leverage = 3 + (confidence.score - 40) * 0.4;
  const atrPct = atr?.percent || 2;
  
  if (atrPct < 1) leverage *= 1.5;
  else if (atrPct < 2) leverage *= 1.2;
  else if (atrPct > 5) leverage *= 0.4;
  else if (atrPct > 4) leverage *= 0.6;
  else if (atrPct > 3) leverage *= 0.8;
  
  if (rr >= 4) leverage *= 1.4;
  else if (rr >= 3) leverage *= 1.2;
  else if (rr >= 2.5) leverage *= 1.1;
  else if (rr < 1.5) leverage *= 0.5;
  
  if (winStreak >= 3) leverage *= 1.2;
  else if (winStreak >= 2) leverage *= 1.1;
  if (lossStreak >= 3) leverage *= 0.5;
  else if (lossStreak >= 2) leverage *= 0.7;
  
  leverage = Math.max(1, Math.round(leverage));

  const baseQty = riskAmount / riskPrice;
  const notionalValue = baseQty * setup.entry;
  const margin = notionalValue / leverage;

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
    margin: (notionalValue / leverage).toFixed(2),
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
