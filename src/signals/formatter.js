
// ==========================================
// SIGNAL FORMATTER
// Telegram message formatting — 2-Page HTML mode
// VERSION: 4.0-fresh — Complete rewrite
// ==========================================

// ─── CONFIG ────────────────────────────────────────────────

const QUALITY_EMOJI = {
  'A+': '🥇',
  'A':  '🥈',
  'A-': '🥈',
  'B+': '🥉',
  'B':  '📊',
  'C+': '⚠️',
  'C':  '🚫',
  'D':  '⛔'
};

const DIRECTION_EMOJI = {
  'LONG':  '🟢',
  'SHORT': '🔴'
};

// ─── PRICE FORMATTER ───────────────────────────────────────

function formatPrice(value) {
  if (value === undefined || value === null) return 'N/A';
  
  const num = Number(value);
  if (Number.isNaN(num)) return 'N/A';
  if (num === 0) return '0';
  
  const abs = Math.abs(num);
  
  if (abs >= 100000) return num.toFixed(0);
  if (abs >= 10000)  return num.toFixed(1);
  if (abs >= 1000)   return num.toFixed(2);
  if (abs >= 100)    return num.toFixed(2);
  if (abs >= 10)     return num.toFixed(3);
  if (abs >= 1)      return num.toFixed(4);
  if (abs >= 0.1)    return num.toFixed(5);
  if (abs >= 0.01)   return num.toFixed(6);
  if (abs >= 0.001)  return num.toFixed(7);
  if (abs >= 0.0001) return num.toFixed(8);
  if (abs >= 0.00001)return num.toFixed(9);
  
  return num.toExponential(4);
}

// ─── SYMBOL CLEANER ────────────────────────────────────────

function cleanSymbol(raw) {
  if (!raw || typeof raw !== 'string') return 'UNKNOWN';
  
  return raw
    .replace(/:USDT$/, '')
    .replace(/:USD$/, '')
    .replace(/\/USDT$/, '')
    .replace(/\/USD$/, '')
    .replace(/-PERP$/, '')
    .replace(/_PERP$/, '');
}

// ─── HTML ESCAPER ──────────────────────────────────────────

function html(text) {
  if (text === undefined || text === null) return '';
  if (typeof text !== 'string') return String(text);
  
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── PROGRESS BAR ─────────────────────────────────────────

function progressBar(percent) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

// ─── RISK PERCENT CALCULATOR ──────────────────────────────

function calcRiskPercent(entry, stop) {
  const e = Number(entry);
  const s = Number(stop);
  if (!e || !s || e === 0) return '0.00';
  
  return ((Math.abs(s - e) / e) * 100).toFixed(2);
}

// ─── PAGE 1: TRADE EXECUTION ──────────────────────────────

/**
 * Format signal Page 1 — Everything needed to place the trade
 */
export function formatPage1(signal) {
  const sym = cleanSymbol(signal?.symbol);
  const fullSym = html(signal?.symbol || 'UNKNOWN');
  const emoji = QUALITY_EMOJI[signal?.quality] || '📊';
  const dirEmoji = DIRECTION_EMOJI[signal?.direction] || '⚪';
  const dir = signal?.direction || '?';
  
  const entry = signal?.entry?.price || 0;
  const stop = signal?.stopLoss || 0;
  const tp1 = signal?.takeProfit || 0;
  const tp2 = signal?.takeProfit2;
  
  const riskPct = signal?.position?.riskPct || 0;
  const riskAmt = signal?.position?.riskAmount || '0.00';
  const leverage = signal?.position?.leverage || 1;
  const baseQty = signal?.position?.baseQty || '0';
  const notional = signal?.position?.notionalValue || '0.00';
  const margin = signal?.position?.margin || '0.00';
  const estProfit = signal?.position?.estProfit || '0.00';
  const estLoss = signal?.position?.estLoss || '0.00';
  
  const confidence = signal?.confidence?.score || 0;
  const tier = signal?.confidence?.tier || '?';
  const rr = signal?.riskReward || '?';
  const quality = signal?.quality || '?';
  const strategy = signal?.strategy || '?';
  
  const rec = signal?.confidence?.recommendation || 'No recommendation';
  const maxHold = signal?.execution?.maxHold || '4-8 hours';
  const sigId = (signal?.id || '').substring(0, 8);
  
  const lines = [
    `╔══════════════════════════════════════════════════════════════╗`,
    `║     ${emoji} SIGNALALPHA CRYPTO SIGNAL ${emoji}     ║`,
    `║           [$10 → $100 Challenge]              ║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    '',
    '📋 <b>SETUP</b>',
    `Pair: <b>${html(sym)}</b> <code>${fullSym}</code>`,
    `Strategy: <b>${html(strategy)}</b> [${html(quality)}]`,
    `Direction: ${dirEmoji} <b>${dir}</b>`,
    `Confidence: <b>${confidence}%</b> (${html(tier)})`,
    `R:R: <b>1:${html(rr)}</b>`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '💰 <b>ENTRY &amp; EXITS</b>',
    '',
    `<b>Entry Zone:</b>`,
    `$${formatPrice(signal?.entry?.zone?.min)} — $${formatPrice(signal?.entry?.zone?.max)}`,
    '',
    `<b>Stop Loss:</b> $${formatPrice(stop)}`,
    `<i>${calcRiskPercent(entry, stop)}% risk from entry</i>`,
    '',
    `<b>Target 1:</b> $${formatPrice(tp1)}`,
  ];
  
  if (tp2) {
    lines.push(`<<b>Target 2:</b> $${formatPrice(tp2)}`);
  }
  
  lines.push(
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '⚙️ <b>POSITION</b>',
    '',
    `<b>Risk:</b> ${riskPct}% ($${html(riskAmt)})`,
    `<b>Leverage:</b> ${leverage}x`,
    `<b>Size:</b> <code>${html(baseQty)}</code> ${html(sym)}`,
    `<b>Notional:</b> $${html(notional)}`,
    `<b>Margin:</b> $${html(margin)}`,
    '',
    `<b>Est. Profit:</b> $${html(estProfit)}`,
    `<b>Est. Loss:</b> $${html(estLoss)}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '🎯 <b>PLAN</b>',
  );
  
  const steps = signal?.execution?.steps || [];
  for (let i = 0; i < steps.length; i++) {
    lines.push(`${i + 1}. ${html(steps[i])}`);
  }
  
  const scale = signal?.execution?.scalePrice;
  if (scale) {
    lines.push(`💡 <b>Scale 50%:</b> $${html(scale)}`);
  }
  
  const warning = signal?.execution?.warning;
  if (warning) {
    lines.push(`⚠️ <b>${html(warning)}</b>`);
  }
  
  lines.push(
    '',
    `⏰ <b>Max Hold:</b> ${html(maxHold)}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    `⚡ <b>${html(rec)}</b>`,
    '',
    `🆔 <code>${html(sigId)}</code>`,
    '',
    '📄 <i>Page 1 of 2 — Tap ▶️ for technical analysis</i>'
  );
  
  return lines.join('\n');
}

// ─── PAGE 2: TECHNICAL ANALYSIS ───────────────────────────

/**
 * Format signal Page 2 — Technical breakdown and context
 */
export function formatPage2(signal) {
  const sym = cleanSymbol(signal?.symbol);
  const a = signal?.analysis || {};
  
  const trend = a.trend || '?';
  const strength = a.trendStrength || 0;
  const alignment = a.trendAlignment || 'single';
  const rsi = a.rsi || '?';
  const rsiCond = a.rsiCondition || '?';
  const macdTrend = a.macdTrend || '?';
  const macdCross = a.macdCrossover || 'none';
  const volRatio = a.volumeRatio || '1.00';
  const volTrend = a.volumeTrend || 'normal';
  const atr = a.atr || 'N/A';
  const support = a.support || 'N/A';
  const resistance = a.resistance || 'N/A';
  const sTouches = a.supportTouches || 0;
  const rTouches = a.resistanceTouches || 0;
  const structure = a.structure || '?';
  
  const progress = signal?.challenge?.progress || 0;
  const current = signal?.challenge?.currentCapital || '0.00';
  const target = signal?.challenge?.target || '100';
  const start = signal?.challenge?.startCapital || '10';
  const daysLeft = signal?.challenge?.daysLeft || '?';
  
  const sigId = (signal?.id || '').substring(0, 8);
  
  const lines = [
    `╔══════════════════════════════════════════════════════════════╗`,
    `║     📊 ${html(sym)} TECHNICALS     ║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    '',
    '📈 <b>TREND</b>',
    '',
    `Direction: <b>${html(trend)}</b> (${strength}% strength)`,
    `Alignment: ${alignment === 'aligned' ? '✅ <b>Multi-TF</b>' : '⚠️ <b>Single TF</b>'}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '⚡ <b>MOMENTUM</b>',
    '',
    `RSI: <b>${html(rsi)}</b> (${html(rsiCond)})`,
    `MACD: <b>${html(macdTrend)}</b> (${html(macdCross)})`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '📊 <b>VOLUME &amp; STRUCTURE</b>',
    '',
    `Volume: <b>${html(volRatio)}x</b> avg (${html(volTrend)})`,
    `ATR: <b>${html(atr)}</b>`,
    '',
    `Support: $${html(support)} <i>(${sTouches} touches)</i>`,
    `Resistance: $${html(resistance)} <i>(${rTouches} touches)</i>`,
    `Structure: ${html(structure)}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '📈 <b>CHALLENGE</b>',
    '',
    `Progress: ${progress}%`,
    `${progressBar(progress)}`,
    '',
    `Start: $${html(start)}`,
    `Current: <b>$${html(current)}</b>`,
    `Target: $${html(target)}`,
    `Days: ${html(daysLeft)}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '🔗 <b>LINKS</b>',
    '',
    '📊 <a href="https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(signal?.symbol || '') + '">View Chart</a>',
    '⚡ <a href="https://bingx.com">Trade Now</a>',
    '',
    `🆔 <code>${html(sigId)}</code>`,
    '',
    '📄 <i>Page 2 of 2 — Tap ◀️ for trade details</i>'
  ];
  
  return lines.join('\n');
}

// ─── SIGNAL CLOSED ─────────────────────────────────────────

/**
 * Format signal closure message
 */
export function formatClosed(signal, result, exitPrice, pnl, pnlPct) {
  const sym = cleanSymbol(signal?.symbol);
  const isWin = String(result).includes('take_profit');
  const isTP2 = result === 'take_profit_2';
  const isSL = result === 'stop_loss';
  
  const emoji = isTP2 ? '🏆' : isWin ? '✅' : isSL ? '❌' : '⏰';
  
  const resultLabels = {
    'take_profit_2': 'TAKE PROFIT 2',
    'take_profit':   'TAKE PROFIT 1',
    'stop_loss':     'STOP LOSS',
    'time_expired':  'TIME EXPIRED'
  };
  const resultText = resultLabels[String(result)] || String(result).toUpperCase();
  
  const pnlNum = Number(pnl) || 0;
  const pnlPctNum = Number(pnlPct) || 0;
  const sign = pnlNum >= 0 ? '+' : '';
  
  const current = signal?.challenge?.currentCapital || '0.00';
  const progress = signal?.challenge?.progress || 0;
  
  const lines = [
    `╔══════════════════════════════════════════════════════════════╗`,
    `║     ${emoji} SIGNAL CLOSED ${emoji}     ║`,
    `╚══════════════════════════════════════════════════════════════╝`,
    '',
    `<b>${html(sym)} ${signal?.direction || '?'}</b>`,
    '',
    `Result: <b>${html(resultText)}</b>`,
    `Exit: $${formatPrice(exitPrice)}`,
    '',
    `P&amp;L: <b>$${Math.abs(pnlNum).toFixed(2)}</b> (${sign}${pnlPctNum.toFixed(2)}%)`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    `Capital: <b>$${html(current)}</b>`,
    `Progress: ${progress}% ${progressBar(progress)}`,
    '',
    `🆔 <code>${html((signal?.id || '').substring(0, 8))}</code>`
  ];
  
  return lines.join('\n');
}

// ─── DASHBOARD ─────────────────────────────────────────────

/**
 * Format system dashboard
 */
export function formatDashboard(stats, marketData, challenge) {
  const current = Number(challenge?.CURRENT_CAPITAL) || 0;
  const start = Number(challenge?.START_CAPITAL) || 10;
  const target = Number(challenge?.TARGET) || 100;
  const progress = ((current - start) / (target - start)) * 100;
  
  const isScanning = stats?.isScanning || false;
  const signalsToday = stats?.signalsToday || 0;
  const maxSignals = 5;
  const active = stats?.activeSignals || 0;
  const markets = marketData?.perpetualMarkets?.length || 0;
  const lastScan = stats?.lastScan;
  
  const riskStatus = stats?.riskStatus || {};
  const cooldown = riskStatus.cooldownLevel || 0;
  
  const lines = [
    '🎯 <b>SIGNALALPHA DASHBOARD</b>',
    '',
    `💰 Capital: $${current.toFixed(2)} / $${target}`,
    `📈 Progress: ${Math.max(0, progress).toFixed(1)}% ${progressBar(progress)}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '<b>STATUS</b>',
    '',
    `Scanning: ${isScanning ? '🟢 ACTIVE' : '⚪ IDLE'}`,
    `Markets: ${markets} tracked`,
    `Signals Today: ${signalsToday}/${maxSignals}`,
    `Active: ${active}`,
    `Cooldown: ${cooldown > 0 ? `🔴 Level ${cooldown}` : '🟢 Clear'}`,
    '',
    lastScan ? `Last Scan: ${new Date(lastScan).toLocaleTimeString()}` : 'Last Scan: Never',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━',
    '🎁 <a href="https://bingx.com">Trade on BingX</a>'
  ];
  
  return lines.join('\n');
}

// ─── BUTTON GENERATORS ─────────────────────────────────────

/**
 * Get buttons for active signal (2-page navigation)
 */
export function getSignalButtons(signalId) {
  return {
    inline_keyboard: [
      [
        { text: '◀️ Trade', callback_data: `PAGE1_${signalId}` },
        { text: '▶️ Analysis', callback_data: `PAGE2_${signalId}` }
      ],
      [
        { text: '✅ Taking', callback_data: `TAKEN_${signalId}` },
        { text: '❌ Skip', callback_data: `SKIPPED_${signalId}` }
      ],
      [
        { text: '📊 Dashboard', callback_data: 'DASHBOARD' }
      ]
    ]
  };
}

/**
 * Get buttons for closed signal
 */
export function getCloseButtons() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Dashboard', callback_data: 'DASHBOARD' },
        { text: '🎯 New Signal', callback_data: 'GET_SIGNAL' }
      ]
    ]
  };
}

// ─── TELEGRAF MARKUP VERSIONS ─────────────────────────────

/**
 * Telegraf Markup version for Page 1
 */
export function getPage1Markup(signalId) {
  // Dynamic import to avoid hard dependency
  try {
    const { Markup } = require('telegraf');
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('◀️ Trade', `PAGE1_${signalId}`),
        Markup.button.callback('▶️ Analysis', `PAGE2_${signalId}`)
      ],
      [
        Markup.button.callback('✅ Taking', `TAKEN_${signalId}`),
        Markup.button.callback('❌ Skip', `SKIPPED_${signalId}`)
      ],
      [
        Markup.button.callback('📊 Dashboard', 'DASHBOARD')
      ]
    ]);
  } catch {
    return undefined;
  }
}

/**
 * Telegraf Markup version for closed signal
 */
export function getCloseMarkup() {
  try {
    const { Markup } = require('telegraf');
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('📊 Dashboard', 'DASHBOARD'),
        Markup.button.callback('🎯 New Signal', 'GET_SIGNAL')
      ]
    ]);
  } catch {
    return undefined;
  }
}
