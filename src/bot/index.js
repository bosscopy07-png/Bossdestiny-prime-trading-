// ==========================================
// TELEGRAM BOT INTERFACE
// Main bot class with event wiring
// ==========================================

import { Telegraf } from 'telegraf';
import { CONFIG } from '../config/index.js';
import { botLogger } from '../utils/logger.js';
import { formatSignalMessage } from '../signals/formatter.js';
import { registerCommands } from './commands.js';
import { registerActions } from './actions.js';
import { MarketDataEngine } from '../exchange/marketData.js';
import { SignalGenerator } from '../signals/generator.js';

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

    this._setupMiddleware();
    this._setupHandlers();
    this._setupEvents();

    botLogger.info('SignalAlphaBot constructed');
  }

  _setupMiddleware() {
    // Admin check middleware
    this.bot.use(async (ctx, next) => {
      if (ctx.from) {
        ctx.isAdmin = CONFIG.ADMIN_IDS.includes(String(ctx.from.id));
      }
      await next();
    });
  }

  _setupHandlers() {
    registerCommands(this.bot, this.generator, this.marketData);
    registerActions(this.bot, this.generator, this.marketData, this.userSettings);
  }

  _setupEvents() {
    // Signal events
    this.generator.on('signal', (signal) => this._handleNewSignal(signal));
    this.generator.on('signal_closed', (data) => this._handleSignalClose(data));
    this.generator.on('scanning_started', () => this._broadcastToAdmins('🔥 Live scanning activated'));
    this.generator.on('scanning_stopped', () => this._broadcastToAdmins('⏹️ Scanning stopped'));
  }

  async _handleNewSignal(signal) {
    for (const adminId of CONFIG.ADMIN_IDS) {
      try {
        await this.bot.telegram.sendMessage(adminId, formatSignalMessage(signal), {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        });
      } catch (err) {
        botLogger.error(`Failed to notify admin ${adminId}: ${err.message}`);
      }
    }
  }

  async _handleSignalClose(data) {
    const { signal, result, pnl, pnlPct } = data;
    
    const emoji = result.includes('take_profit') ? '🎯' : '🛑';
    const text = [
      `${emoji} *SIGNAL CLOSED*`,
      '',
      `${signal.symbol} ${signal.direction}`,
      `Result: *${result.toUpperCase()}*`,
      `P&L: $${Math.abs(pnl).toFixed(2)} (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`,
      '',
      `Updated Capital: $${CONFIG.CHALLENGE.CURRENT_CAPITAL.toFixed(2)}`
    ].join('\n');

    for (const adminId of CONFIG.ADMIN_IDS) {
      try {
        await this.bot.telegram.sendMessage(adminId, text, { parse_mode: 'Markdown' });
      } catch (err) {
        botLogger.error(`Failed to notify close to ${adminId}: ${err.message}`);
      }
    }
  }

  async _broadcastToAdmins(message) {
    for (const adminId of CONFIG.ADMIN_IDS) {
      try {
        await this.bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' });
      } catch (err) {
        botLogger.error(`Broadcast failed to ${adminId}: ${err.message}`);
      }
    }
  }

  /**
   * Main startup sequence
   * FIXED: Added missing shutdown method
   */
  async start() {
    botLogger.info('Starting SignalAlpha Bot...');
    
    try {
      // Step 1: Initialize market data
      botLogger.info('Step 1: Initializing market data...');
      await this.marketData.initialize();
      
      if (!this.marketData.isRunning) {
        throw new Error('MarketDataEngine failed to start');
      }
      
      botLogger.info('Market data ready');
      botLogger.info(`Markets: ${this.marketData.perpetualMarkets.length}`);
      
      // Step 2: Launch bot
      botLogger.info('Step 2: Launching Telegram bot...');
      await this.bot.launch();
      
      // Step 3: Auto-start if configured
      if (process.env.AUTO_START_SCAN === 'true') {
        botLogger.info('Auto-starting scanner in 10s...');
        setTimeout(() => {
          this.generator.startContinuousScanning();
        }, 10000);
      }
      
      botLogger.info('SignalAlpha v3.0 is LIVE!');
      
    } catch (err) {
      botLogger.error({ err: err.message }, 'Startup failed');
      throw err;
    }
    
    // Graceful shutdown handlers
    process.once('SIGINT', () => this.shutdown('SIGINT'));
    process.once('SIGTERM', () => this.shutdown('SIGTERM'));
  }

  /**
   * Graceful shutdown
   * FIXED: Was referenced but never defined in original
   */
  shutdown(signal) {
    botLogger.info(`Shutting down (${signal})...`);
    
    this.generator.stopScanning();
    this.marketData.shutdown();
    this.bot.stop(signal);
    
    botLogger.info('Shutdown complete');
    process.exit(0);
  }
      }
