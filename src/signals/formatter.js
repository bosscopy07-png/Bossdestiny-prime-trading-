// ==========================================
// SIGNAL FORMATTER
// Telegram message formatting — HTML mode
// ==========================================

import { CONFIG } from '../config/index.js';

/**
 * Format signal for Telegram display (HTML parse_mode)
 */
export function formatSignalMessage(signal) {
  const qualityEmoji = { 'A+': '🥇', 'A': '🥈', 'B+': '🥉', 'B': '📊' };
  
  const lines = [
    `╔══════════════════════════════════════════════════════════════╗`,
    `║     ${qualityEmoji[signal.quality] || '📊'} SIGNALALPHA CRYPTO SIGNAL ${qualityEmoji[signal.quality] || '📊'}     ║`,
    `║           [$${signal.challenge.startCapital} → $${signal.challenge.target} Challenge]              ║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    '',
    '📋 <b>SETUP DETAILS</b>',
    `Strategy: <b>${escapeHtml(signal.strategy)}</b> [${escapeHtml(signal.quality)}]`,
    `Direction: ${signal.direction === 'LONG' ? '🟢 <b>LONG</b>' : '🔴 <b>SHORT</b>'}`,
    `Confidence: <b>${signal.confidence.score}%</b> (${escapeHtml(signal.confidence.tier)})`,
    `Risk/Reward: <b>1:${signal.riskReward}</b>`,
    '',
    '💰 <b>ENTRY &amp; EXITS</b>',
    `Entry Zone: $${signal.entry.zone.min.toFixed(4)} - $${signal.entry.zone.max.toFixed(4)}`,
    `Stop Loss: $${signal.stopLoss.toFixed(4)} (${((Math.abs(signal.stopLoss - signal.entry.price) / signal.entry.price) * 100).toFixed(2)}%)`,
    `Take Profit 1: $${signal.takeProfit.toFixed(4)}`,
  ];

  if (signal.takeProfit2) {
    lines.push(`Take Profit 2: $${signal.takeProfit2.toFixed(4)}`);
  }

  lines.push(
    '',
    '⚙️ <b>POSITION</b>',
    `Risk: ${signal.position.riskPct}% ($${signal.position.riskAmount})`,
    `Leverage: ${signal.position.leverage}x`,
    `Position Size: $${signal.position.positionSize}`,
    `Margin Required: $${signal.position.margin}`,
    `Est. Profit: $${signal.position.estProfit} | Est. Loss: $${signal.position.estLoss}`,
    '',
    '📊 <b>ANALYSIS</b>',
    `Trend: ${escapeHtml(signal.analysis.trend)} (${signal.analysis.trendStrength}% strength)`,
    `Alignment: ${signal.analysis.trendAlignment ? '✅ Aligned' : '⚠️ Single TF'}`,
    `Momentum: RSI ${signal.analysis.rsi} (${escapeHtml(signal.analysis.rsiCondition)})`,
    `Volume: ${signal.analysis.volumeRatio}x avg (${escapeHtml(signal.analysis.volumeTrend)})`,
    `S/R: S $${signal.analysis.support} (${signal.analysis.supportTouches}t) / R $${signal.analysis.resistance} (${signal.analysis.resistanceTouches}t)`,
    `Structure: ${escapeHtml(signal.analysis.structure)}`,
    '',
    '🎯 <b>EXECUTION PLAN</b>',
    ...signal.execution.steps.map((step, i) => `${i + 1}. ${escapeHtml(step)}`),
    '',
    signal.execution.warning ? `⚠️ <b>WARNING:</b> ${escapeHtml(signal.execution.warning)}` : '',
    signal.execution.maxHold ? `⏰ Max Hold: ${escapeHtml(signal.execution.maxHold)}` : '',
    '',
    '📈 <b>CHALLENGE TRACKER</b>',
    `Progress: ${signal.challenge.progress}% ${'█'.repeat(Math.round(signal.challenge.progress / 10))}${'░'.repeat(10 - Math.round(signal.challenge.progress / 10))}`,
    `Current: $${signal.challenge.currentCapital} | Target: $${signal.challenge.target}`,
    '',
    '═══════════════════════════════════════════════════════════════',
    `🔗 <a href="${escapeHtml(CONFIG.REFERRAL.LINK)}">${escapeHtml(CONFIG.REFERRAL.LINK)}</a>`,
    `🎁 Code: <code>${escapeHtml(CONFIG.REFERRAL.CODE)}</code>`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `⚡ ${escapeHtml(signal.confidence.recommendation)}`,
    '',
    `🆔 Signal ID: <code>${signal.id.substr(0, 8)}</code>`
  );

  return lines.filter(Boolean).join('\n');
}

/**
 * Format dashboard message (HTML parse_mode)
 */
export function formatDashboard(stats, marketData, challenge) {
  const progressBar = (pct) => {
    const filled = Math.round(pct / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };

  const current = challenge.CURRENT_CAPITAL;
  const start = challenge.START_CAPITAL;
  const target = challenge.TARGET;
  const progress = ((current - start) / (target - start)) * 100;

  return [
    '🎯 <b>SIGNALALPHA DASHBOARD</b>',
    '',
    `💰 Capital: $${current.toFixed(2)} / $${target}`,
    `📈 Progress: ${Math.max(0, progress).toFixed(1)}% ${progressBar(progress)}`,
    `📅 Challenge: Day 1/${challenge.DAYS}`,
    '',
    '<b>System Status:</b>',
    `🔍 Scanning: ${stats.isScanning ? '🟢 ACTIVE' : '⚪ IDLE'}`,
    `📊 Markets: ${marketData.perpetualMarkets?.length || 0} tracked`,
    `🎯 Signals Today: ${stats.signalsToday}/${CONFIG.RISK.MAX_SIGNALS_PER_DAY}`,
    `⏱️ Last Scan: ${stats.lastScan ? new Date(stats.lastScan).toLocaleTimeString() : 'Never'}`,
    '',
    '<b>Risk Limits:</b>',
    `Daily Loss: ${CONFIG.RISK.DAILY_LOSS_LIMIT_PCT}% ($${(start * CONFIG.RISK.DAILY_LOSS_LIMIT_PCT / 100).toFixed(2)})`,
    `Max Consecutive Losses: ${CONFIG.RISK.MAX_CONSECUTIVE_LOSSES}`,
    `Active Signals: ${stats.activeSignals}`,
    `Cooldown: ${stats.riskStatus?.inCooldown ? '🔴 ACTIVE' : '🟢 Inactive'}`,
    '',
    `🎁 <a href="${escapeHtml(CONFIG.REFERRAL.LINK)}">Trade on BingX</a> | Code: <code>${escapeHtml(CONFIG.REFERRAL.CODE)}</code>`
  ].join('\n');
}

// ==========================================
// HELPERS
// ==========================================

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  if (typeof text !== 'string') return String(text);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
