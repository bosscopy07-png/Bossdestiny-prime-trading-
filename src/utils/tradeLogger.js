// ==========================================
// TRADE LOGGER
// Persistent trade/signal logging with stats
// ==========================================

import { appendFile, readFile, access, writeFile } from 'fs/promises';
import { join } from 'path';
import { logger } from './logger.js';
import { getTodayKey } from './time.js';

const LOG_FILE = join(process.cwd(), 'data', 'trades.log');

export class TradeLogger {
  constructor(filename = LOG_FILE) {
    this.filename = filename;
    this.dailyStats = new Map();
    this._ensureFile();
  }

  async _ensureFile() {
    try {
      await access(this.filename);
    } catch {
      try {
        await writeFile(this.filename, '');
        logger.info(`Trade log created: ${this.filename}`);
      } catch (err) {
        logger.error(`Failed to create trade log: ${err.message}`);
      }
    }
  }

  /**
   * Log any trade or system event
   */
  async log(type, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      ...data,
    };

    try {
      await appendFile(this.filename, JSON.stringify(entry) + '\n');
      
      // Update daily stats
      const dayKey = getTodayKey();
      const current = this.dailyStats.get(dayKey) || { count: 0, types: new Map() };
      current.count++;
      current.types.set(type, (current.types.get(type) || 0) + 1);
      this.dailyStats.set(dayKey, current);

    } catch (err) {
      logger.error(`Failed to write trade log: ${err.message}`);
    }
  }

  /**
   * Get trades from last N hours
   */
  async getRecent(hours = 24) {
    try {
      const content = await readFile(this.filename, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const cutoff = Date.now() - (hours * 3600000);

      return lines
        .map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(trade => trade && new Date(trade.timestamp).getTime() > cutoff);

    } catch (err) {
      logger.warn(`Could not read trade log: ${err.message}`);
      return [];
    }
  }

  /**
   * Get today's signal count
   */
  async getTodaySignalCount() {
    const trades = await this.getRecent(24);
    return trades.filter(t => t.type === 'SIGNAL_GENERATED').length;
  }

  /**
   * Get win/loss stats
   */
  async getStats(hours = 24) {
    const trades = await this.getRecent(hours);
    const closed = trades.filter(t => t.type === 'SIGNAL_CLOSED');
    const wins = closed.filter(t => t.result?.includes('take_profit')).length;
    const losses = closed.filter(t => t.result === 'stop_loss').length;

    return {
      totalSignals: trades.filter(t => t.type === 'SIGNAL_GENERATED').length,
      closed,
      wins,
      losses,
      winRate: closed.length > 0 ? ((wins / closed.length) * 100).toFixed(1) : 'N/A',
      totalPnL: closed.reduce((sum, t) => sum + (t.pnl || 0), 0),
    };
  }
}
