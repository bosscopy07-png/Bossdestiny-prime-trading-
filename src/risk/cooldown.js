// ==========================================
// COOLDOWN & RISK STATE MANAGER
// Tracks consecutive losses, daily limits, cooldowns
// ==========================================

import { CONFIG } from '../config/index.js';
import { riskLogger } from '../utils/logger.js';
import { getTodayKey } from '../utils/time.js';

export class RiskManager {
  constructor() {
    this.dailyStats = new Map();
    this.consecutiveLosses = 0;
    this.lastLossTime = null;
    this.inCooldown = false;
    this.cooldownTimer = null;
    this.todayKey = getTodayKey();
    riskLogger.info('RiskManager initialized');
  }

  /**
   * Check if trading is allowed right now
   */
  canTrade() {
    // Check cooldown
    if (this.inCooldown) {
      riskLogger.warn('Trading blocked: cooldown active');
      return false;
    }

    // Check daily loss limit
    const dailyLoss = this.getDailyLoss();
    const dailyLimit = CONFIG.CHALLENGE.START_CAPITAL * (CONFIG.RISK.DAILY_LOSS_LIMIT_PCT / 100);
    if (dailyLoss >= dailyLimit) {
      riskLogger.warn(`Daily loss limit reached: $${dailyLoss.toFixed(2)}/${dailyLimit.toFixed(2)}`);
      return false;
    }

    // Check consecutive losses
    if (this.consecutiveLosses >= CONFIG.RISK.MAX_CONSECUTIVE_LOSSES) {
      this._startCooldown();
      return false;
    }

    return true;
  }

  /**
   * Record a trade result
   */
  recordResult(pnl) {
    const today = getTodayKey();
    if (today !== this.todayKey) {
      this.dailyStats.clear();
      this.todayKey = today;
    }

    const key = `${today}_loss`;
    if (pnl < 0) {
      this.consecutiveLosses++;
      this.lastLossTime = Date.now();
      const currentLoss = this.dailyStats.get(key) || 0;
      this.dailyStats.set(key, currentLoss + Math.abs(pnl));
      riskLogger.info(`Loss recorded: $${Math.abs(pnl).toFixed(2)} | Consecutive: ${this.consecutiveLosses}`);
    } else {
      this.consecutiveLosses = 0;
      riskLogger.info(`Win recorded: $${pnl.toFixed(2)} | Consecutive losses reset`);
    }
  }

  /**
   * Get today's accumulated loss
   */
  getDailyLoss() {
    const key = `${getTodayKey()}_loss`;
    return this.dailyStats.get(key) || 0;
  }

  /**
   * Start cooldown period after loss streak
   */
  _startCooldown() {
    if (this.inCooldown) return;
    
    this.inCooldown = true;
    const duration = CONFIG.RISK.COOLDOWN_MINUTES * 60 * 1000;
    
    riskLogger.warn(`COOLDOWN STARTED: ${CONFIG.RISK.COOLDOWN_MINUTES} minutes after ${this.consecutiveLosses} consecutive losses`);
    
    this.cooldownTimer = setTimeout(() => {
      this.inCooldown = false;
      this.consecutiveLosses = 0;
      riskLogger.info('Cooldown ended — trading resumed');
    }, duration);
  }

  /**
   * Get current risk status
   */
  getStatus() {
    return {
      inCooldown: this.inCooldown,
      consecutiveLosses: this.consecutiveLosses,
      dailyLoss: this.getDailyLoss(),
      canTrade: this.canTrade(),
    };
  }

  /**
   * Reset all state (for testing or admin command)
   */
  reset() {
    this.consecutiveLosses = 0;
    this.inCooldown = false;
    this.lastLossTime = null;
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    riskLogger.info('Risk state reset');
  }
        }
