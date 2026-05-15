// ==========================================
// SYMBOL NORMALIZATION & VALIDATION
// Centralizes all symbol format handling
// ==========================================

import { marketLogger } from '../utils/logger.js';

/**
 * Normalize any symbol string to CCXT unified format
 * @param {string} symbol - Raw symbol input
 * @param {object} exchange - CCXT exchange instance with loaded markets
 * @returns {string|null} Normalized CCXT symbol or null
 */
export function normalizeSymbol(symbol, exchange) {
  if (!symbol || !exchange?.markets) return null;

  // Already valid
  if (isValidSymbol(symbol, exchange)) return symbol;

  // Generate variations to try
  const variations = generateSymbolVariations(symbol);
  
  for (const variant of variations) {
    if (isValidSymbol(variant, exchange)) {
      marketLogger.debug(`Normalized ${symbol} → ${variant}`);
      return variant;
    }
  }

  // Try base currency match
  const base = extractBase(symbol);
  if (base) {
    const found = Object.keys(exchange.markets).find(m => {
      const market = exchange.markets[m];
      return market.base === base && 
             market.quote === 'USDT' && 
             market.active !== false &&
             (market.type === 'swap' || market.type === 'future');
    });
    if (found) {
      marketLogger.debug(`Base match: ${symbol} → ${found}`);
      return found;
    }
  }

  marketLogger.warn(`Cannot normalize symbol: ${symbol}`);
  return null;
}

/**
 * Check if symbol exists and is active on exchange
 */
export function isValidSymbol(symbol, exchange) {
  if (!symbol || !exchange?.markets) return false;
  const market = exchange.markets[symbol];
  return !!market && market.active !== false;
}

/**
 * Extract base currency from any symbol format
 */
function extractBase(symbol) {
  return symbol
    .replace(/:USDT/g, '')
    .replace(/\/USDT/g, '')
    .replace(/USDT$/, '')
    .toUpperCase();
}

/**
 * Generate all possible symbol format variations
 */
function generateSymbolVariations(symbol) {
  const clean = symbol.trim().toUpperCase();
  return [
    clean,                                    // BTC/USDT:USDT
    clean.replace(':USDT', ''),              // BTC/USDT
    clean.replace('/USDT:USDT', '/USDT'),    // BTC/USDT
    clean.replace('/USDT', '/USDT:USDT'),    // BTC/USDT:USDT
    clean.replace('USDT', '/USDT'),          // BTC/USDT
    clean + '/USDT',                         // BTC/USDT
    clean + ':USDT',                         // BTC:USDT
    clean + '/USDT:USDT',                    // BTC/USDT:USDT
  ];
}

/**
 * Convert CCXT symbol to Binance WebSocket format (lowercase, no slash)
 */
export function toWsFormat(symbol) {
  if (!symbol) return '';
  return symbol
    .replace('/', '')
    .replace(':USDT', '')
    .toLowerCase();
}

/**
 * Convert CCXT symbol to display format
 */
export function toDisplayFormat(symbol) {
  if (!symbol) return '';
  return symbol.replace(':USDT', '');
}

/**
 * Filter perpetual swap markets
 */
export function filterPerpetualMarkets(exchange) {
  if (!exchange?.markets) return [];
  
  const markets = Object.values(exchange.markets)
    .filter(m => {
      const isActive = m.active !== false;
      const isUSDT = m.quote === 'USDT' || m.settle === 'USDT';
      const isPerp = m.type === 'swap' || (m.type === 'future' && !m.expiry);
      const isLinear = m.linear !== false;
      return isActive && isUSDT && isPerp && isLinear;
    })
    .map(m => m.symbol)
    .sort();

  marketLogger.info(`Found ${markets.length} perpetual USDT markets`);
  return markets;
}
