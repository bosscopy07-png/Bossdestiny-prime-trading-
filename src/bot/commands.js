// ==========================================
// BOT COMMANDS
// Telegram command handlers
// ==========================================

import { Markup } from 'telegraf';
import { CONFIG } from '../config/index.js';
import { botLogger } from '../utils/logger.js';
import { formatSignalMessage, formatDashboard } from '../signals/formatter.js';

/**
 * Register all bot commands
 */
export function registerCommands(bot, generator, marketData) {
  
  const isReady = () => marketData?.isRunning === true && marketData?.exchange != null;

  bot.command('start', async (ctx) => {
    try {
      botLogger.info(`User started: ${ctx.from.id}`);
      
      const welcome = [
        '🎯 <b>SignalAlpha v3.0 — Institutional Signals</b>',
        '',
        'Real-time crypto futures analysis with multi-layer scoring.',
        '',
        '<b>Commands:</b>',
        '📊 /dashboard — View challenge progress',
        '🎯 /signal — Get manual signal scan',
        '🔥 /live — Start auto-scanning (admin)',
        '',
        isReady() ? '✅ System ready' : '⏳ System initializing...',
        '',
        `🎁 <a href="${escapeHtml(CONFIG.REFERRAL.LINK)}">Trade on BingX</a> | Code: <code>${escapeHtml(CONFIG.REFERRAL.CODE)}</code>`
      ].join('\n');

      await ctx.reply(welcome, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Dashboard', 'DASHBOARD'), Markup.button.callback('🎯 Get Signal', 'GET_SIGNAL')]
        ])
      });
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in /start command');
      await ctx.reply('⚠️ An error occurred. Please try again later.');
    }
  });

  bot.command('dashboard', async (ctx) => {
    try {
      if (!isReady()) return ctx.reply('⏳ System initializing, please wait...');
      
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

      await ctx.reply(text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons)
      });
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in /dashboard command');
      await ctx.reply('⚠️ Failed to load dashboard. Please try again later.');
    }
  });

  bot.command('signal', async (ctx) => {
    try {
      if (!isReady()) return ctx.reply('⏳ Market data not ready yet. Please wait a moment...');

      await ctx.reply('🔍 Scanning for qualified setups...', { parse_mode: 'HTML' });
      
      const symbols = await marketData.getTopVolumeSymbols(15);
      let found = false;
      
      for (const symbol of symbols) {
        const signal = await generator.generateSignal(symbol);
        if (signal) {
          await ctx.reply(formatSignalMessage(signal), {
            parse_mode: 'HTML',
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
          '❌ <b>No qualified setups found</b>',
          '',
          'Markets are consolidating or signals don\'t meet quality thresholds.',
          '',
          'Try again in 15-30 minutes.',
          '',
          'Quality &gt; Quantity. Patience pays.'
        ].join('\n'), {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔔 Auto-Alerts', 'ENABLE_ALERTS')],
            [Markup.button.callback('📊 Dashboard', 'DASHBOARD')]
          ])
        });
      }
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in /signal command');
      await ctx.reply('⚠️ Signal scan failed. Please try again later.');
    }
  });

  bot.command('live', async (ctx) => {
    try {
      if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only command');
      if (!isReady()) return ctx.reply('⏳ System not ready yet');
      
      await ctx.reply('🔥 Starting live market scanning...');
      
      // Fire and forget — startContinuousScanning never returns
      generator.startContinuousScanning().catch(err => {
        botLogger.error({ err: err.message, stack: err.stack }, 'Scanner crashed from /live');
      });
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in /live command');
      await ctx.reply('⚠️ Failed to start scanning.');
    }
  });

  bot.command('stop', async (ctx) => {
    try {
      if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only command');
      
      generator.stopScanning();
      await ctx.reply('⏹️ Scanning stopped.');
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in /stop command');
      await ctx.reply('⚠️ Failed to stop scanning.');
    }
  });

  bot.command('diagnose', async (ctx) => {
    try {
      if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only');
      if (!isReady()) return ctx.reply('⏳ System not ready yet');
      
      await ctx.reply('🔍 Running diagnostic scan...');
      
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
        '📊 <b>Diagnostic Results</b>',
        '',
        ...results.map(r => 
          `${r.passed ? '✅' : '❌'} ${escapeHtml(r.symbol)}: ${r.score}% (${escapeHtml(r.tier)}) | ${escapeHtml(r.setup || 'No setup')} | R:R ${r.rr || 'N/A'}`
        ).slice(0, 10),
        '',
        'Top 10 near-misses shown. If all &lt;55%, markets are choppy.'
      ].join('\n');
      
      await ctx.reply(text, { parse_mode: 'HTML' });
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in /diagnose command');
      await ctx.reply('⚠️ Diagnostic scan failed.');
    }
  });

  bot.command('stats', async (ctx) => {
    try {
      const stats = generator.getStats();
      const riskStatus = stats.riskStatus || {};
      
      await ctx.reply([
        '📊 <b>System Statistics</b>',
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
      ].join('\n'), { parse_mode: 'HTML' });
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in /stats command');
      await ctx.reply('⚠️ Failed to load statistics.');
    }
  });

  botLogger.info('Commands registered');
}

function isAdmin(ctx) {
  return CONFIG.ADMIN_IDS.includes(String(ctx.from?.id));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(text) {
  if (typeof text !== 'string') return String(text);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
        }
        
