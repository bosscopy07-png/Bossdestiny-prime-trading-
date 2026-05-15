// ==========================================
// STRUCTURED LOGGER WITH FULL ERROR SERIALIZATION
// ==========================================

import Pino from 'pino';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { CONFIG } from '../config/index.js';

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
        errorProps: 'stack,errno,code', // Show stack in pretty mode
      },
    }
  : undefined;

export const logger = Pino({
  level: CONFIG.LOG_LEVEL,
  transport,
  base: { pid: process.pid, env: process.env.NODE_ENV || 'production' },
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
  // CRITICAL: Custom error serializer to capture stack traces
  serializers: {
    err: Pino.stdSerializers.err,
    error: Pino.stdSerializers.err,
  },
});

// Child loggers
export const marketLogger = logger.child({ domain: 'market' });
export const analysisLogger = logger.child({ domain: 'analysis' });
export const signalLogger = logger.child({ domain: 'signal' });
export const botLogger = logger.child({ domain: 'bot' });
export const riskLogger = logger.child({ domain: 'risk' });
