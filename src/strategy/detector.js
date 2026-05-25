import { detectLiquiditySweep } from './setups/liquiditySweep.js';
import { detectBreakout } from './setups/breakout.js';
import { detectPullback } from './setups/pullback.js';
import { detectTrendContinuation } from './setups/trendContinuation.js';
import { detectRangePlay } from './setups/rangePlay.js';
import { signalLogger } from '../utils/logger.js';

const QUALITY_RANK = { 'A+': 5, 'A': 4, 'A-': 3.5, 'B+': 3, 'B': 2, 'C+': 1 };

const DETECTORS = [
  detectLiquiditySweep,
  detectTrendContinuation,
  detectBreakout,
  detectPullback,
  detectRangePlay,
];

// C+ allowed only if R:R exceeds this threshold (excellent reward compensates)
const CPLUS_MIN_RR = 2.5;

/**
 * StrategyDetector — Routes analysis to all setup detectors
 * Returns the highest-quality setup found, or null
 * Minimum quality: B (C+ allowed only if R:R >= 2.5)
 */
export class StrategyDetector {
  constructor() {
    this.minQuality = 'B';
    signalLogger.info('StrategyDetector initialized (min quality: B, C+ gated at R:R 2.5+)');
  }

  detect(analysis) {
    const { price, levels } = analysis;
    
    if (!price || !levels?.support || !levels?.resistance) {
      return null;
    }

    const validSetups = [];

    for (const detector of DETECTORS) {
      try {
        const setup = detector(analysis);
        if (setup && this._isValidQuality(setup)) {
          validSetups.push(setup);
        }
      } catch (err) {
        signalLogger.warn(`Detector error: ${err.message}`);
      }
    }

    if (validSetups.length === 0) return null;

    // Sort by quality tier, then by R:R
    validSetups.sort((a, b) => {
      const qualityDiff = this._qualityRank(b.quality) - this._qualityRank(a.quality);
      if (qualityDiff !== 0) return qualityDiff;
      return b.rr - a.rr;
    });

    return validSetups[0];
  }

  /**
   * Quality gate: B+ passes freely, C+ only if R:R >= 2.5
   */
  _isValidQuality(setup) {
    const rank = this._qualityRank(setup.quality);
    const minRank = this._qualityRank(this.minQuality);

    // B or above: always pass
    if (rank >= minRank) return true;

    // C+: pass only with excellent R:R (reward compensates for lower quality)
    if (setup.quality === 'C+' && setup.rr >= CPLUS_MIN_RR) {
      return true;
    }

    // Everything else (C, D): reject
    return false;
  }

  _qualityRank(q) {
    return QUALITY_RANK[q] || 0;
  }
      }
