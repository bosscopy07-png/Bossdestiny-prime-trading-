// ==========================================
// POSITION SIZING MODULE
// Risk-based sizing with capital protection
// RELAXED: Tier-aware sizing, R:R-adjusted, safer leverage
// ==========================================

import { CONFIG } from '../config/index.js';
import { riskLogger } from '../utils/logger.js';

/**
 * Calculate position parameters from setup and analysis
 * RELAXED: Smoother risk curve, tier-aware, R:R-adjusted
 */
export function calculatePosition(setup, confidence, atr, currentCapital) {
  // ─── BASE RISK PERCENTAGE ───────────────────────────────────
  // Smooth curve instead of cliffs. Every 5 points = 0.25% risk
  let riskPct = 0.5 + (confidence.score / 5) * 0.25;
  
  // Tier floor: C+ gets minimum 0.75%, B gets 1.0%, A gets 1.5%+
  const tierMinimums = { 'D': 0, 'C': 0.5, 'C+': 0.75, 'B': 1.0, 'B+': 1.25, 'A': 1.5, 'A+': 2.0 };
  const tierMin = tierMinimums[confidence.tier] || 0.5;
  riskPct = Math.max(riskPct, tierMin);
  
  // R:R multiplier: Excellent R:R = slightly more risk
  const rr = setup.rr || 1;
  if (rr >= 3) riskPct *= 1.2;
  else if (rr >= 2.5) riskPct *= 1.1;
  else if (rr < 1.5) riskPct *= 0.7;  // Reduce risk for poor R:R
  
  // Hard cap
  riskPct = Math.min(riskPct, CONFIG.RISK.MAX_RISK_PER_TRADE_PCT || 3);
  riskPct = Math.round(riskPct * 100) / 100;  // Round to 2 decimals

  const riskAmount = currentCapital * (riskPct / 100);
  const riskPrice = Math.abs(setup.entry - setup.stop);
  
  if (riskPrice <= 0 || riskPrice / setup.entry > 0.1) {
    riskLogger.warn(`Invalid risk: stop ${setup.stop}, entry ${setup.entry}, risk% ${(riskPrice/setup.entry*100).toFixed(2)}%`);
    return null;
  }

  // Position size in BASE currency (BTC, ETH, etc.)
  const basePositionSize = riskAmount / riskPrice;
  
  // Notional value in QUOTE currency (USDT)
  const notionalValue = basePositionSize * setup.entry;

  // Leverage calculation
  const leverage = calculateLeverage(confidence, atr, setup, riskPct);

  const margin = notionalValue / leverage;

  // Estimated P&L
  const priceDiff = Math.abs(setup.target - setup.entry);
  const estProfit = basePositionSize * priceDiff;
  const estLoss = riskAmount;

  // Safety check: margin should not exceed 50% of capital
  if (margin > currentCapital * 0.5) {
    riskLogger.warn(`Margin $${margin.toFixed(2)} exceeds 50% capital, reducing size`);
    return null;
  }

  return {
    riskPct,
    riskAmount: riskAmount.toFixed(2),
    leverage,
    positionSize: basePositionSize.toFixed(6),      // Base units (BTC, ETH)
    notionalValue: notionalValue.toFixed(2),         // USDT value
    margin: margin.toFixed(2),
    estProfit: estProfit.toFixed(2),
    estLoss: estLoss.toFixed(2),
    unit: 'base',                                    // Clarify what positionSize means
  };
}

/**
 * Calculate adaptive leverage based on setup quality and volatility
 * RELAXED: Lower max leverage, tier-based caps, R:R bonus
 */
function calculateLeverage(confidence, atr, setup, riskPct) {
  let leverage = 10;  // Default lower

  // Base leverage on confidence score (smoother)
  if (confidence.score >= 80 && atr?.percent < 2) leverage = 25;
  else if (confidence.score >= 70 && atr?.percent < 2.5) leverage = 20;
  else if (confidence.score >= 60 && atr?.percent < 3) leverage = 18;
  else if (confidence.score >= 50 && atr?.percent < 4) leverage = 14;
  else if (confidence.score >= 40) leverage = 12;
  else leverage = 10;

  // Tier hard caps — RELAXED but safe
  const tierCaps = { 'D': 3, 'C': 4, 'C+': 5, 'B': 7, 'B+': 8, 'A': 10, 'A+': 12 };
  const tierCap = tierCaps[confidence.tier] || 5;
  leverage = Math.min(leverage, tierCap);

  // R:R bonus: High R:R = more confidence = more leverage
  const rr = setup.rr || 1;
  if (rr >= 3) leverage = Math.min(leverage + 2, tierCap);
  else if (rr >= 2) leverage = Math.min(leverage + 1, tierCap);

  // Volatility caps — strict
  if (atr?.percent > 6) leverage = Math.min(leverage, 3);
  else if (atr?.percent > 5) leverage = Math.min(leverage, 4);
  else if (atr?.percent > 4) leverage = Math.min(leverage, 5);
  else if (atr?.percent > 3) leverage = Math.min(leverage, 7);

  // Risk percentage cap: High risk% = lower leverage (protect capital)
  if (riskPct > 2.5) leverage = Math.min(leverage, 5);
  else if (riskPct > 2.0) leverage = Math.min(leverage, 7);

  // Quality floor
  if (setup.quality === 'C+' || confidence.tier === 'C+') {
    leverage = Math.min(leverage, 5);
  }

  return Math.round(leverage);
      }
    
