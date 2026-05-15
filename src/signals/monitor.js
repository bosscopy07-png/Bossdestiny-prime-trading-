// ==========================================
// SIGNAL MONITOR MODULE
// Tracks active signals, handles SL/TP/expiration
// ==========================================

import { signalLogger } from '../utils/logger.js';

/**
 * Monitor a single signal's lifecycle
 */
export class SignalMonitor {
  constructor(marketData, onClose) {
    this.marketData = marketData;
    this.onClose = onClose;
    this.intervals = new Map();
    this.expiryTimers = new Map();
  }

  /**
   * Start monitoring a signal
   */
  start(signal) {
    if (this.intervals.has(signal.id)) {
      signalLogger.warn(`Already monitoring: ${signal.id.slice(0, 8)}`);
      return;
    }

    signalLogger.info(`Monitor started: ${signal.symbol} ${signal.direction}`);

    let checkCount = 0;
    const interval = setInterval(async () => {
      try {
        checkCount++;
        const currentPrice = await this.marketData.getCurrentPrice(signal.symbol);
        if (!currentPrice) return;

        // Progress log every 10 checks (~50s)
        if (checkCount % 10 === 0) {
          const pnlPct = signal.direction === 'LONG' 
            ? ((currentPrice - signal.entry.price) / signal.entry.price) * 100
            : ((signal.entry.price - currentPrice) / signal.entry.price) * 100;
          signalLogger.info(`${signal.symbol} | Check #${checkCount} | P&L: ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%`);
        }

        // Check exits
        const result = this._checkExit(signal, currentPrice);
        if (result) {
          this.stop(signal.id);
          this.onClose(signal.id, result, currentPrice);
        }

      } catch (err) {
        signalLogger.error(`Monitor error: ${err.message}`);
      }
    }, 5000);

    this.intervals.set(signal.id, interval);

    // Auto-expire after 4 hours
    const expiryTimer = setTimeout(() => {
      if (this.intervals.has(signal.id)) {
        signalLogger.info(`Signal expired: ${signal.id.slice(0, 8)}`);
        this.stop(signal.id);
      }
    }, 4 * 3600000);

    this.expiryTimers.set(signal.id, expiryTimer);
  }

  /**
   * Check if signal hit SL, TP1, or TP2
   */
  _checkExit(signal, currentPrice) {
    const isLong = signal.direction === 'LONG';

    // Stop loss
    const hitSL = isLong 
      ? currentPrice <= signal.stopLoss 
      : currentPrice >= signal.stopLoss;
    if (hitSL) return 'stop_loss';

    // Take profit 2 (higher priority)
    if (signal.takeProfit2) {
      const hitTP2 = isLong 
        ? currentPrice >= signal.takeProfit2 
        : currentPrice <= signal.takeProfit2;
      if (hitTP2) return 'take_profit_2';
    }

    // Take profit 1
    const hitTP = isLong 
      ? currentPrice >= signal.takeProfit 
      : currentPrice <= signal.takeProfit;
    if (hitTP) return 'take_profit';

    return null;
  }

  /**
   * Stop monitoring a signal
   */
  stop(signalId) {
    const interval = this.intervals.get(signalId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(signalId);
    }

    const timer = this.expiryTimers.get(signalId);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(signalId);
    }
  }

  /**
   * Stop all monitoring
   */
  stopAll() {
    for (const [id, interval] of this.intervals) {
      clearInterval(interval);
    }
    this.intervals.clear();

    for (const [id, timer] of this.expiryTimers) {
      clearTimeout(timer);
    }
    this.expiryTimers.clear();
  }

  getActiveCount() {
    return this.intervals.size;
  }
}
