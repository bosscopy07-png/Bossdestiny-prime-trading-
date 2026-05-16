// ==========================================
// SIGNAL FORMATTER
// Telegram message formatting — 2-Page HTML mode
// VERSION: 3.3-community
// ==========================================

import { CONFIG } from '../config/index.js';

// ─── HELPERS ───────────────────────────────────────────────

/**
 * Format price based on magnitude — prevents $0.0000 for sub-penny coins
 */
function fmtPrice(p) {
  if (p === undefined || p === null) return 'N/A';
  const val = parseFloat(p);
  if (isNaN(val)) return 'N/A';
  if (val >= 10000) return val.toFixed(0);
  if (val >= 1000) return val.toFixed(1);
  if (val >= 100) return val.toFixed(2);
  if (val >= 1) return val.toFixed(4);
  if (val >= 0.01) return val.toFixed(6);
  if (val >= 0.0001) return val.toFixed(8);
  if (val >= 0.000001) return val.toFixed(10);
  return val.toExponential(4);
}

/**
 * Clean symbol for display: PEPE/USDT:USDT → PEPE
 */
function cleanSymbol(symbol) {
  if (!symbol) return 'UNKNOWN';
  return symbol
    .replace(/:USDT$/, '')
    .replace(/:USD$/, '')
    .replace(/\/USDT$/, '')
    .replace(/\/USD$/, '');
}

/**
 * Escape HTML special characters for Telegram parse_mode: HTML
 */
function escapeHtml(text) {
  if (text === undefined || text === null) return '';
  if (typeof text !== 'string') return String(text);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Progress bar string
 */
function progressBar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(parseFloat(pct || 0) / 10)));
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// ─── PAGE 1: TRADE EXECUTION ───────────────────────────────

/**
 * Format Page 1: All info needed to place the trade
 */
export function formatSignalPage1(signal) {
  const displaySymbol = signal.displaySymbol || cleanSymbol(signal.symbol);
  const qualityEmoji = { 
    'A+': '🥇', 'A': '🥈', 'A-': '🥈', 
    'B+': '🥉', 'B': '📊', 
    'C+': '⚠️', 'C': '🚫', 'D': '⛔' 
  };
  const emoji = qualityEmoji[signal.quality] || '📊';
  
  const lines = [
    `╔══════════════════════════════════════════════════════════════╗`,
    `║     ${emoji} SIGNALALPHA CRYPTO SIGNAL ${emoji}     ║`,
    `║           [$${signal.challenge?.startCapital || '10'} → $${signal.challenge?.target || '100'} Challenge]              ║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    '',
    '📋 <b>SETUP DETAILS</b>',
    `Strategy: <b>${escapeHtml(signal.strategy)}</b> [${escapeHtml(signal.quality)}]`,
    `Pair: <b>${escapeHtml(displaySymbol)}</b>`,
    `Direction: ${signal.direction === 'LONG' ? '🟢 <b>LONG</b>' : '🔴 <b>SHORT</b>'}`,
    `Confidence: <b>${signal.confidence?.score || 0}%</b> (${escapeHtml(signal.confidence?.tier || '?')})`,
    `Risk/Reward: <b>1:${signal.riskReward || '?'}</b>`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '💰 <b>ENTRY &amp; EXITS</b>',
    '',
    `<b>Entry Zone:</b>`,
    `$${fmtPrice(signal.entry?.zone?.min)} — $${fmtPrice(signal.entry?.zone?.max)}`,
    '',
    `<b>Stop Loss:</b> $${fmtPrice(signal.stopLoss)}`,
    `<i>${((Math.abs((signal.stopLoss || 0) - (signal.entry?.price || 0)) / (signal.entry?.price || 1)) * 100).toFixed(2)}% risk</i>`,
    '',
    `<b>Target 1:</b> $${fmtPrice(signal.takeProfit)}`,
  ];

  if (signal.takeProfit2) {
    lines.push(`<<b>Target 2:</b> $${fmtPrice(signal.takeProfit2)}`);
  }

  lines.push(
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '⚙️ <b>POSITION SIZE</b>',
    '',
    `<b>Risk:</b> ${signal.position?.riskPct || 0}% ($${signal.position?.riskAmount || '0.00'})`,
    `<b>Leverage:</b> ${signal.position?.leverage || 1}x`,
    `<b>Size:</b> <code>${signal.position?.baseQty || '0'}</code> ${escapeHtml(displaySymbol)}`,
    `<b>Notional:</b> $${signal.position?.notionalValue || '0.00'}`,
    `<b>Margin:</b> $${signal.position?.margin || '0.00'}`,
    '',
    `<b>Est. Profit:</b> $${signal.position?.estProfit || '0.00'}`,
    `<b>Est. Loss:</b> $${signal.position?.estLoss || '0.00'}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '🎯 <b>EXECUTION PLAN</b>',
    ...(signal.execution?.steps || []).map((step, i) => `${i + 1}. ${escapeHtml(step)}`),
    '',
    signal.execution?.scalePrice ? `💡 <b>Scale 50% at:</b> $${escapeHtml(signal.execution.scalePrice)}` : '',
    signal.execution?.warning ? `⚠️ <b>WARNING:</b> ${escapeHtml(signal.execution.warning)}` : '',
    '',
    `⏰ <b>Max Hold:</b> ${escapeHtml(signal.execution?.maxHold || '4-8 hours')}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    `⚡ <b>${escapeHtml(signal.confidence?.recommendation || 'No recommendation')}</b>`,
    '',
    `🆔 Signal ID: <code>${(signal.id || 'unknown').substr(0, 8)}</code>`,
    '',
    '📄 <i>Page 1 of 2 — Tap ▶️ Analysis for full breakdown</i>',
  );

  return lines.filter(Boolean).join('\n');
}

// ─── PAGE 2: ANALYSIS & CONTEXT ────────────────────────────

/**
 * Format Page 2: Technical analysis and context
 */
export function formatSignalPage2(signal) {
  const displaySymbol = signal.displaySymbol || cleanSymbol(signal.symbol);
  const a = signal.analysis || {};
  
  const lines = [
    `╔══════════════════════════════════════════════════════════════╗`,
    `║     📊 ${escapeHtml(displaySymbol)} TECHNICAL ANALYSIS     ║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    '',
    '📈 <b>TREND ANALYSIS</b>',
    '',
    `Direction: <b>${escapeHtml(a.trend || '?')}</b> (${a.trendStrength || 0}% strength)`,
    `Alignment: ${a.trendAlignment === 'aligned' ? '✅ <b>Multi-TF Aligned</b>' : '⚠️ <b>Single TF Only</b>'}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '⚡ <b>MOMENTUM</b>',
    '',
    `RSI: <b>${a.rsi || '?'}</b> (${escapeHtml(a.rsiCondition || '?')})`,
    `MACD: <b>${escapeHtml(a.macdTrend || '?')}</b> (${escapeHtml(a.macdCrossover || 'none')})`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '📊 <b>VOLUME &amp; STRUCTURE</b>',
    '',
    `Volume Ratio: <b>${a.volumeRatio || '1.00'}x</b> average`,
    `Volume Trend: ${escapeHtml(a.volumeTrend || 'normal')}`,
    `ATR: <b>${escapeHtml(a.atr || 'N/A')}</b>`,
    '',
    `Support: $${escapeHtml(a.support)} <i>(${a.supportTouches || 0} touches)</i>`,
    `Resistance: $${escapeHtml(a.resistance)} <i>(${a.resistanceTouches || 0} touches)</i>`,
    `Structure: ${escapeHtml(a.structure || '?')}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '📈 <b>CHALLENGE TRACKER</b>',
    '',
    `Progress: ${signal.challenge?.progress || 0}%`,
    `${progressBar(signal.challenge?.progress)}`,
    '',
    `Start: $${signal.challenge?.startCapital || '0.00'}`,
    `Current: <b>$${signal.challenge?.currentCapital || '0.00'}</b>`,
    `Target: $${signal.challenge?.target || '100'}`,
    `Days Left: ${signal.challenge?.daysLeft || '?'}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '🔗 <b>TRADE NOW</b>',
    '',
    `🎁 <a href="${escapeHtml(CONFIG?.REFERRAL?.LINK || '#')}">Open ${escapeHtml(displaySymbol)} on BingX</a>`,
    `🎁 Code: <code>${escapeHtml(CONFIG?.REFERRAL?.CODE || 'NONE')}</code>`,
    '',
    `🆔 Signal ID: <code>${(signal.id || 'unknown').substr(0, 8)}</code>`,
    '',
    '📄 <i>Page 2 of 2 — Tap ◀️ Trade for entry details</i>',
  ];

  return lines.filter(Boolean).join('\n');
}

// ─── SIGNAL CLOSED MESSAGE ─────────────────────────────────

/**
 * Format signal closure/result message
 */
export function formatCloseMessage(signal, result, exitPrice, pnl, pnlPct) {
  const displaySymbol = signal.displaySymbol || cleanSymbol(signal.symbol);
  const isWin = result.includes('take_profit');
  const isTP2 = result === 'take_profit_2';
  const emoji = isTP2 ? '🏆' : isWin ? '✅' : result.includes('stop_loss') ? '❌' : '⏰';
  
  const resultText = {
    'take_profit_2': 'TAKE PROFIT 2 🏆',
    'take_profit': 'TAKE PROFIT 1 ✅',
    'stop_loss': 'STOP LOSS ❌',
    'time_expired': 'TIME EXPIRED ⏰',
  }[result] || result.toUpperCase();

  const lines = [
    `╔══════════════════════════════════════════════════════════════╗`,
    `║     ${emoji} SIGNAL CLOSED ${emoji}     ║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    '',
    `<b>${escapeHtml(displaySymbol)} ${signal.direction}</b>`,
    '',
    `Result: <b>${resultText}</b>`,
    `Exit Price: $${fmtPrice(exitPrice)}`,
    '',
    `P&amp;L: <b>$${Math.abs(pnl || 0).toFixed(2)}</b> (${pnlPct > 0 ? '+' : ''}${(pnlPct || 0).toFixed(2)}%)`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    `Updated Capital: <b>$${(signal.challenge?.currentCapital || 0)}</b>`,
    `Progress: ${signal.challenge?.progress || 0}% ${progressBar(signal.challenge?.progress)}`,
    '',
    `🆔 Signal ID: <code>${(signal.id || '').substr(0, 8)}</code>`,
  ];

  return lines.filter(Boolean).join('\n');
}

// ─── DASHBOARD MESSAGE ─────────────────────────────────────

/**
 * Format system dashboard/status message
 */
export function formatDashboard(stats, marketData, challenge) {
  const current = challenge?.CURRENT_CAPITAL || 0;
  const start = challenge?.START_CAPITAL || 10;
  const target = challenge?.TARGET || 100;
  const progress = ((current - start) / (target - start)) * 100;

  return [
    '🎯 <b>SIGNALALPHA DASHBOARD</b>',
    '',
    `💰 Capital: $${current.toFixed(2)} / $${target}`,
    `📈 Progress: ${Math.max(0, progress).toFixed(1)}% ${progressBar(progress)}`,
    `📅 Challenge: Day 1/${challenge?.DAYS || 30}`,
    '',
    '<b>System Status:</b>',
    `🔍 Scanning: ${stats?.isScanning ? '🟢 ACTIVE' : '⚪ IDLE'}`,
    `📊 Markets: ${marketData?.perpetualMarkets?.length || 0} tracked`,
    `🎯 Signals Today: ${stats?.signalsToday || 0}/${CONFIG?.RISK?.MAX_SIGNALS_PER_DAY || 5}`,
    `⏱️ Last Scan: ${stats?.lastScan ? new Date(stats.lastScan).toLocaleTimeString() : 'Never'}`,
    '',
    '<b>Risk Limits:</b>',
    `Daily Loss: ${CONFIG?.RISK?.DAILY_LOSS_LIMIT_PCT || 5}% ($${(start * (CONFIG?.RISK?.DAILY_LOSS_LIMIT_PCT || 5) / 100).toFixed(2)})`,
    `Max Consecutive Losses: ${CONFIG?.RISK?.MAX_CONSECUTIVE_LOSSES || 3}`,
    `Active Signals: ${stats?.activeSignals || 0}`,
    `Cooldown: ${stats?.riskStatus?.cooldownLevel > 0 ? `🔴 LEVEL ${stats.riskStatus.cooldownLevel}` : '🟢 Inactive'}`,
    '',
    `🎁 <a href="${escapeHtml(CONFIG?.REFERRAL?.LINK || '#')}">Trade on BingX</a> | Code: <code>${escapeHtml(CONFIG?.REFERRAL?.CODE || 'NONE')}</code>`
  ].join('\n');
}

// ─── TELEGRAM BUTTONS ───────────────────────────────────────

/**
 * Get inline keyboard buttons for 2-page navigation
 */
export function getSignalButtons(signal) {
  return {
    inline_keyboard: [
      [
        { text: '◀️ Trade Details', callback_data: `signal_page1_${signal.id}` },
        { text: '▶️ Analysis', callback_data: `signal_page2_${signal.id}` },
      ],
      [
        { text: '📊 Chart', url: `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(signal.symbol || '')}` },
        { text: '⚡ Trade Now', url: CONFIG?.REFERRAL?.LINK || '#' },
      ],
    ],
  };
}

/**
 * Get buttons for closed signal (no navigation needed)
 */
export function getCloseButtons(signal) {
  return {
    inline_keyboard: [
      [
        { text: '📊 View Chart', url: `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(signal.symbol || '')}` },
        { text: '⚡ New Trade', url: CONFIG?.REFERRAL?.LINK || '#' },
      ],
    ],
  };
    }
    
