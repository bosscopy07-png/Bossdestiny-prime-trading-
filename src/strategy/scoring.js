// ==========================================
// CONFIDENCE SCORING ENGINE
// Multi-factor weighted scoring 0-100
// RELAXED: Balanced thresholds, contextual penalties
// ==========================================

import { CONFIG } from '../config/index.js';
import { clamp } from '../utils/math.js';
import { signalLogger } from '../utils/logger.js';

export class ConfidenceEngine {
  constructor() {
    this.weights = {
      trend: 20,        // Reduced: trend is important but not everything
      volume: 15,       // Reduced: volume confirms, doesn't dictate
      structure: 20,    // Unchanged: structure is key
      momentum: 20,     // Increased: momentum drives price
      volatility: 10,   // Unchanged
      btcAlignment: 15, // Increased: but penalties reduced
    };
    signalLogger.info('ConfidenceEngine initialized (relaxed mode)');
  }

  calculate(analysis) {
    let score = 0;
    const details = [];
    const bonuses = [];
    const penalties = [];

    const { trend, multiTimeframe, momentum, volume, structure, levels, atr, btcTrend, setup } = analysis;

    // ─── 1. TREND ANALYSIS (0-20) ─────────────────────────────
    if (multiTimeframe?.alignment && trend?.strength > 50) {
      score += 18;
      details.push('Strong multi-TF trend (+18)');
    } else if (multiTimeframe?.alignment && trend?.strength > 30) {
      score += 14;
      details.push('Moderate trend alignment (+14)');
    } else if (trend?.primary !== 'neutral' && trend?.strength > 20) {
      score += 10;
      details.push('Single TF trend present (+10)');
    } else if (trend?.primary !== 'neutral') {
      score += 6;
      details.push('Weak trend (+6)');
    } else {
      score += 3;
      details.push('No trend — counter-trend play (+3)');
    }

    if (Math.abs(trend?.slope || 0) > 0.05) {
      score += 2;
      bonuses.push('EMA slope (+2)');
    }

    // ─── 2. MOMENTUM CONFLUENCE (0-20) ─────────────────────────
    const rsi = momentum?.rsi?.value || 50;
    const macd = momentum?.macd;
    
    let rsiScore = 0;
    // RELAXED: Broader zones, rewards momentum extremes
    if (rsi >= 35 && rsi <= 65) {
      rsiScore = 8;
      details.push(`RSI balanced ${rsi.toFixed(1)} (+8)`);
    } else if (rsi >= 25 && rsi <= 75) {
      rsiScore = 12;  // Higher score for momentum zones
      details.push(`RSI momentum zone ${rsi.toFixed(1)} (+12)`);
    } else if (rsi >= 20 && rsi <= 80) {
      rsiScore = 6;
      details.push(`RSI extreme ${rsi.toFixed(1)} (+6)`);
    } else {
      rsiScore = 3;
      penalties.push(`RSI very extreme ${rsi.toFixed(1)} (+3)`);
    }

    let macdScore = 0;
    if (macd?.crossover !== 'none') {
      macdScore = 10;
      details.push(`MACD ${macd.crossover} crossover (+10)`);
    } else if (macd?.trend?.includes('bullish') || macd?.trend?.includes('bearish')) {
      macdScore = 7;
      details.push(`MACD ${macd.trend} (+7)`);
    } else if (macd?.momentum > 0.0003) {
      macdScore = 4;
      details.push('Weak MACD (+4)');
    } else {
      macdScore = 2;
    }

    if (momentum?.rsi?.divergence?.bullish || momentum?.rsi?.divergence?.bearish) {
      score += 3;
      bonuses.push('RSI divergence (+3)');
    }

    score += rsiScore + macdScore;

    // ─── 3. VOLUME CONFIRMATION (0-15) ─────────────────────────
    const volRatio = volume?.ratio || 1;
    
    if (volRatio >= 1.5) {
      score += 13;
      details.push(`Good volume ${volRatio.toFixed(1)}x (+13)`);
    } else if (volRatio >= 1.2) {
      score += 10;
      details.push(`Adequate volume ${volRatio.toFixed(1)}x (+10)`);
    } else if (volRatio >= 0.8) {
      score += 6;
      details.push(`Normal volume ${volRatio.toFixed(1)}x (+6)`);
    } else {
      score += 3;
      penalties.push(`Low volume ${volRatio.toFixed(1)}x (+3)`);
    }

    if (volume?.confirmation || volume?.trend === 'increasing') {
      score += 2;
      bonuses.push('Volume rising (+2)');
    }

    // ─── 4. STRUCTURE CLARITY (0-20) ──────────────────────────
    if (structure?.bos !== 'none' && structure?.strength > 40) {
      score += 16;
      details.push(`Structure break (+16)`);
    } else if (structure?.bos !== 'none') {
      score += 12;
      details.push(`Weak structure break (+12)`);
    } else if (structure?.trending && structure?.strength > 30) {
      score += 9;
      details.push('Trending structure (+9)');
    } else if (structure?.consolidation) {
      score += 6;
      details.push('Consolidation (+6)');
    } else {
      score += 3;
      details.push('Unclear structure (+3)');
    }

    if (levels?.valid && (levels.supportTouches >= 1 || levels.resistanceTouches >= 1)) {
      score += 4;
      bonuses.push('Tested S/R (+4)');
    }

    // ─── 5. VOLATILITY QUALITY (0-10) ─────────────────────────
    if (atr?.percent >= 0.8 && atr?.percent <= 4) {
      score += 9;
      details.push(`Healthy vol ${atr.percent}% (+9)`);
    } else if (atr?.percent >= 0.4 && atr?.percent <= 6) {
      score += 6;
      details.push(`Acceptable vol ${atr.percent}% (+6)`);
    } else if (atr?.percent > 6) {
      score += 3;
      penalties.push(`High vol ${atr.percent}% (+3)`);
    } else {
      score += 4;
      details.push(`Low vol ${atr.percent}% (+4)`);
    }

    // ─── 6. BTC ALIGNMENT (0-15) ──────────────────────────────
    if (btcTrend) {
      if (btcTrend.volatile) {
        score += 5;
        penalties.push('BTC volatile (+5)');
      } else if (btcTrend.primary === trend?.primary && btcTrend.strength > 40) {
        score += 13;
        details.push('BTC aligned (+13)');
      } else if (btcTrend.primary === 'neutral') {
        score += 8;
        details.push('BTC neutral (+8)');
      } else if (btcTrend.primary !== trend?.primary) {
        score += 5;
        penalties.push('BTC opposing (+5)');
      }
    }

    // ─── CONTEXTUAL BONUSES ───────────────────────────────────
    // Excellent R:R gets a bonus regardless of other factors
    const rr = setup?.rr || 0;
    if (rr >= 3) {
      score += 5;
      bonuses.push('Excellent R:R (+5)');
    } else if (rr >= 2) {
      score += 3;
      bonuses.push('Good R:R (+3)');
    }

    // ─── PENALTIES ────────────────────────────────────────────
    if (atr?.percent > 6) {
      score -= 3;
      penalties.push('High vol penalty (-3)');
    }
    if (volume?.ratio < 0.5) {
      score -= 3;
      penalties.push('Very low volume (-3)');
    }
    if (multiTimeframe?.higherTF?.primary !== 'neutral' && 
        multiTimeframe?.higherTF?.primary !== trend?.primary &&
        multiTimeframe?.higherTF?.strength > 50) {
      score -= 3;
      penalties.push('Against strong HTF (-3)');
    }

    // ─── FINAL SCORE ──────────────────────────────────────────
    let finalScore = clamp(score, 0, 100);
    // RELAXED: No rounding to nearest 5 — keep precise score
    finalScore = Math.round(finalScore);

    // RELAXED: Tier thresholds lowered
    let tier, passed, confidence, recommendation;

    if (finalScore >= 75) {
      tier = 'A+';
      passed = true;
      confidence = 'high';
      recommendation = 'Strong signal — Full size';
    } else if (finalScore >= 65) {
      tier = 'A';
      passed = true;
      confidence = 'high';
      recommendation = 'Good signal — Full size';
    } else if (finalScore >= 55) {
      tier = 'B+';
      passed = true;
      confidence = 'medium';
      recommendation = 'Moderate signal — Standard size';
    } else if (finalScore >= 45) {
      tier = 'B';
      passed = true;
      confidence = 'medium';
      recommendation = 'Marginal signal — Reduce size 25%';
    } else if (finalScore >= 35) {
      tier = 'C+';
      passed = true;                    // RELAXED: C+ now passes
      confidence = 'low';
      recommendation = 'Weak signal — Reduce size 50%';
    } else if (finalScore >= 25) {
      tier = 'C';
      passed = false;
      confidence = 'low';
      recommendation = 'Avoid — Paper trade only';
    } else {
      tier = 'D';
      passed = false;
      confidence = 'low';
      recommendation = 'No trade';
    }

    // RELAXED: R:R minimum only blocks if below 1.5 (not hard override)
    if (rr < 1.5) {
      passed = false;
      recommendation = `R:R ${rr.toFixed(2)} too low — Minimum 1.5:1`;
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
      breakdown: { total: finalScore },
    };
  }
          }
