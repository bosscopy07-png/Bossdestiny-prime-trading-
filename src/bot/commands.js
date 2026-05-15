// ==========================================
// BOT COMMANDS
// Telegram command handlers
// ==========================================

import { Markup } from 'telegraf';
import { CONFIG } from '../config/index.js';
import { botLogger } from '../utils/logger.js';
import { formatDashboard } from '../signals/formatter.js';

/**
 * Register all bot commands
 */
export function registerCommands(bot, generator, marketData) {
  
  // /start — Welcome
  bot.command('start', async (ctx) => {
    botLogger.info(`User started: ${ctx.from.id}`);
    
    const welcome = [
      '🎯 *SignalAlpha v3.0 — Institutional Signals*',
      '',
      'Real-time crypto futures analysis with multi-layer scoring.',
      'Quality over quantity. Survival over hype.',
      '',
      '*Key Features:*',
      '• 60%+ confidence threshold with 6 weighted factors',
      '• BTC trend filter for market context',
      '• Adaptive leverage (5x–20x based on setup quality)',
      '• Cooldown system after consecutive losses',
      '• Multi-timeframe confluence (1m–4h)',
      '',
      '📊 /dashboard — View challenge progress',
      '🎯 /signal — Get manual signal scan',
      '🔥 /live — Start auto-scanning (admin)',
      '🩺 /diagnose — Show near-misses (admin)',
      '',
      `🎁 [Trade on BingX](${CONFIG.REFERRAL.LINK}) | Code: \\`${CONFIG.REFERRAL.CODE}\\``
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
  });

  // /dashboard — Challenge progress
  bot.command('dashboard', async (ctx) => {
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
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard(buttons)
    });
  });

  // /signal — Manual scan
  bot.command('signal', async (ctx) => {
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
        'Markets are consolidating or signals don\'t meet quality thresholds.',
        '',
        'Try again in 15-30 minutes, or enable auto-alerts.',
        '',
        'Quality > Quantity. Patience pays.'
      ].join('\n'), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔔 Auto-Alerts', 'ENABLE_ALERTS')],
          [Markup.button.callback('📊 Dashboard', 'DASHBOARD')]
        ])
      });
    }
  });

  // /live — Start scanning (admin only)
  bot.command('live', async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply('⛔ Admin only command');
    }
    
    await ctx.reply('🔥 Starting live market scanning...');
    await generator.startContinuousScanning();
  });

  // /stop — Stop scanning (admin only)
  bot.command('stop', async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply('⛔ Admin only command');
    }
    
    generator.stopScanning();
    await ctx.reply('⏹️ Scanning stopped.');
  });

  // /diagnose — Show near-misses (admin only)
  bot.command('diagnose', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('⛔ Admin only');
    
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
        `${r.passed ? '✅' : '❌'} ${r.symbol}: ${r.score}% (${r.tier}) | ${r.setup || 'No setup'} | R:R ${r.rr || 'N/A'}`
      ).slice(0, 10),
      '',
      'Top 10 near-misses shown. If all <55%, markets are choppy.'
    ].join('\n');
    
    await ctx.reply(text, { parse_mode: 'Markdown' });
  });

  // /stats — System statistics
  bot.command('stats', async (ctx) => {
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
  });

  botLogger.info('Commands registered: /start, /dashboard, /signal, /live, /stop, /diagnose, /stats');
}

function isAdmin(ctx) {
  return CONFIG.ADMIN_IDS.includes(String(ctx.from?.id));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Import needed for signal formatting
import { formatSignalMessage } from '../signals/formatter.js';
