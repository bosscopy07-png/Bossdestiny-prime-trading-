// ==========================================
// CENTRALIZED CONFIGURATION
// Zero assumptions — everything from env or explicit defaults
// ==========================================

import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── VALIDATION HELPERS ─────────────────────────────────────────

function requireEnv(key, defaultValue = undefined) {
  const value = process.env[key];
  if (value === undefined && defaultValue === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value !== undefined ? value : defaultValue;
}

function parseList(key, defaultValue = '') {
  return (process.env[key] || defaultValue)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function parseFloatEnv(key, defaultValue) {
  const val = parseFloat(process.env[key] || defaultValue);
  if (Number.isNaN(val)) throw new Error(`Invalid float for ${key}`);
  return val;
}

function parseIntEnv(key, defaultValue) {
  const val = parseInt(process.env[key] || defaultValue, 10);
  if (Number.isNaN(val)) throw new Error(`Invalid int for ${key}`);
  return val;
}

function parseBoolEnv(key, defaultValue = false) {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  return val === 'true' || val === '1';
}

// ─── CONFIG OBJECT ──────────────────────────────────────────────

export const CONFIG = Object.freeze({
  // Bot
  BOT_TOKEN: requireEnv('BOT_TOKEN'),
  ADMIN_IDS: parseList('ADMIN_IDS'),

  // Exchange
  EXCHANGE: Object.freeze({
    ID: requireEnv('EXCHANGE_ID', 'bitget'),
    API_KEY: process.env.EXCHANGE_API_KEY || undefined,
    SECRET: process.env.EXCHANGE_SECRET || undefined,
    PASSPHRASE: process.env.EXCHANGE_PASSPHRASE || undefined,
    SANDBOX: parseBoolEnv('SANDBOX', false),
    DEFAULT_TYPE: 'swap',
  }),

  // Challenge
  CHALLENGE: Object.freeze({
    START_CAPITAL: parseFloatEnv('CHALLENGE_START_CAPITAL', 10),
    TARGET: parseFloatEnv('CHALLENGE_TARGET', 100),
    DAYS: parseIntEnv('CHALLENGE_DAYS', 30),
    get CURRENT_CAPITAL() {
      // Mutable — tracked at runtime
      return CONFIG._runtime.currentCapital;
    },
    set CURRENT_CAPITAL(val) {
      CONFIG._runtime.currentCapital = val;
    },
  }),

  // Risk
  RISK: Object.freeze({
    MAX_ACTIVE_TRADES: parseIntEnv('MAX_ACTIVE_TRADES', 3),
    MAX_SIGNALS_PER_DAY: parseIntEnv('MAX_SIGNALS_PER_DAY', 8),
    MIN_CONFIDENCE: parseIntEnv('MIN_CONFIDENCE', 60),
    MIN_RR: parseFloatEnv('MIN_RR', 1.5),
    MAX_RISK_PER_TRADE_PCT: parseFloatEnv('MAX_RISK_PER_TRADE_PCT', 2),
    DAILY_LOSS_LIMIT_PCT: parseFloatEnv('DAILY_LOSS_LIMIT_PCT', 5),
    WEEKLY_LOSS_LIMIT_PCT: parseFloatEnv('WEEKLY_LOSS_LIMIT_PCT', 15),
    MAX_CONSECUTIVE_LOSSES: parseIntEnv('MAX_CONSECUTIVE_LOSSES', 3),
    COOLDOWN_MINUTES: parseIntEnv('COOLDOWN_MINUTES_AFTER_LOSS_STREAK', 30),
  }),

  // Technical Analysis
  TA: Object.freeze({
    TIMEFRAMES: Object.freeze(['1m', '5m', '15m', '1h', '4h']),
    EMA_FAST: 20,
    EMA_MID: 50,
    EMA_SLOW: 200,
    RSI_PERIOD: 14,
    RSI_OVERBOUGHT: 72,
    RSI_OVERSOLD: 28,
    VOLUME_THRESHOLD: 1.3,
    MIN_VOLUME_USD: parseFloatEnv('MIN_VOLUME_USD', 5000000),
    ATR_PERIOD: 14,
    SWING_LOOKBACK: 50,
    MIN_SWING_STRENGTH: 2,
  }),

  // Scanning
  SCAN: Object.freeze({
    INTERVAL_MINUTES: parseIntEnv('SCAN_INTERVAL_MINUTES', 240),
    TOP_VOLUME_COUNT: parseIntEnv('TOP_VOLUME_COUNT', 20),
    SYMBOLS_PER_SCAN: 15,
    OHLCV_LIMIT: 100,
    PRICE_CACHE_TTL_MS: 10000,
    OHLCV_CACHE_TTL_MS: 45000,
    WS_RECONNECT_DELAY_MS: 10000,
    POLL_DELAY_MS: 30000,
    RATE_LIMIT_MS: 250,
  }),

  // Market Data
  DATA: Object.freeze({
    BINANCE_FUTURES_WS: 'wss://fstream.binance.com/ws',
    COINGECKO_API: 'https://api.coingecko.com/api/v3',
  }),

  // Referral
  REFERRAL: Object.freeze({
    LINK: requireEnv('REFERRAL_LINK', 'https://bingx.com/invite/4UAWNP'),
    CODE: requireEnv('REFERRAL_CODE', '4UAWNP'),
  }),

  // Logging
  LOG_LEVEL: requireEnv('LOG_LEVEL', 'info'),
  LOG_DIR: join(__dirname, '../../data/logs'),

  // Runtime mutable state (not frozen)
  _runtime: {
    currentCapital: parseFloatEnv('CURRENT_CAPITAL', 10),
    consecutiveLosses: 0,
    dailyLossAccumulator: 0,
    lastLossTime: null,
    inCooldown: false,
    signalsToday: 0,
    lastSignalDate: null,
  },
});

// ─── DERIVED CONSTANTS ──────────────────────────────────────────

export const SIGNAL_QUALITY = Object.freeze({
  A_PLUS: 'A+',
  A: 'A',
  B_PLUS: 'B+',
  B: 'B',
  C: 'C',
  D: 'D',
});

export const DIRECTION = Object.freeze({
  LONG: 'LONG',
  SHORT: 'SHORT',
});

export const TREND = Object.freeze({
  BULLISH: 'bullish',
  BEARISH: 'bearish',
  NEUTRAL: 'neutral',
});

// ─── CONFIG AUDIT LOG ───────────────────────────────────────────

export function logConfigAudit(logger) {
  logger.info('CONFIG loaded successfully');
  logger.info(`Challenge: $${CONFIG.CHALLENGE.START_CAPITAL} → $${CONFIG.CHALLENGE.TARGET}`);
  logger.info(`Min Confidence: ${CONFIG.RISK.MIN_CONFIDENCE}% | Min R:R: ${CONFIG.RISK.MIN_RR}:1`);
  logger.info(`Admin IDs: ${CONFIG.ADMIN_IDS.length > 0 ? CONFIG.ADMIN_IDS.join(', ') : 'None set'}`);
  logger.info(`Exchange: ${CONFIG.EXCHANGE.ID} | Sandbox: ${CONFIG.EXCHANGE.SANDBOX}`);
  logger.info(`Max Active Trades: ${CONFIG.RISK.MAX_ACTIVE_TRADES}`);
  logger.info(`Cooldown after ${CONFIG.RISK.MAX_CONSECUTIVE_LOSSES} losses: ${CONFIG.RISK.COOLDOWN_MINUTES}min`);
}
