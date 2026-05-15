// ==========================================
// SIGNAL FORMATTER
// Telegram message formatting
// ==========================================

import { CONFIG } from '../config/index.js';

/**
 * Format signal for Telegram display
 */
export function formatSignalMessage(signal) {
  const qualityEmoji = { 'A+': '🥇', 'A': '🥈', 'B+': '🥉', 'B': '📊' };
  
  const lines = [
    `╔══════════════════════════════════════════════════════════════╗`,
    `║     ${qualityEmoji[signal.quality] || '📊'} SIGNALALPHA CRYPTO SIGNAL ${qualityEmoji[signal.quality] || '📊'}     ║`,
    `║           [$${signal.challenge.startCapital} → $${signal.challenge.target} Challenge]              ║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    '',
    '📋 *SETUP DETAILS*',
    `Strategy: *${signal.strategy}* [${signal.quality}]`,
    `Direction: ${signal.direction === 'LONG' ? '🟢 *LONG*' : '🔴 *SHORT*'}`,
    `Confidence: *${signal.confidence.score}%* (${signal.confidence.tier})`,
    `Risk/Reward: *1:${signal.riskReward}*`,
    '',
    '💰 *ENTRY & EXITS*',
    `Entry Zone: $${signal.entry.zone.min.toFixed(4)} - $${signal.entry.zone.max.toFixed(4)}`,
    `Stop Loss: $${signal.stopLoss.toFixed(4)} (${((Math.abs(signal.stopLoss - signal.entry.price) / signal.entry.price) * 100).toFixed(2)}%)`,
    `Take Profit 1: $${signal.takeProfit.toFixed(4)}`,
  ];

  if (signal.takeProfit2) {
    lines.push(`Take Profit 2: $${signal.takeProfit2.toFixed(4)}`);
  }

  lines.push(
    '',
    '⚙️ *POSITION*',
    `Risk: ${signal.position.riskPct}% ($${signal.position.riskAmount})`,
    `Leverage: ${signal.position.leverage}x`,
    `Position Size: $${signal.position.positionSize}`,
    `Margin Required: $${signal.position.margin}`,
    `Est. Profit: $${signal.position.estProfit} | Est. Loss: $${signal.position.estLoss}`,
    '',
    '📊 *ANALYSIS*',
    `Trend: ${signal.analysis.trend} (${signal.analysis.trendStrength}% strength)`,
    `Alignment: ${signal.analysis.trendAlignment ? '✅ Aligned' : '⚠️ Single TF'}`,
    `Momentum: RSI ${signal.analysis.rsi} (${signal.analysis.rsiCondition})`,
    `Volume: ${signal.analysis.volumeRatio}x avg (${signal.analysis.volumeTrend})`,
    `S/R: S $${signal.analysis.support} (${signal.analysis.supportTouches}t) / R $${signal.analysis.resistance} (${signal.analysis.resistanceTouches}t)`,
    `Structure: ${signal.analysis.structure}`,
    '',
    '🎯 *EXECUTION PLAN*',
    ...signal.execution.steps.map((step, i) => `${i + 1}. ${step}`),
    '',
    signal.execution.warning ? `⚠️ *WARNING:* ${signal.execution.warning}` : '',
    signal.execution.maxHold ? `⏰ Max Hold: ${signal.execution.maxHold}` : '',
    '',
    '📈 *CHALLENGE TRACKER*',
    `Progress: ${signal.challenge.progress}% ${'█'.repeat(Math.round(signal.challenge.progress / 10))}${'░'.repeat(10 - Math.round(signal.challenge.progress / 10))}`,
    `Current: $${signal.challenge.currentCapital} | Target: $${signal.challenge.target}`,
    '',
    '═══════════════════════════════════════════════════════════════',
    `🔗 ${CONFIG.REFERRAL.LINK}`,
    `🎁 Code: ${CONFIG.REFERRAL.CODE}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `⚡ ${signal.confidence.recommendation}`,
    '',
    `🆔 Signal ID: \`${signal.id.substr(0, 8)}\``
  );

  return lines.filter(Boolean).join('\n');
}

/**
 * Format dashboard message
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
    '🎯 *SIGNALALPHA DASHBOARD*',
    '',
    `💰 Capital: $${current.toFixed(2)} / $${target}`,
    `📈 Progress: ${Math.max(0, progress).toFixed(1)}% ${progressBar(progress)}`,
    `📅 Challenge: Day 1/${challenge.DAYS}`,
    '',
    '*System Status:*',
    `🔍 Scanning: ${stats.isScanning ? '🟢 ACTIVE' : '⚪ IDLE'}`,
    `📊 Markets: ${marketData.perpetualMarkets?.length || 0} tracked`,
    `🎯 Signals Today: ${stats.signalsToday}/${CONFIG.RISK.MAX_SIGNALS_PER_DAY}`,
    `⏱️ Last Scan: ${stats.lastScan ? new Date(stats.lastScan).toLocaleTimeString() : 'Never'}`,
    '',
    '*Risk Limits:*',
    `Daily Loss: ${CONFIG.RISK.DAILY_LOSS_LIMIT_PCT}% ($${(start * CONFIG.RISK.DAILY_LOSS_LIMIT_PCT / 100).toFixed(2)})`,
    `Max Consecutive Losses: ${CONFIG.RISK.MAX_CONSECUTIVE_LOSSES}`,
    `Active Signals: ${stats.activeSignals}`,
    `Cooldown: ${stats.riskStatus?.inCooldown ? '🔴 ACTIVE' : '🟢 Inactive'}`,
    '',
    `🎁 [Trade on BingX](${CONFIG.REFERRAL.LINK}) | Code: \`${CONFIG.REFERRAL.CODE}\``
  ].join('\n');
                   }
