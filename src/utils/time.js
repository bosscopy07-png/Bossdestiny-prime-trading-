// ==========================================
// TIME UTILITIES
// ==========================================

/**
 * Sleep for N milliseconds
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format duration from milliseconds
 */
export function formatDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

/**
 * Get today's date string YYYY-MM-DD
 */
export function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Check if timestamp is from today
 */
export function isToday(timestamp) {
  if (!timestamp) return false;
  const d = new Date(timestamp);
  const now = new Date();
  return d.getDate() === now.getDate() &&
         d.getMonth() === now.getMonth() &&
         d.getFullYear() === now.getFullYear();
}

/**
 * Parse timeframe string to milliseconds
 */
export function timeframeToMs(tf) {
  const map = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
  return map[tf] || 900000;
}
