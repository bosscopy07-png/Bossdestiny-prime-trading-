// ==========================================
// BOT ACTION HANDLERS
// Inline keyboard callback handlers — 2-Page Signal Format
// VERSION: 3.3-community
// ==========================================

import { Markup } from 'telegraf';
import { CONFIG } from '../config/index.js';
import { botLogger } from '../utils/logger.js';
import { formatPage1, formatPage2, getSignalButtons, formatClosed, getCloseButtons, formatDashboard } from '../signals/formatter.js';

// Store active signals for page navigation (use Redis in production)
const activeSignalMessages = new Map();

/**
 * Register all action handlers
 */
export function registerActions(bot, generator, marketData, userSettings) {
  
  const isReady = () => marketData?.isRunning === true && marketData?.exchange != null;

  const safeAnswer = async (ctx, text = '') => {
    try {
      await ctx.answerCbQuery(text);
    } catch (err) {
      botLogger.debug({ err: err.message }, 'answerCbQuery failed');
    }
  };

  // ─── DASHBOARD ────────────────────────────────────────────

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
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons)
      }).catch(() => {
        ctx.reply(text, {
          parse_mode: 'HTML',
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

  // ─── GET SIGNAL (Manual Scan) ─────────────────────────────

  bot.action('GET_SIGNAL', async (ctx) => {
    try {
      if (!isReady()) {
        await safeAnswer(ctx, 'Not ready');
        return ctx.reply('⏳ Market data not ready yet. Please wait a moment...');
      }

      await safeAnswer(ctx, '🔍 Scanning...');
      const scanningMsg = await ctx.reply('🔍 Scanning top pairs for qualified setups...');
      
      const symbols = await marketData.getTopVolumeSymbols(10);
      let found = false;
      
      for (const symbol of symbols.slice(0, 5)) {
        const signal = await generator.generateSignal(symbol);
        if (signal) {
          // Store for page navigation
          activeSignalMessages.set(signal.id, signal);
          
          await ctx.deleteMessage(scanningMsg.message_id).catch(() => {});
          
          // Send Page 1 with navigation buttons
          await ctx.reply(formatSignalPage1(signal), {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('◀️ Trade', `PAGE1_${signal.id}`),
                Markup.button.callback('▶️ Analysis', `PAGE2_${signal.id}`)
              ],
              [
                Markup.button.callback('✅ Taking This', `TAKEN_${signal.id}`),
                Markup.button.callback('❌ Skip', `SKIPPED_${signal.id}`)
              ],
              [
                Markup.button.callback('📊 Dashboard', 'DASHBOARD')
              ]
            ])
          });
          
          found = true;
          return;
        }
        await sleep(1500);
      }
      
      if (!found) {
        await ctx.deleteMessage(scanningMsg.message_id).catch(() => {});
        await ctx.reply([
          '❌ <b>No qualified setups found</b>',
          '',
          'Markets are consolidating or signals don\'t meet quality thresholds.',
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
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in GET_SIGNAL action');
      await safeAnswer(ctx, 'Error');
      await ctx.reply('⚠️ Signal scan failed. Please try again later.');
    }
  });

  // ─── PAGE NAVIGATION (◀️ ▶️) ──────────────────────────────

  bot.action(/PAGE1_(.+)/, async (ctx) => {
    try {
      const signalId = ctx.match[1];
      const signal = activeSignalMessages.get(signalId);
      
      if (!signal) {
        await safeAnswer(ctx, '⏳ Signal expired');
        return;
      }
      
      await safeAnswer(ctx);
      
      await ctx.editMessageText(formatSignalPage1(signal), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('◀️ Trade', `PAGE1_${signal.id}`),
            Markup.button.callback('▶️ Analysis', `PAGE2_${signal.id}`)
          ],
          [
            Markup.button.callback('✅ Taking This', `TAKEN_${signal.id}`),
            Markup.button.callback('❌ Skip', `SKIPPED_${signal.id}`)
          ],
          [
            Markup.button.callback('📊 Dashboard', 'DASHBOARD')
          ]
        ])
      });
    } catch (err) {
      botLogger.error({ err: err.message }, 'Error in PAGE1 action');
      await safeAnswer(ctx, 'Error');
    }
  });

  bot.action(/PAGE2_(.+)/, async (ctx) => {
    try {
      const signalId = ctx.match[1];
      const signal = activeSignalMessages.get(signalId);
      
      if (!signal) {
        await safeAnswer(ctx, '⏳ Signal expired');
        return;
      }
      
      await safeAnswer(ctx);
      
      await ctx.editMessageText(formatSignalPage2(signal), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('◀️ Trade', `PAGE1_${signal.id}`),
            Markup.button.callback('▶️ Analysis', `PAGE2_${signal.id}`)
          ],
          [
            Markup.button.callback('📊 Chart', 'url', `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(signal.symbol)}`),
            Markup.button.callback('⚡ Trade Now', 'url', CONFIG?.REFERRAL?.LINK || '#')
          ],
          [
            Markup.button.callback('📊 Dashboard', 'DASHBOARD')
          ]
        ])
      });
    } catch (err) {
      botLogger.error({ err: err.message }, 'Error in PAGE2 action');
      await safeAnswer(ctx, 'Error');
    }
  });

  // ─── START/STOP SCANNING ──────────────────────────────────

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
      await ctx.reply('🔥 Live scanning activated. Signals will auto-send when qualified.');
      
      // Start continuous scanning (fire and forget)
      generator.startContinuousScanning().catch(err => {
        botLogger.error({ err: err.message, stack: err.stack }, 'Scanner crashed from START_LIVE');
      });
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in START_LIVE action');
      await safeAnswer(ctx, 'Error');
      await ctx.reply('⚠️ Failed to start scanning.');
    }
  });

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

  // ─── STATS ────────────────────────────────────────────────

  bot.action('STATS', async (ctx) => {
    try {
      await safeAnswer(ctx);
      
      const stats = generator.getStats();
      const riskStatus = generator.riskManager.getStatus();
      
      await ctx.reply([
        '📊 <b>System Statistics</b>',
        '',
        `Scan Cycles: ${stats.scansCompleted || 0}`,
        `Signals Today: ${stats.signalsToday || 0}/${CONFIG.RISK.MAX_SIGNALS_PER_DAY}`,
        `Active Signals: ${stats.activeSignals || 0}`,
        '',
        '<b>Risk Status:</b>',
        `Cooldown: ${riskStatus.cooldownLevel > 0 ? `🔴 Level ${riskStatus.cooldownLevel}` : '🟢 Inactive'}`,
        `Win Streak: ${riskStatus.winStreak || 0}`,
        `Loss Streak: ${riskStatus.lossStreak || 0}`,
        `Daily P&L: $${riskStatus.dailyPnL?.toFixed(2) || '0.00'}`,
        `Win Rate: ${riskStatus.winRate || 0}%`,
        '',
        `Last Scan: ${stats.lastScan ? new Date(stats.lastScan).toLocaleTimeString() : 'Never'}`
      ].join('\n'), {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Dashboard', 'DASHBOARD')]
        ])
      });
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in STATS action');
      await safeAnswer(ctx, 'Error');
      await ctx.reply('⚠️ Failed to load stats.');
    }
  });

  // ─── SETTINGS ─────────────────────────────────────────────

  bot.action('SETTINGS', async (ctx) => {
    try {
      await safeAnswer(ctx);
      const settings = userSettings.get(ctx.from.id) || {};
      
      await ctx.reply([
        '⚙️ <b>User Settings</b>',
        '',
        `Min Confidence: ${settings.minConfidence || 60}%`,
        `Notifications: ${settings.notifications !== false ? '✅ ON' : '❌ OFF'}`,
        '',
        'Adjust confidence threshold:'
      ].join('\n'), {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('60% (Balanced)', 'SET_CONF_60')],
          [Markup.button.callback('70% (Conservative)', 'SET_CONF_70')],
          [Markup.button.callback('80% (Strict)', 'SET_CONF_80')],
          [Markup.button.callback('🔙 Back', 'DASHBOARD')]
        ])
      });
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in SETTINGS action');
      await safeAnswer(ctx, 'Error');
      await ctx.reply('⚠️ Failed to load settings.');
    }
  });

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

  // ─── TAKEN / SKIPPED ──────────────────────────────────────

  bot.action(/TAKEN_(.+)/, async (ctx) => {
    try {
      const signalId = ctx.match[1];
      await safeAnswer(ctx, '✅ Marked as taken');
      await ctx.reply('📝 Signal marked as TAKEN. Trade with discipline!\n\n⚠️ Remember: This is educational only. Manage your risk.');
      botLogger.info(`Signal ${signalId.slice(0, 8)} taken by ${ctx.from.id}`);
    } catch (err) {
      botLogger.error({ err: err.message, stack: err.stack }, 'Error in TAKEN action');
      await safeAnswer(ctx, 'Error');
    }
  });

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

  // ─── ENABLE ALERTS ────────────────────────────────────────

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

  // ─── AUTO-SIGNAL LISTENER (from continuous scanning) ─────

  generator.on('signal', async (signal) => {
    try {
      // Store for navigation
      activeSignalMessages.set(signal.id, signal);
      
      // Broadcast to all users with notifications enabled
      for (const [userId, settings] of userSettings.entries()) {
        if (settings.notifications !== false && signal.confidence.score >= (settings.minConfidence || 60)) {
          try {
            await bot.telegram.sendMessage(userId, formatSignalPage1(signal), {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              ...Markup.inlineKeyboard([
                [
                  Markup.button.callback('◀️ Trade', `PAGE1_${signal.id}`),
                  Markup.button.callback('▶️ Analysis', `PAGE2_${signal.id}`)
                ],
                [
                  Markup.button.callback('✅ Taking This', `TAKEN_${signal.id}`),
                  Markup.button.callback('❌ Skip', `SKIPPED_${signal.id}`)
                ]
              ])
            });
          } catch (err) {
            botLogger.debug({ err: err.message, userId }, 'Failed to send auto-signal');
          }
        }
      }
    } catch (err) {
      botLogger.error({ err: err.message }, 'Error broadcasting signal');
    }
  });

  // ─── SIGNAL CLOSED LISTENER ───────────────────────────────

  generator.on('signal_closed', async ({ signal, result, exitPrice, pnl, pnlPct }) => {
    try {
      // Remove from active
      activeSignalMessages.delete(signal.id);
      
      // Broadcast close to all users who received the signal
      for (const [userId, settings] of userSettings.entries()) {
        if (settings.notifications !== false) {
          try {
            await bot.telegram.sendMessage(userId, formatCloseMessage(signal, result, exitPrice, pnl, pnlPct), {
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
            botLogger.debug({ err: err.message, userId }, 'Failed to send close message');
          }
        }
      }
    } catch (err) {
      botLogger.error({ err: err.message }, 'Error broadcasting close');
    }
  });

  botLogger.info('Action handlers registered (v3.3-community)');
}

// ─── HELPERS ───────────────────────────────────────────────

function isAdmin(ctx) {
  return CONFIG.ADMIN_IDS.includes(String(ctx.from?.id));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── EXPORTS ───────────────────────────────────────────────

export { activeSignalMessages };
          
