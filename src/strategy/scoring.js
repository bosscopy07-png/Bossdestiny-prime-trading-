// ==========================================
// CONFIDENCE SCORING ENGINE
// Multi-factor weighted scoring 0-100
// VERSION: 3.4 — NaN-hardened, fully guarded
// ==========================================

import { CONFIG } from '../config/index.js';
import { clamp } from '../utils/math.js';
import { signalLogger } from '../utils/logger.js';

const QUALITY_RANK = { 'A+': 5, 'A': 4, 'A-': 3.5, 'B+': 3, 'B': 2, 'C+': 1 };

/**
 * Safely add to score, log if NaN detected
 */
function safeAdd(score, value, context) {
  const numValue = Number(value) || 0;
  if (isNaN(value)) {
    signalLogger.warn(`Confidence NaN detected in: ${context}`);
    return score; // Skip NaN, don't poison score
  }
  return score + numValue;
}

/**
 * Validate and sanitize confidence result
 */
function sanitizeConfidence(raw) {
  let { score, tier, passed, confidence, recommendation } = raw;
  
  // Hard guard: any NaN = invalid signal
  if (isNaN(score) || score === null || score === undefined) {
    signalLogger.warn(`Confidence score invalid (${score}), forcing rejection`);
    score = 0;
    tier = 'D';
    passed = false;
    confidence = 'low';
    recommendation = 'Invalid signal — calculation error';
  }
  
  // Ensure score is integer 0-100
  score = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  
  // Re-evaluate tier based on sanitized score
  if (score >= 75) { tier = 'A+'; passed = true; confidence = 'high'; recommendation = 'Strong signal — Full size'; }
  else if (score >= 65) { tier = 'A'; passed = true; confidence = 'high'; recommendation = 'Good signal — Full size'; }
  else if (score >= 55) { tier = 'B+'; passed = true; confidence = 'medium'; recommendation = 'Moderate signal — Standard size'; }
  else if (score >= 45) { tier = 'B'; passed = true; confidence = 'medium'; recommendation = 'Marginal signal — Reduce size 25%'; }
  else if (score >= 35) { tier = 'C+'; passed = false; confidence = 'low'; recommendation = 'Weak signal — Reduce size 50%'; }
  else if (score >= 25) { tier = 'C'; passed = false; confidence = 'low'; recommendation = 'Avoid — Paper trade only'; }
  else { tier = 'D'; passed = false; confidence = 'low'; recommendation = 'No trade'; }
  
  return { ...raw, score, tier, passed, confidence, recommendation };
}

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
    signalLogger.info('ConfidenceEngine v3.4 initialized (NaN-hardened)');
  }

  calculate(analysis) {
    let score = 0;
    const details = [];
    const bonuses = [];
    const penalties = [];

    const { trend, multiTimeframe, momentum, volume, structure, levels, atr, btcTrend, setup } = analysis;

    // ─── GUARD: Required fields ───────────────────────────────
    if (!setup || typeof setup.rr !== 'number' || !isFinite(setup.rr)) {
      signalLogger.warn('ConfidenceEngine: Invalid setup object');
      return this._reject('Invalid setup — missing R:R');
    }

    const rr = setup.rr;

    // ─── 1. TREND ANALYSIS (0-20) ─────────────────────────────
    const trendResult = this._scoreTrend(trend, multiTimeframe, volume);
    score = safeAdd(score, trendResult.score, 'trend');
    details.push(...(trendResult.details || []));
    penalties.push(...(trendResult.penalties || []));

    if (Math.abs(Number(trend?.slope) || 0) > 0.05) {
      score = safeAdd(score, 2, 'EMA slope bonus');
      bonuses.push('EMA slope (+2)');
    }

    // ─── 2. MOMENTUM CONFLUENCE (0-20) ─────────────────────────
    const momentumResult = this._scoreMomentum(momentum);
    score = safeAdd(score, momentumResult.score, 'momentum');
    details.push(...(momentumResult.details || []));
    bonuses.push(...(momentumResult.bonuses || []));

    // ─── 3. VOLUME CONFIRMATION (0-15) ─────────────────────────
    const volumeResult = this._scoreVolume(volume);
    score = safeAdd(score, volumeResult.score, 'volume');
    details.push(...(volumeResult.details || []));
    bonuses.push(...(volumeResult.bonuses || []));
    penalties.push(...(volumeResult.penalties || []));

    // ─── 4. STRUCTURE CLARITY (0-20) ──────────────────────────
    const structureResult = this._scoreStructure(structure, levels);
    score = safeAdd(score, structureResult.score, 'structure');
    details.push(...(structureResult.details || []));
    bonuses.push(...(structureResult.bonuses || []));

    // ─── 5. VOLATILITY QUALITY (0-10) ─────────────────────────
    const volResult = this._scoreVolatility(atr);
    score = safeAdd(score, volResult.score, 'volatility');
    details.push(...(volResult.details || []));
    penalties.push(...(volResult.penalties || []));

    // ─── 6. BTC ALIGNMENT (0-15) ──────────────────────────────
    const btcResult = this._scoreBTC(btcTrend, trend);
    score = safeAdd(score, btcResult.score, 'BTC alignment');
    details.push(...(btcResult.details || []));
    penalties.push(...(btcResult.penalties || []));

    // ─── CONTEXTUAL BONUSES ───────────────────────────────────
    if (rr >= 3) {
      score = safeAdd(score, 5, 'R:R 3+ bonus');
      bonuses.push('Excellent R:R (+5)');
    } else if (rr >= 2) {
      score = safeAdd(score, 3, 'R:R 2+ bonus');
      bonuses.push('Good R:R (+3)');
    }

    // ─── PENALTIES ────────────────────────────────────────────
    const atrPct = Number(atr?.percent) || 0;
    if (atrPct > 6) {
      score = safeAdd(score, -3, 'high vol penalty');
      penalties.push('High vol penalty (-3)');
    }
    
    const volRatio = Number(volume?.ratio) || 0;
    if (volRatio < 0.5) {
      score = safeAdd(score, -3, 'very low volume penalty');
      penalties.push('Very low volume (-3)');
    }
    
    if (multiTimeframe?.higherTF?.primary !== 'neutral' && 
        multiTimeframe?.higherTF?.primary !== trend?.primary &&
        Number(multiTimeframe?.higherTF?.strength) > 50) {
      score = safeAdd(score, -3, 'against strong HTF penalty');
      penalties.push('Against strong HTF (-3)');
    }

    // ─── FINAL SANITIZATION ───────────────────────────────────
    let finalScore = clamp(score, 0, 100);
    finalScore = Math.round(finalScore);

    // Hard floor: R:R minimum
    let passed = true;
    let tier, confidence, recommendation;

    if (rr < 1.5) {
      passed = false;
      recommendation = `R:R ${rr.toFixed(2)} too low — Minimum 1.5:1`;
    }

    // Build raw result then sanitize
    const rawResult = {
      score: finalScore,
      tier: 'D', // placeholder, sanitized below
      passed,
      confidence: 'low',
      recommendation: recommendation || '',
      details,
      bonuses,
      penalties,
      breakdown: { total: finalScore },
    };

    return sanitizeConfidence(rawResult);
  }

  _reject(reason) {
    return {
      score: 0,
      tier: 'D',
      passed: false,
      confidence: 'low',
      recommendation: reason,
      details: [reason],
      bonuses: [],
      penalties: [],
      breakdown: { total: 0 },
    };
  }

  // ─── PRIVATE SCORING METHODS ───────────────────────────────

  _scoreTrend(trend, multiTimeframe, volume) {
    let score = 0;
    const details = [];
    const penalties = [];

    const trendPrimary = trend?.primary || 'neutral';
    const trendStrength = Number(trend?.strength) || 0;
    const isAligned = !!multiTimeframe?.alignment;

    if (trendPrimary === 'neutral' || trendStrength < 30) {
      details.push('❌ No trend — require stronger setup (+0)');
      
      if (Number(volume?.ratio) < 2.0) {
        score = safeAdd(score, -10, 'no trend + no volume');
        penalties.push('No trend + no volume (-10)');
      }
    } else if (isAligned && trendStrength > 60) {
      score = safeAdd(score, 22, 'strong aligned trend');
      details.push('✅ Strong aligned trend (+22)');
    } else if (trendStrength > 40) {
      score = safeAdd(score, 14, 'moderate trend');
      details.push('⚡ Moderate trend (+14)');
    } else if (trendPrimary !== 'neutral') {
      score = safeAdd(score, 8, 'weak trend');
      details.push('Weak trend (+8)');
    }

    return { 
      score: Math.min(score, 20), 
      details, 
      penalties 
    };
  }

  _scoreMomentum(momentum) {
    let score = 0;
    const details = [];
    const bonuses = [];

    const rsi = Number(momentum?.rsi?.value) || 50;
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
    const macdCrossover = macd?.crossover;
    const macdTrend = macd?.trend || '';
    
    if (macdCrossover && macdCrossover !== 'none') {
      macdScore = 10;
      details.push(`MACD ${macdCrossover} crossover (+10)`);
    } else if (macdTrend.includes('bullish') || macdTrend.includes('bearish')) {
      macdScore = 7;
      details.push(`MACD ${macdTrend} (+7)`);
    } else if (Number(macd?.momentum) > 0.0003) {
      macdScore = 4;
      details.push('Weak MACD (+4)');
    } else {
      macdScore = 2;
    }

    if (momentum?.rsi?.divergence?.bullish || momentum?.rsi?.divergence?.bearish) {
      score = safeAdd(score, 3, 'RSI divergence');
      bonuses.push('RSI divergence (+3)');
    }

    score = safeAdd(score, rsiScore + macdScore, 'momentum total');

    return { 
      score: Math.min(score, 20), 
      details, 
      bonuses 
    };
  }

  _scoreVolume(volume) {
    let score = 0;
    const details = [];
    const bonuses = [];
    const penalties = [];

    const volRatio = Number(volume?.ratio) || 1;
    
    if (volRatio >= 1.5) {
      score = safeAdd(score, 13, 'good volume');
      details.push(`Good volume ${volRatio.toFixed(1)}x (+13)`);
    } else if (volRatio >= 1.2) {
      score = safeAdd(score, 10, 'adequate volume');
      details.push(`Adequate volume ${volRatio.toFixed(1)}x (+10)`);
    } else if (volRatio >= 0.8) {
      score = safeAdd(score, 6, 'normal volume');
      details.push(`Normal volume ${volRatio.toFixed(1)}x (+6)`);
    } else {
      score = safeAdd(score, 3, 'low volume');
      penalties.push(`Low volume ${volRatio.toFixed(1)}x (+3)`);
    }

    if (volume?.confirmation || volume?.trend === 'increasing') {
      score = safeAdd(score, 2, 'volume rising');
      bonuses.push('Volume rising (+2)');
    }

    return { 
      score: Math.min(score, 15), 
      details, 
      bonuses, 
      penalties 
    };
  }

  _scoreStructure(structure, levels) {
    let score = 0;
    const details = [];
    const bonuses = [];

    const bos = structure?.bos || 'none';
    const structStrength = Number(structure?.strength) || 0;

    if (bos !== 'none' && structStrength > 40) {
      score = safeAdd(score, 16, 'structure break');
      details.push(`Structure break (+16)`);
    } else if (bos !== 'none') {
      score = safeAdd(score, 12, 'weak structure break');
      details.push(`Weak structure break (+12)`);
    } else if (structure?.trending && structStrength > 30) {
      score = safeAdd(score, 9, 'trending structure');
      details.push('Trending structure (+9)');
    } else if (structure?.consolidation) {
      score = safeAdd(score, 6, 'consolidation');
      details.push('Consolidation (+6)');
    } else {
      score = safeAdd(score, 3, 'unclear structure');
      details.push('Unclear structure (+3)');
    }

    const supportTouches = Number(levels?.supportTouches) || 0;
    const resistanceTouches = Number(levels?.resistanceTouches) || 0;
    
    if (levels?.valid && (supportTouches >= 1 || resistanceTouches >= 1)) {
      score = safeAdd(score, 4, 'tested S/R');
      bonuses.push('Tested S/R (+4)');
    }

    return { 
      score: Math.min(score, 20), 
      details, 
      bonuses 
    };
  }

  _scoreVolatility(atr) {
    let score = 0;
    const details = [];
    const penalties = [];

    const atrPct = Number(atr?.percent) || 0;

    if (atrPct >= 0.8 && atrPct <= 4) {
      score = safeAdd(score, 9, 'healthy vol');
      details.push(`Healthy vol ${atrPct}% (+9)`);
    } else if (atrPct >= 0.4 && atrPct <= 6) {
      score = safeAdd(score, 6, 'acceptable vol');
      details.push(`Acceptable vol ${atrPct}% (+6)`);
    } else if (atrPct > 6) {
      score = safeAdd(score, 3, 'high vol');
      penalties.push(`High vol ${atrPct}% (+3)`);
    } else {
      score = safeAdd(score, 4, 'low vol');
      details.push(`Low vol ${atrPct}% (+4)`);
    }

    return { 
      score: Math.min(score, 10), 
      details, 
      penalties 
    };
  }

  _scoreBTC(btcTrend, trend) {
    let score = 0;
    const details = [];
    const penalties = [];

    if (!btcTrend) {
      return { 
        score: 8, 
        details: ['BTC data unavailable (+8)'], 
        penalties 
      };
    }

    const btcPrimary = btcTrend.primary || 'neutral';
    const btcStrength = Number(btcTrend.strength) || 0;
    const btcVolatile = !!btcTrend.volatile;
    const trendPrimary = trend?.primary || 'neutral';

    if (btcVolatile) {
      score = safeAdd(score, 5, 'BTC volatile');
      penalties.push('BTC volatile (+5)');
    } else if (btcPrimary === trendPrimary && btcStrength > 40) {
      score = safeAdd(score, 13, 'BTC aligned');
      details.push('BTC aligned (+13)');
    } else if (btcPrimary === 'neutral') {
      score = safeAdd(score, 8, 'BTC neutral');
      details.push('BTC neutral (+8)');
    } else if (btcPrimary !== trendPrimary) {
      if (btcStrength > 70 && btcVolatile) {
        score = safeAdd(score, 5, 'strong BTC opposition');
        penalties.push('Strong BTC opposition (+5)');
      } else {
        score = safeAdd(score, 8, 'weak BTC opposition');
        details.push('Weak BTC opposition — no penalty (+8)');
      }
    }

    return { 
      score: Math.min(score, 15), 
      details, 
      penalties 
    };
  }
      }
      
