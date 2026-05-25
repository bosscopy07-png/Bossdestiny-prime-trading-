// ==========================================
// TELEGRAM BOT INTERFACE
// Main bot class with event wiring — v4.1
// FIX: Auto-recovery scanner, persistent run state, NEW DAY at 7:00 AM
// ==========================================

import { Telegraf, Markup } from 'telegraf';
import { CONFIG } from '../config/index.js';
import { botLogger } from '../utils/logger.js';
import { formatPage1, formatPage2, formatClosed, getPage1Markup } from '../signals/formatter.js';
import { registerCommands } from './commands.js';
import { registerActions } from './actions.js';
import { MarketDataEngine } from '../exchange/marketData.js';
import { SignalGenerator } from '../signals/generator.js';

// Recovery interval: check if scanner should be running (ms)
const SCANNER_RECOVERY_INTERVAL = 60000; // 1 minute
// New day check interval
const NEW_DAY_CHECK_INTERVAL = 300000; // 5 minutes

// NEW: Day reset hour (7:00 AM)
const DAY_RESET_HOUR = 7;

export class SignalAlphaBot {
  constructor() {
    botLogger.info('Initializing SignalAlphaBot...');

    if (!CONFIG.BOT_TOKEN) {
      throw new Error('BOT_TOKEN is required in .env file');
    }

    this.bot = new Telegraf(CONFIG.BOT_TOKEN);
    this.marketData = new MarketDataEngine();
    this.generator = new SignalGenerator(this.marketData);
    this.userSettings = new Map();
    this.handlersRegistered = false;

    // FIX: Persistent scanner intent — true = should be running, false = manually stopped
    this.scannerShouldRun = process.env.AUTO_START_SCAN === 'true';
    this.scannerRecoveryTimer = null;
    this.newDayCheckTimer = null;
    
    // FIX: Track the last "day key" that includes the 7 AM threshold
    this.lastDayKey = this._getDayKey();

    this._setupMiddleware();
    this._setupEvents();

    botLogger.info('SignalAlphaBot constructed');
  }

  _setupMiddleware() {
    this.bot.use(async (ctx, next) => {
      if (ctx.from) {
        ctx.isAdmin = CONFIG.ADMIN_IDS.includes(String(ctx.from.id));
      }
      await next();
    });
  }

  _setupEvents() {
    this.generator.on('signal', (signal) => this._handleNewSignal(signal));
    this.generator.on('signal_closed', (data) => this._handleSignalClose(data));
    this.generator.on('scanning_started', () => this._broadcastToAdmins('🔥 Live scanning activated'));
    this.generator.on('scanning_stopped', () => {
      // Only broadcast if manually stopped (not from daily limit pause)
      if (!this.scannerShouldRun) {
        this._broadcastToAdmins('⏹️ Scanning stopped');
      }
    });
  }

  _registerHandlers() {
    if (this.handlersRegistered) {
      botLogger.warn('Handlers already registered, skipping');
      return;
    }
    registerCommands(this.bot, this.generator, this.marketData);
    registerActions(this.bot, this.generator, this.marketData, this.userSettings);
    this.handlersRegistered = true;
    botLogger.info('Bot handlers registered');
  }

  /**
   * FIX: Generate day key based on 7:00 AM threshold
   * Before 7 AM = previous day. After 7 AM = current day.
   */
  _getDayKey() {
    const now = new Date();
    const hour = now.getHours();
    
    // If before 7 AM, we're still in "yesterday's" trading day
    if (hour < DAY_RESET_HOUR) {
      // Subtract one day
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return yesterday.toISOString().slice(0, 10);
    }
    
    return now.toISOString().slice(0, 10);
  }

  /**
   * FIX: Start recovery timers for scanner auto-resume
   */
  _startRecoveryTimers() {
    // Timer 1: If scanner should run but isn't, restart it
    this.scannerRecoveryTimer = setInterval(() => {
      if (this.scannerShouldRun && !this.generator.isScanning) {
        botLogger.info('Recovery: Scanner should be running but is stopped — restarting...');
        this.generator.startContinuousScanning().catch(err => {
          botLogger.error({ err: err.message }, 'Scanner recovery failed');
        });
      }
    }, SCANNER_RECOVERY_INTERVAL);

    // Timer 2: Check for new day at 7 AM and reset daily counters
    this.newDayCheckTimer = setInterval(() => {
      this._checkNewDay();
    }, NEW_DAY_CHECK_INTERVAL);
  }

  /**
   * FIX: Detect new day at 7:00 AM and reset state
   */
  _checkNewDay() {
    const currentDayKey = this._getDayKey();
    
    if (this.lastDayKey && this.lastDayKey !== currentDayKey) {
      botLogger.info(`New trading day detected: ${currentDayKey} (was ${this.lastDayKey})`);
      
      // Reset generator daily state
      this.generator.scanStats.signalsToday = 0;
      this.generator._recentScans.clear();
      
      // If scanner should be running, ensure it starts
      if (this.scannerShouldRun && !this.generator.isScanning) {
        botLogger.info('New day at 7 AM: Auto-starting scanner...');
        this.generator.startContinuousScanning().catch(err => {
          botLogger.error({ err: err.message }, 'New day auto-start failed');
        });
      }
    }
    
    this.lastDayKey = currentDayKey;
  }

  /**
   * FIX: Stop all recovery timers
   */
  _stopRecoveryTimers() {
    if (this.scannerRecoveryTimer) {
      clearInterval(this.scannerRecoveryTimer);
      this.scannerRecoveryTimer = null;
    }
    if (this.newDayCheckTimer) {
      clearInterval(this.newDayCheckTimer);
      this.newDayCheckTimer = null;
    }
  }

  async start() {
    botLogger.info('Starting SignalAlpha Bot...');
    
    try {
      botLogger.info('Step 1: Initializing market data...');
      await this.marketData.initialize();
      
      if (!this.marketData.isRunning) {
        throw new Error('MarketDataEngine failed to start');
      }
      
      botLogger.info('Market data ready');
      botLogger.info(`Markets: ${this.marketData.perpetualMarkets.length}`);
      
      botLogger.info('Step 2: Registering bot handlers...');
      this._registerHandlers();
      
      botLogger.info('Step 3: Launching Telegram bot...');
      await this.bot.launch();
      
      // FIX: Initialize day tracking with 7 AM threshold
      this.lastDayKey = this._getDayKey();
      
      // FIX: Start recovery timers before auto-start
      this._startRecoveryTimers();
      
      // FIX: Auto-start with persistent intent
      if (this.scannerShouldRun) {
        botLogger.info('Auto-starting scanner in 10s...');
        setTimeout(() => {
          this.generator.startContinuousScanning().catch(err => {
            botLogger.error({ err: err.message, stack: err.stack }, 'Auto-start scanner failed');
          });
        }, 10000);
      }
      
      botLogger.info('SignalAlpha v4.1 is LIVE! (Day reset at 7:00 AM)');
      
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Startup failed');
      throw err;
    }
    
    process.once('SIGINT', () => this.shutdown('SIGINT'));
    process.once('SIGTERM', () => this.shutdown('SIGTERM'));
  }

  /**
   * FIX: Explicit scanner control commands
   */
  async startScanner() {
    this.scannerShouldRun = true;
    botLogger.info('Scanner intent set to RUN');
    
    if (!this.generator.isScanning) {
      await this.generator.startContinuousScanning();
    }
  }

  async stopScanner() {
    this.scannerShouldRun = false;
    botLogger.info('Scanner intent set to STOP');
    this.generator.stopScanning();
  }

  async _handleNewSignal(signal) {
    for (const adminId of CONFIG.ADMIN_IDS) {
      try {
        await this.bot.telegram.sendMessage(adminId, formatPage1(signal), {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...getPage1Markup(signal.id)
        });
      } catch (err) {
        botLogger.error({ err: err.message, adminId }, 'Failed to notify admin of new signal');
      }
    }
  }

  async _handleSignalClose(data) {
    const { signal, result, exitPrice, pnl, pnlPct } = data;
    
    const text = formatClosed(signal, result, exitPrice, pnl, pnlPct);

    for (const adminId of CONFIG.ADMIN_IDS) {
      try {
        await this.bot.telegram.sendMessage(adminId, text, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('📊 Dashboard', 'DASHBOARD'),
              Markup.button.callback('🎯 New Signal', 'GET_SIGNAL')
            ]
          ])
        });
      } catch (err) {
        botLogger.error({ err: err.message, adminId }, 'Failed to notify admin of signal close');
      }
    }
  }

  async _broadcastToAdmins(message) {
    for (const adminId of CONFIG.ADMIN_IDS) {
      try {
        await this.bot.telegram.sendMessage(adminId, message, { parse_mode: 'HTML' });
      } catch (err) {
        botLogger.error({ err: err.message, adminId }, 'Broadcast to admin failed');
      }
    }
  }

  shutdown(signal) {
    botLogger.info(`Shutting down (${signal})...`);
    
    // FIX: Clean up recovery timers
    this._stopRecoveryTimers();

    try {
      this.generator.stopScanning();
    } catch (err) {
      botLogger.error({ err: err.message }, 'Error stopping generator');
    }

    try {
      this.marketData.shutdown();
    } catch (err) {
      botLogger.error({ err: err.message }, 'Error shutting down market data');
    }

    try {
      this.bot.stop(signal);
    } catch (err) {
      botLogger.error({ err: err.message }, 'Error stopping bot');
    }
    
    botLogger.info('Shutdown complete');
    process.exit(0);
  }
}

function escapeHtml(text) {
  if (typeof text !== 'string') return String(text);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
