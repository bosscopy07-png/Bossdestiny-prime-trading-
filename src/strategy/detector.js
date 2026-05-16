// ==========================================
// STRATEGY DETECTOR
// Orchestrates all setup detectors by priority
// RELAXED: Allows marginal setups with context
// ==========================================

import { detectLiquiditySweep } from './setups/liquiditySweep.js';
import { detectTrendContinuation } from './setups/trendContinuation.js';
import { detectBreakout } from './setups/breakout.js';
import { detectPullback } from './setups/pullback.js';
import { detectRangePlay } from './setups/rangePlay.js';
import { signalLogger } from '../utils/logger.js';

const QUALITY_RANK = { 'A+': 5, 'A': 4, 'B+': 3, 'B': 2, 'C+': 1, 'C': 0 };

export class StrategyDetector {
  constructor() {
    this.minQuality = 'C';        // RELAXED: Was 'B', now accepts C+
    this.detectors = [
      detectLiquiditySweep,       // Highest priority: clean entries
      detectTrendContinuation,    // Trend following
      detectBreakout,             // Momentum
      detectPullback,             // S/R bounce
      detectRangePlay,            // Lowest priority: mean reversion
    ];
    signalLogger.info('StrategyDetector initialized (relaxed mode)');
  }

  /**
   * Run all detectors and return best valid setup
   * RELAXED: Collects all valid setups, returns best by quality + R:R
   */
  detect(analysis) {
    const { price, levels } = analysis;
    
    if (!price || !levels?.support || !levels?.resistance) {
      return null;
    }

    const validSetups = [];

    for (const detector of this.detectors) {
      try {
        const setup = detector(analysis);
        if (setup && this.qualityRank(setup.quality) >= this.qualityRank(this.minQuality)) {
          validSetups.push(setup);
        }
      } catch (err) {
        signalLogger.warn(`Detector error: ${err.message}`);
      }
    }

    if (validSetups.length === 0) return null;

    // Return best setup: quality first, then R:R as tiebreaker
    validSetups.sort((a, b) => {
      const qualityDiff = this.qualityRank(b.quality) - this.qualityRank(a.quality);
      if (qualityDiff !== 0) return qualityDiff;
      return b.rr - a.rr;
    });

    // If best is C+ but R:R is excellent (>3), bump quality note
    const best = validSetups[0];
    if (best.quality === 'C+' && best.rr >= 3) {
      best.quality = 'B';
      best.note = (best.note || '') + ' [upgraded: excellent R:R]';
    }

    return best;
  }

  qualityRank(q) {
    return QUALITY_RANK[q] || 0;
  }
}
