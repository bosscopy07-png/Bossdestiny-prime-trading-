import { CONFIG } from '../config/index.js';
import { clamp } from '../utils/math.js';
import { signalLogger } from '../utils/logger.js';

/**
 * ConfidenceEngine — Multi-factor weighted scoring 0-100
 * Evaluates signal quality across trend, momentum, volume, structure, volatility, BTC alignment
 */
export class ConfidenceEngine {
  constructor() {
    this.weights = {
      trend: 20,
      volume: 15,
      structure: 20,
      momentum: 20,
      volatility: 10,
      btcAlignment: 15,
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
    const { trend: trendScore, trendDetails, trendPenalties } = this._scoreTrend(trend, multiTimeframe, volume);
    score += trendScore;
    details.push(...trendDetails);
    penalties.push(...trendPenalties);

    if (Math.abs(trend?.slope || 0) > 0.05) {
      score += 2;
      bonuses.push('EMA slope (+2)');
    }

    // ─── 2. MOMENTUM CONFLUENCE (0-20) ─────────────────────────
    const { momentumScore, momentumDetails, momentumBonuses } = this._scoreMomentum(momentum);
    score += momentumScore;
    details.push(...momentumDetails);
    bonuses.push(...momentumBonuses);

    // ─── 3. VOLUME CONFIRMATION (0-15) ─────────────────────────
    const { volumeScore, volumeDetails, volumeBonuses, volumePenalties } = this._scoreVolume(volume);
    score += volumeScore;
    details.push(...volumeDetails);
    bonuses.push(...volumeBonuses);
    penalties.push(...volumePenalties);

    // ─── 4. STRUCTURE CLARITY (0-20) ──────────────────────────
    const { structureScore, structureDetails, structureBonuses } = this._scoreStructure(structure, levels);
    score += structureScore;
    details.push(...structureDetails);
    bonuses.push(...structureBonuses);

    // ─── 5. VOLATILITY QUALITY (0-10) ─────────────────────────
    const { volScore, volDetails, volPenalties } = this._scoreVolatility(atr);
    score += volScore;
    details.push(...volDetails);
    penalties.push(...volPenalties);

    // ─── 6. BTC ALIGNMENT (0-15) ──────────────────────────────
    const { btcScore, btcDetails, btcPenalties } = this._scoreBTC(btcTrend, trend);
    score += btcScore;
    details.push(...btcDetails);
    penalties.push(...btcPenalties);

    // ─── CONTEXTUAL BONUSES ───────────────────────────────────
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
    finalScore = Math.round(finalScore);

    // ─── TIER ASSIGNMENT ──────────────────────────────────────
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
      passed = true;
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

    // Hard floor: R:R must be >= 1.5
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

  // ─── PRIVATE SCORING METHODS ───────────────────────────────

  _scoreTrend(trend, multiTimeframe, volume) {
    let score = 0;
    const details = [];
    const penalties = [];

    if (trend?.primary === 'neutral' || trend?.strength < 30) {
      score += 0;
      details.push('❌ No trend — require stronger setup (+0)');
      
      if (volume?.ratio < 2.0) {
        score -= 10;
        penalties.push('No trend + no volume (-10)');
      }
    } else if (multiTimeframe?.alignment && trend?.strength > 60) {
      score += 22;
      details.push('✅ Strong aligned trend (+22)');
    } else if (trend?.strength > 40) {
      score += 14;
      details.push('⚡ Moderate trend (+14)');
    } else if (trend?.primary !== 'neutral') {
      score += 8;
      details.push('Weak trend (+8)');
    }

    return { trendScore: Math.min(score, 20), trendDetails: details, trendPenalties: penalties };
  }

  _scoreMomentum(momentum) {
    let score = 0;
    const details = [];
    const bonuses = [];

    const rsi = momentum?.rsi?.value || 50;
    const macd = momentum?.macd;
    
    let rsiScore = 0;
    if (rsi >= 35 && rsi <= 65) {
      rsiScore = 8;
      details.push(`RSI balanced ${rsi.toFixed(1)} (+8)`);
    } else if (rsi >= 25 && rsi <= 75) {
      rsiScore = 12;
      details.push(`RSI momentum zone ${rsi.toFixed(1)} (+12)`);
    } else if (rsi >= 20 && rsi <= 80) {
      rsiScore = 6;
      details.push(`RSI extreme ${rsi.toFixed(1)} (+6)`);
    } else {
      rsiScore = 3;
      details.push(`RSI very extreme ${rsi.toFixed(1)} (+3)`);
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

    return { momentumScore: Math.min(score, 20), momentumDetails: details, momentumBonuses: bonuses };
  }

  _scoreVolume(volume) {
    let score = 0;
    const details = [];
    const bonuses = [];
    const penalties = [];

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

    return { volumeScore: Math.min(score, 15), volumeDetails: details, volumeBonuses: bonuses, volumePenalties: penalties };
  }

  _scoreStructure(structure, levels) {
    let score = 0;
    const details = [];
    const bonuses = [];

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

    return { structureScore: Math.min(score, 20), structureDetails: details, structureBonuses: bonuses };
  }

  _scoreVolatility(atr) {
    let score = 0;
    const details = [];
    const penalties = [];

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

    return { volScore: Math.min(score, 10), volDetails: details, volPenalties: penalties };
  }

  _scoreBTC(btcTrend, trend) {
    let score = 0;
    const details = [];
    const penalties = [];

    if (!btcTrend) {
      return { btcScore: 8, btcDetails: ['BTC data unavailable (+8)'], btcPenalties: penalties };
    }

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
      // RELAXED: Only penalize strong BTC opposition
      if (btcTrend.strength > 70 && btcTrend.volatile) {
        score += 5;
        penalties.push('Strong BTC opposition (+5)');
      } else {
        score += 8;
        details.push('Weak BTC opposition — no penalty (+8)');
      }
    }

    return { btcScore: Math.min(score, 15), btcDetails: details, btcPenalties: penalties };
  }
  }
  
