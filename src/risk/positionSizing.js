// ==========================================
// POSITION SIZING MODULE
// Risk-based sizing with capital protection
// ==========================================

import { CONFIG } from '../config/index.js';
import { riskLogger } from '../utils/logger.js';

/**
 * Calculate position parameters from setup and analysis
 * FIXED: Original had positionSize = (riskAmount / riskPrice) * entryPrice
 * which inflated sizes. Correct: positionSize = riskAmount / riskPrice (in quote currency)
 */
export function calculatePosition(setup, confidence, atr, currentCapital) {
  // Dynamic risk based on confidence
  let riskPct = 1;
  if (confidence.score >= 85) riskPct = 3;
  else if (confidence.score >= 75) riskPct = 2.5;
  else if (confidence.score >= 60) riskPct = 2;
  
  // Cap at max risk per trade
  riskPct = Math.min(riskPct, CONFIG.RISK.MAX_RISK_PER_TRADE_PCT);

  const riskAmount = currentCapital * (riskPct / 100);
  const riskPrice = Math.abs(setup.entry - setup.stop);
  
  if (riskPrice <= 0) {
    riskLogger.warn('Invalid risk price (stop = entry), skipping position');
    return null;
  }

  // Position size in quote currency (USDT)
  const positionSize = riskAmount / riskPrice * setup.entry;
  
  // Leverage calculation
  const leverage = calculateLeverage(confidence, atr, setup);

  const margin = positionSize / leverage;

  // Estimated P&L
  const priceDiff = Math.abs(setup.target - setup.entry);
  const estProfit = positionSize * (priceDiff / setup.entry);
  const estLoss = riskAmount;

  return {
    riskPct,
    riskAmount: riskAmount.toFixed(2),
    leverage,
    positionSize: positionSize.toFixed(4),
    margin: margin.toFixed(2),
    estProfit: estProfit.toFixed(2),
    estLoss: estLoss.toFixed(2),
  };
}

/**
 * Calculate adaptive leverage based on setup quality and volatility
 */
function calculateLeverage(confidence, atr, setup) {
  let leverage = 5;

  // Base leverage on confidence
  if (confidence.score >= 85 && atr?.percent < 2) leverage = 20;
  else if (confidence.score >= 75 && atr?.percent < 3) leverage = 15;
  else if (confidence.score >= 65 && atr?.percent < 4) leverage = 10;
  else if (confidence.score >= 60) leverage = 7;
  else leverage = 5;

  // Volatility caps
  if (atr?.percent > 5) leverage = Math.min(leverage, 3);
  else if (atr?.percent > 4) leverage = Math.min(leverage, 5);
  else if (atr?.percent > 3) leverage = Math.min(leverage, 7);

  // Quality floor
  if (setup.quality === 'B' || confidence.tier === 'B') {
    leverage = Math.min(leverage, 10);
  }

  return Math.round(leverage);
           }
