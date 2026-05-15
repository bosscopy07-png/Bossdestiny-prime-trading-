// ==========================================
// BOT COMMANDS
// Telegram command handlers
// ==========================================

import { Markup } from 'telegraf';
import { CONFIG } from '../config/index.js';
import { botLogger } from '../utils/logger.js';
import { formatDashboard, formatSignalMessage } from '../signals/formatter.js';

/**
 * Register all bot commands
 */
export function registerCommands(bot, generator, marketData) {
  
  // /start — Welcome
  bot.command('start', async (ctx) => {
    try {
      botLogger.info(`User started: ${ctx.from.id}`);
      
      const welcome = [
        '🎯 *SignalAlpha v3\\.0 — Institutional Signals*',
        '',
        'Real\\-time crypto futures analysis with multi\\-layer scoring\\.',
        'Quality over quantity\\. Survival over hype\\.',
        '',
        '*Key Features:*',
        '• 60%\\+ confidence threshold with 6 weighted factors',
        '• BTC trend filter for market context',
        '• Adaptive leverage \\(5x–20x based on setup quality\\)',
        '• Cooldown system after consecutive losses',
        '• Multi\\-timeframe confluence \\(1m–4h\\)',
        '',
        '📊 /dashboard — View challenge progress',
        '🎯 /signal — Get manual signal scan',
        '🔥 /live — Start auto\\-scanning \\(admin\\)',
        '🩺 /diagnose — Show near\\-misses \\(admin\\)',
        '',
        `🎁 [Trade on BingX](${escapeMarkdownV2(CONFIG.REFERRAL.LINK)}) | Code: \\${'`'}${escapeMarkdownV2(CONFIG.REFERRAL.CODE)}\\${'`'}`
      ].join('\n');

      await ctx.reply(welcome, {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📊 Dashboard', 'DASHBOARD'),
            Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL')
          ],
          [
            Markup.button.callback('📈 Stats', 'STATS'),
            Markup.button.callback('⚙️ Settings', 'SETTINGS')
          ]
        ])
      });
    } catch (err) {
      botLogger.error('Error in /start command:', err);
      await ctx.reply('⚠️ An error occurred. Please try again later.');
    }
  });

  // /dashboard — Challenge progress
  bot.command('dashboard', async (ctx) => {
    try {
      const stats = generator.getStats();
      const text = formatDashboard(stats, marketData, CONFIG.CHALLENGE);
      const isAdmin = isAdminUser(ctx);
      
      const buttons = isAdmin ? [
        [Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL'), Markup.button.callback('🔥 Start Live', 'START_LIVE')],
        [Markup.button.callback('⏹️ Stop Scan', 'STOP_SCAN'), Markup.button.callback('📊 Stats', 'STATS')],
        [Markup.button.callback('⚙️ Settings', 'SETTINGS')]
      ] : [
        [Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL'), Markup.button.callback('📊 Stats', 'STATS')],
        [Markup.button.callback('⚙️ Settings', 'SETTINGS')]
      ];

      await ctx.reply(text, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons)
      });
    } catch (err) {
      botLogger.error('Error in /dashboard command:', err);
      await ctx.reply('⚠️ Failed to load dashboard. Please try again later.');
    }
  });

  // /signal — Manual scan
  bot.command('signal', async (ctx) => {
    try {
      await ctx.reply('🔍 Scanning for qualified setups...', { parse_mode: 'Markdown' });
      
      const symbols = await marketData.getTopVolumeSymbols(15);
      let found = false;
      
      for (const symbol of symbols) {
        const signal = await generator.generateSignal(symbol);
        if (signal) {
          ctx.session = ctx.session || {};
          ctx.session.lastSignal = signal;
          await ctx.reply(formatSignalMessage(signal), {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('✅ Taking This', `TAKEN_${signal.id}`), Markup.button.callback('❌ Skip', `SKIPPED_${signal.id}`)],
              [Markup.button.callback('📊 Dashboard', 'DASHBOARD')]
            ])
          });
          found = true;
          break;
        }
        await sleep(1000);
      }
      
      if (!found) {
        await ctx.reply([
          '❌ *No qualified setups found*',
          '',
          'Markets are consolidating or signals don\'t meet quality thresholds\\.',
          '',
          'Try again in 15\\-30 minutes, or enable auto\\-alerts\\.',
          '',
          'Quality \\> Quantity\\. Patience pays\\.'
        ].join('\n'), {
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔔 Auto-Alerts', 'ENABLE_ALERTS')],
            [Markup.button.callback('📊 Dashboard', 'DASHBOARD')]
          ])
        });
      }
    } catch (err) {
      botLogger.error('Error in /signal command:', err);
      await ctx.reply('⚠️ Signal scan failed. Please try again later.');
    }
  });

  // /live — Start scanning (admin only)
  bot.command('live', async (ctx) => {
    try {
      if (!isAdminUser(ctx)) {
        return ctx.reply('⛔ Admin only command');
      }
      
      await ctx.reply('🔥 Starting live market scanning...');
      await generator.startContinuousScanning();
    } catch (err) {
      botLogger.error('Error in /live command:', err);
      await ctx.reply('⚠️ Failed to start scanning.');
    }
  });

  // /stop — Stop scanning (admin only)
  bot.command('stop', async (ctx) => {
    try {
      if (!isAdminUser(ctx)) {
        return ctx.reply('⛔ Admin only command');
      }
      
      generator.stopScanning();
      await ctx.reply('⏹️ Scanning stopped.');
    } catch (err) {
      botLogger.error('Error in /stop command:', err);
      await ctx.reply('⚠️ Failed to stop scanning.');
    }
  });

  // /diagnose — Show near-misses (admin only)
  bot.command('diagnose', async (ctx) => {
    try {
      if (!isAdminUser(ctx)) return ctx.reply('⛔ Admin only');
      
      await ctx.reply('🔍 Running diagnostic scan (showing near-misses)...');
      
      const symbols = await marketData.getTopVolumeSymbols(10);
      const results = [];
      
      for (const symbol of symbols) {
        const analysis = await generator.analyzeSymbol(symbol, true);
        
        if (analysis) {
          results.push({
            symbol,
            score: analysis.confidence.score,
            tier: analysis.confidence.tier,
            passed: analysis.confidence.passed,
            setup: analysis.setup?.type,
            rr: analysis.setup?.rr?.toFixed(2),
          });
        }
      }
      
      results.sort((a, b) => b.score - a.score);
      
      const text = [
        '📊 *Diagnostic Results*',
        '',
        ...results.map(r => 
          `${r.passed ? '✅' : '❌'} ${escapeMarkdownV2(r.symbol)}: ${r.score}% (${escapeMarkdownV2(r.tier)}) | ${escapeMarkdownV2(r.setup || 'No setup')} | R:R ${r.rr || 'N/A'}`
        ).slice(0, 10),
        '',
        'Top 10 near\\-misses shown\\. If all \\<<55%, markets are choppy\\.'
      ].join('\n');
      
      await ctx.reply(text, { parse_mode: 'MarkdownV2' });
    } catch (err) {
      botLogger.error('Error in /diagnose command:', err);
      await ctx.reply('⚠️ Diagnostic scan failed.');
    }
  });

  // /stats — System statistics
  bot.command('stats', async (ctx) => {
    try {
      const stats = generator.getStats();
      const riskStatus = stats.riskStatus || {};
      
      await ctx.reply([
        '📊 *System Statistics*',
        '',
        `Signals Today: ${stats.signalsToday}/${CONFIG.RISK.MAX_SIGNALS_PER_DAY}`,
        `Active Signals: ${stats.activeSignals}`,
        `Scanning: ${stats.isScanning ? '🟢 ON' : '⚪ OFF'}`,
        `Scan Cycles: ${stats.scansCompleted}`,
        '',
        `Cooldown: ${riskStatus.inCooldown ? '🔴 ACTIVE' : '🟢 Inactive'}`,
        `Consecutive Losses: ${riskStatus.consecutiveLosses || 0}`,
        `Daily Loss: $${(riskStatus.dailyLoss || 0).toFixed(2)}`,
        '',
        `Markets Tracked: ${marketData.perpetualMarkets?.length || 0}`,
        `Challenge Day: ${CONFIG.CHALLENGE.DAYS}`,
        `Capital: $${CONFIG.CHALLENGE.CURRENT_CAPITAL.toFixed(2)}`
      ].join('\n'), { parse_mode: 'Markdown' });
    } catch (err) {
      botLogger.error('Error in /stats command:', err);
      await ctx.reply('⚠️ Failed to load statistics.');
    }
  });

  botLogger.info('Commands registered: /start, /dashboard, /signal, /live, /stop, /diagnose, /stats');
}

// ==========================================
// HELPERS
// ==========================================

/**
 * Check if the user is an admin
 */
function isAdminUser(ctx) {
  return CONFIG.ADMIN_IDS.includes(String(ctx.from?.id));
}

/**
 * Sleep utility for async delays
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Escape special characters for Telegram MarkdownV2 parse mode
 * Prevents syntax errors when dynamic content contains reserved chars
 */
function escapeMarkdownV2(text) {
  if (typeof text !== 'string') return String(text);
  return text
    .replace(/_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(/\[/g, '\\[')
    .replace(/]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`')
    .replace(/>/g, '\\>')
    .replace(/#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/-/g, '\\-')
    .replace(/=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/!/g, '\\!');
}
