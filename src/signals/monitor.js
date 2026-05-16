// ==========================================
// SIGNAL MONITOR MODULE
// FIXED: Candle-close validation, minimum hold time, graduated exits
// VERSION: 3.3-community
// ==========================================

import { signalLogger } from '../utils/logger.js';
import { EventEmitter } from 'events';

export class SignalMonitor extends EventEmitter {
  constructor(marketData, onClose) {
    super();
    this.marketData = marketData;
    this.onClose = onClose;
    this.intervals = new Map();
    this.expiryTimers = new Map();
    this.tp1State = new Map();
    this.minHoldMs = 5 * 60 * 1000; // 5 minutes minimum hold
  }

  start(signal) {
    if (this.intervals.has(signal.id)) {
      signalLogger.warn(`Already monitoring: ${signal.id.slice(0, 8)}`);
      return;
    }

    signalLogger.info(`[${signal.symbol}] Monitor started — min hold ${this.minHoldMs/60000}min`);

    let checkCount = 0;
    const interval = setInterval(async () => {
      try {
        checkCount++;
        
        const timeframe = this._getTimeframe(signal);
        const lastCandle = await this._getLastClosedCandle(signal.symbol, timeframe);
        const currentPrice = lastCandle ? lastCandle[4] : await this.marketData.getCurrentPrice(signal.symbol);
        
        if (!currentPrice) return;

        const elapsed = Date.now() - new Date(signal.timestamp).getTime();

        if (elapsed < this.minHoldMs) {
          if (checkCount % 6 === 0) {
            signalLogger.info(`[${signal.symbol}] Holding... ${(elapsed/1000).toFixed(0)}s / ${this.minHoldMs/1000}s`);
          }
          return;
        }

        if (checkCount % 10 === 0) {
          const pnlPct = signal.direction === 'LONG' 
            ? ((currentPrice - signal.entry.price) / signal.entry.price) * 100
            : ((signal.entry.price - currentPrice) / signal.entry.price) * 100;
          signalLogger.info(`[${signal.symbol}] Check #${checkCount} | Price: $${currentPrice.toFixed(4)} | P&L: ${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%`);
        }

        const result = this._checkExit(signal, currentPrice, elapsed);
        if (result) {
          this.stop(signal.id);
          this.onClose(signal.id, result, currentPrice);
        }

      } catch (err) {
        signalLogger.error(`[${signal.symbol}] Monitor error: ${err.message}`);
      }
    }, 30000);

    this.intervals.set(signal.id, interval);

    const maxHoldHours = signal.execution?.maxHold?.includes('2-4') ? 4 : 8;
    const expiryMs = maxHoldHours * 3600000;
    
    const expiryTimer = setTimeout(() => {
      if (this.intervals.has(signal.id)) {
        signalLogger.info(`[${signal.symbol}] Signal expired after ${maxHoldHours}h`);
        this.stop(signal.id);
        this.onClose(signal.id, 'time_expired', null);
      }
    }, expiryMs);

    this.expiryTimers.set(signal.id, expiryTimer);
  }

  _getTimeframe(signal) {
    if (signal.execution?.maxHold?.includes('2-4')) return '5m';
    return '15m';
  }

  async _getLastClosedCandle(symbol, timeframe) {
    try {
      const ohlcv = await this.marketData.fetchOHLCV(symbol, timeframe, 2);
      if (!ohlcv || ohlcv.length < 2) return null;
      return ohlcv[ohlcv.length - 2];
    } catch (err) {
      signalLogger.debug(`[${symbol}] Candle fetch failed: ${err.message}`);
      return null;
    }
  }

  _checkExit(signal, closePrice, elapsed) {
    const isLong = signal.direction === 'LONG';
    const tp1Hit = this.tp1State.get(signal.id);

    const hitSL = isLong 
      ? closePrice <= signal.stopLoss 
      : closePrice >= signal.stopLoss;
    
    if (hitSL) {
      signalLogger.info(`[${signal.symbol}] STOP LOSS hit at $${closePrice.toFixed(4)}`);
      return 'stop_loss';
    }

    if (tp1Hit && signal.takeProfit2) {
      const hitTP2 = isLong 
        ? closePrice >= signal.takeProfit2 
        : closePrice <= signal.takeProfit2;
      if (hitTP2) {
        signalLogger.info(`[${signal.symbol}] TAKE PROFIT 2 hit at $${closePrice.toFixed(4)}`);
        return 'take_profit_2';
      }
    }

    const hitTP1 = isLong 
      ? closePrice >= signal.takeProfit 
      : closePrice <= signal.takeProfit;
    
    if (hitTP1 && !tp1Hit) {
      signalLogger.info(`[${signal.symbol}] TAKE PROFIT 1 hit at $${closePrice.toFixed(4)} — scaling out 50%, SL → breakeven`);
      this.tp1State.set(signal.id, true);
      
      this.emit?.('tp1_hit', { 
        signalId: signal.id, 
        symbol: signal.symbol, 
        price: closePrice,
        pnl: signal.position.estProfit * 0.5 
      });
      
      return null;
    }

    return null;
  }

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

    this.tp1State.delete(signalId);
  }

  stopAll() {
    for (const [id, interval] of this.intervals) {
      clearInterval(interval);
    }
    this.intervals.clear();

    for (const [id, timer] of this.expiryTimers) {
      clearTimeout(timer);
    }
    this.expiryTimers.clear();
    
    this.tp1State.clear();
  }

  getActiveCount() {
    return this.intervals.size;
  }
}
