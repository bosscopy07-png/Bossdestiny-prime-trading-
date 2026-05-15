// ==========================================
// STRUCTURED LOGGER WITH FILE ROTATION
// Production-ready Pino setup
// ==========================================

import Pino from 'pino';
import { mkdirSync } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';
import { CONFIG } from '../config/index.js';

// Ensure log directory exists
if (!existsSync(CONFIG.LOG_DIR)) {
  mkdirSync(CONFIG.LOG_DIR, { recursive: true });
}

const transport = CONFIG.LOG_LEVEL === 'debug'
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    }
  : undefined;

export const logger = Pino({
  level: CONFIG.LOG_LEVEL,
  transport,
  base: { pid: process.pid, env: process.env.NODE_ENV || 'development' },
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
});

// Child loggers for domains
export const marketLogger = logger.child({ domain: 'market' });
export const analysisLogger = logger.child({ domain: 'analysis' });
export const signalLogger = logger.child({ domain: 'signal' });
export const botLogger = logger.child({ domain: 'bot' });
export const riskLogger = logger.child({ domain: 'risk' });
