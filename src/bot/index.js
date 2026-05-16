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
    this.handlersRegistered = false;

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
    this.generator.on('scanning_stopped', () => this._broadcastToAdmins('⏹️ Scanning stopped'));
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
      
      if (process.env.AUTO_START_SCAN === 'true') {
        botLogger.info('Auto-starting scanner in 10s...');
        setTimeout(() => {
          this.generator.startContinuousScanning().catch(err => {
            botLogger.error({ err: err.message, stack: err.stack }, 'Auto-start scanner failed');
          });
        }, 10000);
      }
      
      botLogger.info('SignalAlpha v3.0 is LIVE!');
      
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Startup failed');
      throw err;
    }
    
    process.once('SIGINT', () => this.shutdown('SIGINT'));
    process.once('SIGTERM', () => this.shutdown('SIGTERM'));
  }

  async _handleNewSignal(signal) {
    const text = formatSignalMessage(signal);
    for (const adminId of CONFIG.ADMIN_IDS) {
      try {
        await this.bot.telegram.sendMessage(adminId, text, {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      } catch (err) {
        botLogger.error({ err: err.message, adminId }, 'Failed to notify admin of new signal');
      }
    }
  }

  async _handleSignalClose(data) {
    const { signal, result, pnl, pnlPct } = data;
    const emoji = result.includes('take_profit') ? '🎯' : '🛑';
    const text = [
      `${emoji} <b>SIGNAL CLOSED</b>`,
      '',
      `${escapeHtml(signal.symbol)} ${signal.direction}`,
      `Result: <b>${escapeHtml(result.toUpperCase())}</b>`,
      `P&L: $${Math.abs(pnl).toFixed(2)} (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`,
      '',
      `Updated Capital: $${CONFIG.CHALLENGE.CURRENT_CAPITAL.toFixed(2)}`
    ].join('\n');

    for (const adminId of CONFIG.ADMIN_IDS) {
      try {
        await this.bot.telegram.sendMessage(adminId, text, { parse_mode: 'HTML' });
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
