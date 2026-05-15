// ==========================================
// MAIN ENTRY POINT
// SignalAlpha v3.0 — Institutional Crypto Signal Bot
// ==========================================

import { SignalAlphaBot } from './bot/index.js';
import { logConfigAudit } from './config/index.js';
import { logger } from './utils/logger.js';

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     🚀 SIGNALALPHA TRADING BOT v3.0 — INSTITUTIONAL         ║');
  console.log('║                                                            ║');
  console.log('║  Multi-layer analysis | BTC filter | Adaptive leverage     ║');
  console.log('║  Cooldown system | Confluence scoring | Quality signals    ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  try {
    logConfigAudit(logger);
    
    const bot = new SignalAlphaBot();
    await bot.start();
  } catch (err) {
    logger.fatal({ err: err.message }, 'Fatal error');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err.message);
  process.exit(1);
});
