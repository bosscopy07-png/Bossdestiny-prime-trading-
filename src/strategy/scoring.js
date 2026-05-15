// ==========================================
// CONFIDENCE SCORING ENGINE
// Multi-factor weighted scoring 0-100
// ==========================================

import { CONFIG } from '../config/index.js';
import { clamp } from '../utils/math.js';
import { signalLogger } from '../utils/logger.js';

export class ConfidenceEngine {
  constructor() {
    // Weights: must sum to 100
    this.weights = {
      trend: 25,        // Trend quality and alignment
      volume: 20,       // Volume confirmation
      structure: 20,    // Market structure clarity
      momentum: 15,     // RSI + MACD confluence
      volatility: 10,   // ATR / volatility quality
      btcAlignment: 10,  // BTC market direction filter
    };
    signalLogger.info('ConfidenceEngine initialized');
  }

  /**
   * Calculate confidence score from full analysis
   */
  calculate(analysis) {
    let score = 0;
    const details = [];
    const bonuses = [];
    const penalties = [];

    // ─── 1. TREND ANALYSIS (0-25) ─────────────────────────────
    const { trend, multiTimeframe } = analysis;
    
    if (multiTimeframe?.alignment && trend?.strength > 60) {
      score += 22;
      details.push('Strong multi-TF trend alignment (+22)');
    } else if (multiTimeframe?.alignment && trend?.strength > 40) {
      score += 17;
      details.push('Moderate trend alignment (+17)');
    } else if (trend?.primary !== 'neutral' && trend?.strength > 30) {
      score += 12;
      details.push('Single TF trend present (+12)');
    } else if (trend?.primary !== 'neutral') {
      score += 7;
      details.push('Weak trend (+7)');
    } else {
      score += 3;
      details.push('No clear trend (+3)');
    }

    if (Math.abs(trend?.slope || 0) > 0.1) {
      score += 3;
      bonuses.push('Strong EMA slope (+3)');
    }

    // ─── 2. MOMENTUM CONFLUENCE (0-15) ─────────────────────────
    const { momentum } = analysis;
    const rsi = momentum?.rsi?.value || 50;
    const macd = momentum?.macd;
    
    let rsiScore = 0;
    if (rsi >= 40 && rsi <= 60) {
      rsiScore = 6;
      details.push(`RSI active zone ${rsi.toFixed(1)} (+6)`);
    } else if (rsi >= 35 && rsi <= 65) {
      rsiScore = 4;
      details.push(`RSI moderate ${rsi.toFixed(1)} (+4)`);
    } else if (rsi >= 30 && rsi <= 70) {
      rsiScore = 2;
      details.push(`RSI near extreme ${rsi.toFixed(1)} (+2)`);
    } else {
      rsiScore = 0;
      penalties.push(`RSI extreme ${rsi.toFixed(1)} (0)`);
    }

    let macdScore = 0;
    if (macd?.crossover !== 'none' && macd?.momentum > 0.001) {
      macdScore = 9;
      details.push(`MACD ${macd.crossover} crossover (+9)`);
    } else if (macd?.trend?.includes('bullish') || macd?.trend?.includes('bearish')) {
      macdScore = 6;
      details.push(`MACD ${macd.trend} (+6)`);
    } else if (macd?.momentum > 0.0005) {
      macdScore = 3;
      details.push('Weak MACD momentum (+3)');
    } else {
      macdScore = 0;
    }

    if (momentum?.rsi?.divergence?.bullish || momentum?.rsi?.divergence?.bearish) {
      score += 2;
      bonuses.push('RSI divergence (+2)');
    }

    score += rsiScore + macdScore;

    // ─── 3. VOLUME CONFIRMATION (0-20) ─────────────────────────
    const { volume } = analysis;
    const volRatio = volume?.ratio || 1;
    
    if (volRatio >= 2.0) {
      score += 18;
      details.push(`Strong volume ${volRatio.toFixed(1)}x (+18)`);
    } else if (volRatio >= 1.5) {
      score += 14;
      details.push(`Good volume ${volRatio.toFixed(1)}x (+14)`);
    } else if (volRatio >= 1.3) {
      score += 10;
      details.push(`Adequate volume ${volRatio.toFixed(1)}x (+10)`);
    } else if (volRatio >= 1.0) {
      score += 5;
      details.push(`Average volume ${volRatio.toFixed(1)}x (+5)`);
    } else {
      score += 1;
      penalties.push(`Low volume ${volRatio.toFixed(1)}x (+1)`);
    }

    if (volume?.confirmation) {
      score += 2;
      bonuses.push('Volume-price confirmation (+2)');
    }

    // ─── 4. STRUCTURE CLARITY (0-20) ──────────────────────────
    const { structure, levels } = analysis;
    
    if (structure?.bos !== 'none' && structure?.strength > 50) {
      score += 16;
      details.push(`Clean structure break (+16)`);
    } else if (structure?.bos !== 'none') {
      score += 11;
      details.push(`Weak structure break (+11)`);
    } else if (structure?.trending && structure?.strength > 40) {
      score += 8;
      details.push('Trending, no recent BOS (+8)');
    } else if (structure?.consolidation) {
      score += 4;
      details.push('Consolidating (+4)');
    } else {
      score += 2;
      details.push('Unclear structure (+2)');
    }

    if (levels?.valid && (levels.supportTouches >= 2 || levels.resistanceTouches >= 2)) {
      score += 4;
      bonuses.push('Tested S/R levels (+4)');
    }

    // ─── 5. VOLATILITY QUALITY (0-10) ─────────────────────────
    const { atr } = analysis;
    
    if (atr?.percent >= 1 && atr?.percent <= 3) {
      score += 9;
      details.push(`Healthy volatility ${atr.percent}% (+9)`);
    } else if (atr?.percent >= 0.5 && atr?.percent <= 5) {
      score += 6;
      details.push(`Acceptable volatility ${atr.percent}% (+6)`);
    } else if (atr?.percent > 5) {
      score += 2;
      penalties.push(`High volatility ${atr.percent}% (+2)`);
    } else {
      score += 3;
      details.push(`Low volatility ${atr.percent}% (+3)`);
    }

    // ─── 6. BTC ALIGNMENT (0-10) ──────────────────────────────
    const { btcTrend } = analysis;
    
    if (btcTrend) {
      if (btcTrend.volatile) {
        score += 2;
        penalties.push('BTC volatile — reduced confidence (+2)');
      } else if (btcTrend.primary === trend?.primary && btcTrend.strength > 50) {
        score += 9;
        details.push('BTC aligned (+9)');
      } else if (btcTrend.primary === 'neutral') {
        score += 5;
        details.push('BTC neutral (+5)');
      } else if (btcTrend.primary !== trend?.primary) {
        score += 2;
        penalties.push('BTC opposing trend (+2)');
      }
    }

    // ─── PENALTIES ────────────────────────────────────────────
    if (analysis.atr?.percent > 5) {
      score -= 5;
      penalties.push('High volatility penalty (-5)');
    }
    if (volume?.ratio < 0.7) {
      score -= 3;
      penalties.push('Very low volume (-3)');
    }
    if (multiTimeframe?.higherTF?.primary !== 'neutral' && 
        multiTimeframe?.higherTF?.primary !== trend?.primary) {
      score -= 4;
      penalties.push('Against higher TF trend (-4)');
    }

    // ─── FINAL SCORE ──────────────────────────────────────────
    let finalScore = clamp(score, 0, 100);
    finalScore = Math.round(finalScore / 5) * 5; // Round to nearest 5

    // Determine tier
    let tier, passed, confidence, recommendation;

    if (finalScore >= 80) {
      tier = 'A+';
      passed = true;
      confidence = 'high';
      recommendation = 'Strong signal — Execute with standard size';
    } else if (finalScore >= 70) {
      tier = 'A';
      passed = true;
      confidence = 'high';
      recommendation = 'Good signal — Execute with standard size';
    } else if (finalScore >= 60) {
      tier = 'B+';
      passed = true;
      confidence = 'medium';
      recommendation = 'Moderate signal — Reduce position size 25%';
    } else if (finalScore >= 50) {
      tier = 'B';
      passed = true;
      confidence = 'medium';
      recommendation = 'Marginal signal — Reduce size 50%, tight stops';
    } else if (finalScore >= 40) {
      tier = 'C';
      passed = false;
      confidence = 'low';
      recommendation = 'Weak signal — Avoid or paper trade';
    } else {
      tier = 'D';
      passed = false;
      confidence = 'low';
      recommendation = 'No trade — Insufficient confluence';
    }

    // Hard override: R:R minimum
    const rr = analysis.setup?.rr || 0;
    if (rr < CONFIG.RISK.MIN_RR) {
      passed = false;
      recommendation = `R:R below minimum ${CONFIG.RISK.MIN_RR}:1 — No trade`;
    }

    return {
      score: finalScore,
      tier,
      passed,
      confidence,
      recommendation,
      details,
      bonuses,
      penalties,
      breakdown: {
        trend: score, // Running total for reference
        total: finalScore,
      },
    };
  }
}
