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
  
  // Dashboard
  bot.action('DASHBOARD', async (ctx) => {
    await ctx.answerCbQuery();
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
      // If edit fails, send new message
      ctx.reply(text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons)
      });
    });
  });

  // Get Signal
  bot.action('GET_SIGNAL', async (ctx) => {
    await ctx.answerCbQuery('Scanning...');
    await ctx.reply('🔍 Scanning top pairs for A-B+ setups...');
    
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
    
    await ctx.reply('❌ No qualified setups found. Try /signal for broader scan.');
  });

  // Start Live (admin)
  bot.action('START_LIVE', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('⛔ Admin only');
      return;
    }
    await ctx.answerCbQuery('Starting...');
    await generator.startContinuousScanning();
    await ctx.reply('🔥 Live scanning activated');
  });

  // Stop Scan (admin)
  bot.action('STOP_SCAN', async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('⛔ Admin only');
      return;
    }
    await ctx.answerCbQuery('Stopping...');
    generator.stopScanning();
    await ctx.reply('⏹️ Scanning stopped');
  });

  // Stats
  bot.action('STATS', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Use /stats command for full statistics');
  });

  // Settings
  bot.action('SETTINGS', async (ctx) => {
    await ctx.answerCbQuery();
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
  });

  // Confidence settings
  bot.action(/SET_CONF_(\d+)/, async (ctx) => {
    const conf = parseInt(ctx.match[1]);
    userSettings.set(ctx.from.id, { 
      ...(userSettings.get(ctx.from.id) || {}),
      minConfidence: conf 
    });
    await ctx.answerCbQuery(`Min confidence: ${conf}%`);
    await ctx.reply(`✅ Minimum confidence set to ${conf}%`);
  });

  // Main menu
  bot.action('MAIN_MENU', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('🏠 *Main Menu*', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 Dashboard', 'DASHBOARD'), Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL')],
        [Markup.button.callback('📈 Stats', 'STATS'), Markup.button.callback('⚙️ Settings', 'SETTINGS')]
      ])
    });
  });

  // Signal taken/skipped
  bot.action(/TAKEN_(.+)/, async (ctx) => {
    const signalId = ctx.match[1];
    await ctx.answerCbQuery('✅ Marked as taken');
    await ctx.reply('📝 Signal marked as TAKEN. Trade with discipline!');
    botLogger.info(`Signal ${signalId.slice(0, 8)} taken by ${ctx.from.id}`);
  });

  bot.action(/SKIPPED_(.+)/, async (ctx) => {
    const signalId = ctx.match[1];
    await ctx.answerCbQuery('Skipped');
    botLogger.info(`Signal ${signalId.slice(0, 8)} skipped by ${ctx.from.id}`);
  });

  // Enable alerts
  bot.action('ENABLE_ALERTS', async (ctx) => {
    await ctx.answerCbQuery();
    userSettings.set(ctx.from.id, {
      ...(userSettings.get(ctx.from.id) || {}),
      notifications: true
    });
    await ctx.reply('🔔 Auto-alerts enabled. You will receive signals when they meet quality thresholds.');
  });

  botLogger.info('Action handlers registered');
}

function isAdmin(ctx) {
  return CONFIG.ADMIN_IDS.includes(String(ctx.from?.id));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
      }
