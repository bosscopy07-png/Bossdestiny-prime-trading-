// ==========================================
// STRATEGY DETECTOR
// Orchestrates all setup detectors by priority
// ==========================================

import { detectLiquiditySweep } from './setups/liquiditySweep.js';
import { detectTrendContinuation } from './setups/trendContinuation.js';
import { detectBreakout } from './setups/breakout.js';
import { detectPullback } from './setups/pullback.js';
import { detectRangePlay } from './setups/rangePlay.js';
import { signalLogger } from '../utils/logger.js';

const QUALITY_RANK = { 'A+': 5, 'A': 4, 'B+': 3, 'B': 2, 'C': 1, 'D': 0 };

export class StrategyDetector {
  constructor() {
    this.minQuality = 'B';
    this.detectors = [
      detectLiquiditySweep,
      detectTrendContinuation,
      detectBreakout,
      detectPullback,
      detectRangePlay,
    ];
    signalLogger.info('StrategyDetector initialized');
  }

  /**
   * Run all detectors and return best valid setup
   */
  detect(analysis) {
    const { price, levels } = analysis;
    
    if (!price || !levels?.support || !levels?.resistance) {
      return null;
    }

    for (const detector of this.detectors) {
      try {
        const setup = detector(analysis);
        if (setup && this.qualityRank(setup.quality) >= this.qualityRank(this.minQuality)) {
          return setup;
        }
      } catch (err) {
        signalLogger.warn(`Detector error: ${err.message}`);
      }
    }

    return null;
  }

  qualityRank(q) {
    return QUALITY_RANK[q] || 0;
  }
}
