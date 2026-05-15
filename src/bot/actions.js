// ==========================================
// BOT ACTION HANDLERS
// Inline keyboard callback handlers
// ==========================================

import { Markup } from 'telegraf';
import { CONFIG } from '../config/index.js';
import { botLogger } from '../utils/logger.js';
import { formatSignalMessage, formatDashboard } from '../signals/formatter.js';

/**
 * Register all action handlers
 */
export function registerActions(bot, generator, marketData, userSettings) {
  
  // Helper: check if market data is ready for operations
  const isReady = () => marketData?.isRunning === true && marketData?.exchange != null;

  // Helper: safe callback query answer with error fallback
  const safeAnswer = async (ctx, text = '') => {
    try {
      await ctx.answerCbQuery(text);
    } catch (err) {
      botLogger.debug({ err: err.message }, 'answerCbQuery failed');
    }
  };

  // ─── DASHBOARD ─────────────────────────────────────────────────

  bot.action('DASHBOARD', async (ctx) => {
    try {
      if (!isReady()) {
        await safeAnswer(ctx, '⏳ Initializing...');
        return ctx.reply('⏳ System initializing, please wait...');
      }

      await safeAnswer(ctx);
      
      const stats = generator.getStats();
      const text = formatDashboard(stats, marketData, CONFIG.CHALLENGE);
      const isAdmin = CONFIG.ADMIN_IDS.includes(String(ctx.from?.id));
      
      const buttons = isAdmin ? [
        [Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL'), Markup.button.callback('🔥 Start Live', 'START_LIVE')],
        [Markup.button.callback('⏹️ Stop Scan', 'STOP_SCAN'), Markup.button.callback('📊 Stats', 'STATS')],
        [Markup.button.callback('⚙️ Settings', 'SETTINGS')]
      ] : [
        [Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL'), Markup.button.callback('📊 Stats', 'STATS')],
        [Markup.button.callback('⚙️ Settings', 'SETTINGS')]
      ];

      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons)
      }).catch(() => {
        ctx.reply(text, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          ...Markup.inlineKeyboard(buttons)
        });
      });
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in DASHBOARD action');
      await safeAnswer(ctx, 'Error');
      await ctx.reply('⚠️ Failed to load dashboard. Please try again.');
    }
  });

  // ─── GET SIGNAL ──────────────────────────────────────────────────

  bot.action('GET_SIGNAL', async (ctx) => {
    try {
      if (!isReady()) {
        await safeAnswer(ctx, 'Not ready');
        return ctx.reply('⏳ Market data not ready yet. Please wait a moment...');
      }

      await safeAnswer(ctx, '🔍 Scanning...');
      await ctx.reply('🔍 Scanning top pairs for qualified setups...');
      
      const symbols = await marketData.getTopVolumeSymbols(10);
      
      for (const symbol of symbols.slice(0, 5)) {
        const signal = await generator.generateSignal(symbol);
        if (signal) {
          await ctx.reply(formatSignalMessage(signal), {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('✅ Taking This', `TAKEN_${signal.id}`), Markup.button.callback('❌ Skip', `SKIPPED_${signal.id}`)],
              [Markup.button.callback('📊 Dashboard', 'DASHBOARD')]
            ])
          });
          return;
        }
        await sleep(1500);
      }
      
      await ctx.reply([
        '❌ *No qualified setups found*',
        '',
        'Markets are consolidating or signals don\\\'t meet quality thresholds.',
        '',
        'Try /signal for a broader scan, or enable auto-alerts.',
        '',
        'Quality \\> Quantity\\. Patience pays\\.'
      ].join('\n'), {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔔 Auto-Alerts', 'ENABLE_ALERTS')],
          [Markup.button.callback('📊 Dashboard', 'DASHBOARD')]
        ])
      });
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in GET_SIGNAL action');
      await safeAnswer(ctx, 'Error');
      await ctx.reply('⚠️ Signal scan failed. Please try again later.');
    }
  });

  // ─── START LIVE (admin only) ───────────────────────────────────

  bot.action('START_LIVE', async (ctx) => {
    try {
      if (!isAdmin(ctx)) {
        await safeAnswer(ctx, '⛔ Admin only');
        return;
      }

      if (!isReady()) {
        await safeAnswer(ctx, 'Not ready');
        return ctx.reply('⏳ System not ready yet');
      }

      await safeAnswer(ctx, '🔥 Starting...');
      await generator.startContinuousScanning();
      await ctx.reply('🔥 Live scanning activated');
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in START_LIVE action');
      await safeAnswer(ctx, 'Error');
      await ctx.reply('⚠️ Failed to start scanning.');
    }
  });

  // ─── STOP SCAN (admin only) ────────────────────────────────────

  bot.action('STOP_SCAN', async (ctx) => {
    try {
      if (!isAdmin(ctx)) {
        await safeAnswer(ctx, '⛔ Admin only');
        return;
      }

      await safeAnswer(ctx, '⏹️ Stopping...');
      generator.stopScanning();
      await ctx.reply('⏹️ Scanning stopped');
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in STOP_SCAN action');
      await safeAnswer(ctx, 'Error');
      await ctx.reply('⚠️ Failed to stop scanning.');
    }
  });

  // ─── STATS ───────────────────────────────────────────────────────

  bot.action('STATS', async (ctx) => {
    try {
      await safeAnswer(ctx);
      await ctx.reply('📊 Use /stats command for full statistics');
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in STATS action');
      await safeAnswer(ctx, 'Error');
    }
  });

  // ─── SETTINGS ──────────────────────────────────────────────────

  bot.action('SETTINGS', async (ctx) => {
    try {
      await safeAnswer(ctx);
      const settings = userSettings.get(ctx.from.id) || {};
      
      await ctx.reply([
        '⚙️ *User Settings*',
        '',
        `Min Confidence: ${settings.minConfidence || 60}%`,
        `Notifications: ${settings.notifications !== false ? '✅ ON' : '❌ OFF'}`,
        '',
        'Adjust confidence threshold:'
      ].join('\n'), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('60% (Balanced)', 'SET_CONF_60')],
          [Markup.button.callback('70% (Conservative)', 'SET_CONF_70')],
          [Markup.button.callback('80% (Strict)', 'SET_CONF_80')],
          [Markup.button.callback('🔙 Back', 'MAIN_MENU')]
        ])
      });
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in SETTINGS action');
      await safeAnswer(ctx, 'Error');
      await ctx.reply('⚠️ Failed to load settings.');
    }
  });

  // ─── CONFIDENCE SETTINGS ───────────────────────────────────────

  bot.action(/SET_CONF_(\d+)/, async (ctx) => {
    try {
      const conf = parseInt(ctx.match[1]);
      userSettings.set(ctx.from.id, { 
        ...(userSettings.get(ctx.from.id) || {}),
        minConfidence: conf 
      });
      await safeAnswer(ctx, `✅ ${conf}%`);
      await ctx.reply(`✅ Minimum confidence set to ${conf}%`);
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in SET_CONF action');
      await safeAnswer(ctx, 'Error');
      await ctx.reply('⚠️ Failed to update settings.');
    }
  });

  // ─── MAIN MENU ───────────────────────────────────────────────────

  bot.action('MAIN_MENU', async (ctx) => {
    try {
      await safeAnswer(ctx);
      await ctx.reply('🏠 *Main Menu*', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Dashboard', 'DASHBOARD'), Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL')],
          [Markup.button.callback('📈 Stats', 'STATS'), Markup.button.callback('⚙️ Settings', 'SETTINGS')]
        ])
      });
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in MAIN_MENU action');
      await safeAnswer(ctx, 'Error');
    }
  });

  // ─── SIGNAL TAKEN ──────────────────────────────────────────────

  bot.action(/TAKEN_(.+)/, async (ctx) => {
    try {
      const signalId = ctx.match[1];
      await safeAnswer(ctx, '✅ Marked as taken');
      await ctx.reply('📝 Signal marked as TAKEN. Trade with discipline!');
      botLogger.info(`Signal ${signalId.slice(0, 8)} taken by ${ctx.from.id}`);
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in TAKEN action');
      await safeAnswer(ctx, 'Error');
    }
  });

  // ─── SIGNAL SKIPPED ─────────────────────────────────────────────

  bot.action(/SKIPPED_(.+)/, async (ctx) => {
    try {
      const signalId = ctx.match[1];
      await safeAnswer(ctx, 'Skipped');
      botLogger.info(`Signal ${signalId.slice(0, 8)} skipped by ${ctx.from.id}`);
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in SKIPPED action');
      await safeAnswer(ctx, 'Error');
    }
  });

  // ─── ENABLE ALERTS ─────────────────────────────────────────────

  bot.action('ENABLE_ALERTS', async (ctx) => {
    try {
      await safeAnswer(ctx);
      userSettings.set(ctx.from.id, {
        ...(userSettings.get(ctx.from.id) || {}),
        notifications: true
      });
      await ctx.reply('🔔 Auto-alerts enabled. You will receive signals when they meet quality thresholds.');
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in ENABLE_ALERTS action');
      await safeAnswer(ctx, 'Error');
      await ctx.reply('⚠️ Failed to enable alerts.');
    }
  });

  botLogger.info('Action handlers registered');
}

// ==========================================
// HELPERS
// ==========================================

function isAdmin(ctx) {
  return CONFIG.ADMIN_IDS.includes(String(ctx.from?.id));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
  }
  
