// ==========================================
// COOLDOWN & RISK STATE MANAGER
// Graduated risk scaling — wins increase appetite, losses reduce it
// ==========================================

import { CONFIG } from '../config/index.js';
import { riskLogger } from '../utils/logger.js';
import { getTodayKey } from '../utils/time.js';

export class RiskManager {
  constructor() {
    this.dailyStats = new Map();
    this.consecutiveLosses = 0;
    this.consecutiveWins = 0;
    this.lastLossTime = null;
    this.lastWinTime = null;
    this.inCooldown = false;
    this.cooldownTimer = null;
    this.cooldownLevel = 0;  // 0=none, 1=light, 2=medium, 3=heavy
    this.todayKey = getTodayKey();
    
    // Streak tracking for position sizing
    this.streakData = {
      winStreak: 0,
      lossStreak: 0,
      dailyPnL: 0,
      totalTrades: 0,
      winCount: 0,
    };
    
    riskLogger.info('RiskManager initialized (dynamic mode)');
  }

  /**
   * Check if trading is allowed right now
   * Graduated: Light cooldown = scan only, no new signals
   *            Medium cooldown = reduced size only
   *            Heavy cooldown = full stop
   */
  canTrade() {
    if (this.cooldownLevel === 3) {
      riskLogger.warn('Trading blocked: heavy cooldown');
      return false;
    }
    
    // Daily loss limit (adaptive: 10% of current capital, not start capital)
    const currentCapital = CONFIG.CHALLENGE.CURRENT_CAPITAL;
    const dailyLoss = this.getDailyLoss();
    const dailyLimit = currentCapital * 0.10;  // 10% of current, not start
    
    if (dailyLoss >= dailyLimit) {
      riskLogger.warn(`Daily loss limit: $${dailyLoss.toFixed(2)}/${dailyLimit.toFixed(2)}`);
      this.cooldownLevel = 3;
      return false;
    }

    // Consecutive losses trigger graduated cooldown
    if (this.consecutiveLosses >= 5) {
      this._setCooldown(3, 30);  // 30 min heavy
      return false;
    } else if (this.consecutiveLosses >= 3) {
      this._setCooldown(2, 15);  // 15 min medium
    } else if (this.consecutiveLosses >= 2) {
      this._setCooldown(1, 5);   // 5 min light
    }

    return true;
  }

  /**
   * Get current risk multiplier for position sizing
   * Returns: { winStreak, lossStreak, dailyPnL, cooldownLevel }
   */
  getStreakData() {
    return {
      winStreak: this.streakData.winStreak,
      lossStreak: this.streakData.lossStreak,
      dailyPnL: this.streakData.dailyPnL,
      cooldownLevel: this.cooldownLevel,
    };
  }

  /**
   * Record a trade result
   * DYNAMIC: Tracks streaks, adapts to result size
   */
  recordResult(pnl) {
    const today = getTodayKey();
    if (today !== this.todayKey) {
      this._rolloverDay();
    }

    this.streakData.totalTrades++;
    this.streakData.dailyPnL += pnl;

    const lossKey = `${today}_loss`;
    const winKey = `${today}_win`;

    if (pnl < 0) {
      // Weighted consecutive loss: big loss counts more
      const lossWeight = Math.min(Math.abs(pnl) / (CONFIG.CHALLENGE.CURRENT_CAPITAL * 0.02), 2);
      this.consecutiveLosses += lossWeight;
      this.consecutiveWins = 0;
      this.streakData.winStreak = 0;
      this.streakData.lossStreak++;
      this.lastLossTime = Date.now();
      
      const currentLoss = this.dailyStats.get(lossKey) || 0;
      this.dailyStats.set(lossKey, currentLoss + Math.abs(pnl));
      
      riskLogger.info(
        `LOSS: $${Math.abs(pnl).toFixed(2)} | ` +
        `Weighted: +${lossWeight.toFixed(1)} | ` +
        `Streak: ${this.streakData.lossStreak} | ` +
        `Daily P&L: $${this.streakData.dailyPnL.toFixed(2)}`
      );
    } else {
      this.consecutiveLosses = Math.max(0, this.consecutiveLosses - 1);  // Reduce, don't reset
      this.consecutiveWins++;
      this.streakData.lossStreak = 0;
      this.streakData.winStreak++;
      this.lastWinTime = Date.now();
      
      const currentWin = this.dailyStats.get(winKey) || 0;
      this.dailyStats.set(winKey, currentWin + pnl);
      this.streakData.winCount++;
      
      // Clear light cooldown on win
      if (this.cooldownLevel === 1) {
        this._clearCooldown();
      }
      
      riskLogger.info(
        `WIN: $${pnl.toFixed(2)} | ` +
        `Win streak: ${this.streakData.winStreak} | ` +
        `Daily P&L: $${this.streakData.dailyPnL.toFixed(2)}`
      );
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
   * Get today's accumulated win
   */
  getDailyWin() {
    const key = `${getTodayKey()}_win`;
    return this.dailyStats.get(key) || 0;
  }

  /**
   * Graduated cooldown setter
   */
  _setCooldown(level, minutes) {
    if (this.cooldownLevel >= level) return;  // Don't downgrade
    
    this.cooldownLevel = level;
    const duration = minutes * 60 * 1000;
    
    const labels = ['none', 'LIGHT', 'MEDIUM', 'HEAVY'];
    riskLogger.warn(
      `COOLDOWN [${labels[level]}]: ${minutes}min | ` +
      `Loss streak: ${this.consecutiveLosses.toFixed(1)} | ` +
      `Daily loss: $${this.getDailyLoss().toFixed(2)}`
    );
    
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => {
      this.cooldownLevel = Math.max(0, this.cooldownLevel - 1);
      riskLogger.info(`Cooldown reduced to level ${this.cooldownLevel}`);
      if (this.cooldownLevel === 0) {
        this.inCooldown = false;
        riskLogger.info('Cooldown ended — full trading resumed');
      }
    }, duration);
  }

  _clearCooldown() {
    this.cooldownLevel = 0;
    this.inCooldown = false;
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    riskLogger.info('Cooldown cleared by win');
  }

  _rolloverDay() {
    this.dailyStats.clear();
    this.todayKey = getTodayKey();
    this.streakData.dailyPnL = 0;
    this.consecutiveLosses = 0;
    this.cooldownLevel = 0;
    riskLogger.info('New day — stats reset');
  }

  /**
   * Get current risk status
   */
  getStatus() {
    return {
      cooldownLevel: this.cooldownLevel,
      consecutiveLosses: this.consecutiveLosses,
      consecutiveWins: this.consecutiveWins,
      winStreak: this.streakData.winStreak,
      lossStreak: this.streakData.lossStreak,
      dailyPnL: this.streakData.dailyPnL,
      dailyLoss: this.getDailyLoss(),
      dailyWin: this.getDailyWin(),
      totalTrades: this.streakData.totalTrades,
      winRate: this.streakData.totalTrades > 0 
        ? (this.streakData.winCount / this.streakData.totalTrades * 100).toFixed(1) 
        : 0,
      canTrade: this.canTrade(),
    };
  }

  /**
   * Reset all state
   */
  reset() {
    this.dailyStats.clear();
    this.consecutiveLosses = 0;
    this.consecutiveWins = 0;
    this.streakData = {
      winStreak: 0,
      lossStreak: 0,
      dailyPnL: 0,
      totalTrades: 0,
      winCount: 0,
    };
    this._clearCooldown();
    riskLogger.info('Risk state fully reset');
  }
}
