// ==========================================
// COOLDOWN & RISK STATE MANAGER
// Graduated risk scaling — wins increase appetite, losses reduce it
// VERSION: 3.3-community
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
    this.cooldownLevel = 0;
    this.todayKey = getTodayKey();
    
    this.streakData = {
      winStreak: 0,
      lossStreak: 0,
      dailyPnL: 0,
      totalTrades: 0,
      winCount: 0,
    };
    
    riskLogger.info('RiskManager initialized (dynamic mode)');
  }

  canTrade() {
    if (this.cooldownLevel === 3) {
      riskLogger.warn('Trading blocked: heavy cooldown');
      return false;
    }
    
    const currentCapital = CONFIG.CHALLENGE.CURRENT_CAPITAL;
    const dailyLoss = this.getDailyLoss();
    const dailyLimit = currentCapital * 0.10;

    if (dailyLoss >= dailyLimit) {
      riskLogger.warn(`Daily loss limit: $${dailyLoss.toFixed(2)}/${dailyLimit.toFixed(2)}`);
      this.cooldownLevel = 3;
      return false;
    }

    if (this.consecutiveLosses >= 5) {
      this._setCooldown(3, 30);
      return false;
    } else if (this.consecutiveLosses >= 3) {
      this._setCooldown(2, 15);
    } else if (this.consecutiveLosses >= 2) {
      this._setCooldown(1, 5);
    }

    return true;
  }

  getStreakData() {
    return {
      winStreak: this.streakData.winStreak,
      lossStreak: this.streakData.lossStreak,
      dailyPnL: this.streakData.dailyPnL,
      cooldownLevel: this.cooldownLevel,
    };
  }

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
      this.consecutiveLosses = Math.max(0, this.consecutiveLosses - 1);
      this.consecutiveWins++;
      this.streakData.lossStreak = 0;
      this.streakData.winStreak++;
      this.lastWinTime = Date.now();
      
      const currentWin = this.dailyStats.get(winKey) || 0;
      this.dailyStats.set(winKey, currentWin + pnl);
      this.streakData.winCount++;
      
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

  getDailyLoss() {
    const key = `${getTodayKey()}_loss`;
    return this.dailyStats.get(key) || 0;
  }

  getDailyWin() {
    const key = `${getTodayKey()}_win`;
    return this.dailyStats.get(key) || 0;
  }

  _setCooldown(level, minutes) {
    if (this.cooldownLevel >= level) return;
    
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
