// ==========================================
// SIGNAL FORMATTER
// Telegram message formatting — HTML mode
// FIXED: Correct fields, adaptive price formatting, clean symbols
// ==========================================

import { CONFIG } from '../config/index.js';

/**
 * Format price based on magnitude — prevents $0.0000 for sub-penny coins
 */
function fmtPrice(price) {
  if (price === undefined || price === null) return 'N/A';
  const p = parseFloat(price);
  if (isNaN(p)) return 'N/A';
  
  if (p >= 10000) return p.toFixed(0);
  if (p >= 1000) return p.toFixed(1);
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(6);
  if (p >= 0.0001) return p.toFixed(8);
  if (p >= 0.000001) return p.toFixed(10);
  return p.toExponential(4);
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
 * Escape HTML special characters
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
 * Format signal for Telegram display (HTML parse_mode)
 * FIXED: Uses correct position fields, adaptive prices, clean symbol
 */
export function formatSignalMessage(signal) {
  const qualityEmoji = { 'A+': '🥇', 'A': '🥈', 'A-': '🥈', 'B+': '🥉', 'B': '📊', 'C+': '📉', 'C': '📉' };
  const emoji = qualityEmoji[signal.quality] || '📊';
  
  // Use displaySymbol if available, otherwise clean it
  const displaySymbol = signal.displaySymbol || cleanSymbol(signal.symbol);
  const fullSymbol = signal.symbol || 'UNKNOWN';

  const lines = [
    `╔══════════════════════════════════════════════════════════════╗`,
    `║     ${emoji} SIGNALALPHA CRYPTO SIGNAL ${emoji}     ║`,
    `║           [$${signal.challenge?.startCapital || '10'} → $${signal.challenge?.target || '100'} Challenge]              ║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    '',
    '📋 <b>SETUP DETAILS</b>',
    `Strategy: <b>${escapeHtml(signal.strategy)}</b> [${escapeHtml(signal.quality)}]`,
    `Pair: <b>${escapeHtml(displaySymbol)}</b> <code>${escapeHtml(fullSymbol)}</code>`,
    `Direction: ${signal.direction === 'LONG' ? '🟢 <b>LONG</b>' : '🔴 <b>SHORT</b>'}`,
    `Confidence: <b>${signal.confidence?.score || 0}%</b> (${escapeHtml(signal.confidence?.tier || '?')})`,
    `Risk/Reward: <b>1:${signal.riskReward || '?'}</b>`,
    '',
    '💰 <b>ENTRY &amp; EXITS</b>',
    `Entry Zone: $${fmtPrice(signal.entry?.zone?.min)} - $${fmtPrice(signal.entry?.zone?.max)}`,
    `Stop Loss: $${fmtPrice(signal.stopLoss)} (${((Math.abs((signal.stopLoss || 0) - (signal.entry?.price || 0)) / (signal.entry?.price || 1)) * 100).toFixed(2)}%)`,
    `Take Profit 1: $${fmtPrice(signal.takeProfit)}`,
  ];

  if (signal.takeProfit2) {
    lines.push(`Take Profit 2: $${fmtPrice(signal.takeProfit2)}`);
  }

  // FIXED: Use correct position fields
  const pos = signal.position || {};
  lines.push(
    '',
    '⚙️ <b>POSITION</b>',
    `Risk: ${pos.riskPct || 0}% ($${pos.riskAmount || '0.00'})`,
    `Leverage: ${pos.leverage || 1}x`,
    `Size: <code>${pos.baseQty || '0'}</code> ${escapeHtml(displaySymbol)}`,
    `Notional: $${pos.notionalValue || '0.00'}`,
    `Margin: $${pos.margin || '0.00'}`,
    `Est. Profit: $${pos.estProfit || '0.00'} | Est. Loss: $${pos.estLoss || '0.00'}`,
    '',
    '📊 <b>ANALYSIS</b>',
    `Trend: ${escapeHtml(signal.analysis?.trend || '?')} (${signal.analysis?.trendStrength || 0}% strength)`,
    `Alignment: ${signal.analysis?.trendAlignment === 'aligned' ? '✅ Aligned' : '⚠️ Single TF'}`,
    `Momentum: RSI ${signal.analysis?.rsi || '?'} (${escapeHtml(signal.analysis?.rsiCondition || '?')})`,
    `Volume: ${signal.analysis?.volumeRatio || 0}x avg (${escapeHtml(signal.analysis?.volumeTrend || '?')})`,
    `S/R: S $${fmtPrice(signal.analysis?.support)} (${signal.analysis?.supportTouches || 0}t) / R $${fmtPrice(signal.analysis?.resistance)} (${signal.analysis?.resistanceTouches || 0}t)`,
    `Structure: ${escapeHtml(signal.analysis?.structure || '?')}`,
    `ATR: ${signal.analysis?.atr || 'N/A'}`,
    '',
    '🎯 <b>EXECUTION PLAN</b>',
    ...(signal.execution?.steps || []).map((step, i) => `${i + 1}. ${escapeHtml(step)}`),
  );

  if (signal.execution?.scalePrice) {
    lines.push(`💡 Scale 50% at $${fmtPrice(signal.execution.scalePrice)}`);
  }

  if (signal.execution?.warning) {
    lines.push(`⚠️ <b>WARNING:</b> ${escapeHtml(signal.execution.warning)}`);
  }

  if (signal.execution?.maxHold) {
    lines.push(`⏰ Max Hold: ${escapeHtml(signal.execution.maxHold)}`);
  }

  lines.push(
    '',
    '📈 <b>CHALLENGE TRACKER</b>',
    `Progress: ${signal.challenge?.progress || 0}% ${'█'.repeat(Math.round((signal.challenge?.progress || 0) / 10))}${'░'.repeat(10 - Math.round((signal.challenge?.progress || 0) / 10))}`,
    `Current: $${signal.challenge?.currentCapital || '0.00'} | Target: $${signal.challenge?.target || '0'}`,
    '',
    '═══════════════════════════════════════════════════════════════',
    `🔗 <a href="${escapeHtml(CONFIG?.REFERRAL?.LINK || '#')}">${escapeHtml(CONFIG?.REFERRAL?.LINK || 'Trade Now')}</a>`,
    `🎁 Code: <code>${escapeHtml(CONFIG?.REFERRAL?.CODE || 'NONE')}</code>`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `⚡ ${escapeHtml(signal.confidence?.recommendation || 'No recommendation')}`,
    '',
    `🆔 Signal ID: <code>${(signal.id || 'unknown').substr(0, 8)}</code>`
  );

  return lines.filter(Boolean).join('\n');
}

/**
 * Format signal closure message
 */
export function formatCloseMessage(signal, result, exitPrice, pnl, pnlPct) {
  const displaySymbol = signal.displaySymbol || cleanSymbol(signal.symbol);
  const isWin = result.includes('take_profit');
  const emoji = isWin ? '✅' : result.includes('stop_loss') ? '❌' : '⏰';
  const resultText = result === 'take_profit_2' ? 'TAKE PROFIT 2' : 
                     result === 'take_profit' ? 'TAKE PROFIT 1' :
                     result === 'stop_loss' ? 'STOP LOSS' : 'EXPIRED';

  return [
    `${emoji} <b>SIGNAL CLOSED</b> ${emoji}`,
    '',
    `<b>${escapeHtml(displaySymbol)} ${signal.direction}</b>`,
    `Result: <b>${resultText}</b>`,
    `Exit: $${fmtPrice(exitPrice)}`,
    `P&L: $${Math.abs(pnl).toFixed(2)} (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`,
    '',
    `Updated Capital: $${(signal.challenge?.currentCapital || 0)}`,
    '',
    `🆔 ID: <code>${(signal.id || '').substr(0, 8)}</code>`
  ].join('\n');
}

/**
 * Format dashboard message (HTML parse_mode)
 */
export function formatDashboard(stats, marketData, challenge) {
  const progressBar = (pct) => {
    const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };

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
      
