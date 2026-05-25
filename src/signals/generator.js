import { EventEmitter } from 'events';
import crypto from 'crypto';
import { CONFIG } from '../config/index.js';
import { signalLogger } from '../utils/logger.js';
import { sleep, getTodayKey } from '../utils/time.js';
import { runTimeframeAnalysis, buildMultiTimeframe } from '../analysis/multiTimeframe.js';
import { StrategyDetector } from '../strategy/detector.js';
import { ConfidenceEngine } from '../strategy/scoring.js';
import { calculatePosition } from '../risk/positionSizing.js';
import { RiskManager } from '../risk/cooldown.js';
import { SignalMonitor } from './monitor.js';
import { TradeLogger } from '../utils/tradeLogger.js';

function withTimeout(promise, ms, context) {
  const timeout = new Promise((_, reject) => 
    setTimeout(() => reject(new Error(`${context} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

export class SignalGenerator extends EventEmitter {
  constructor(marketData) {
    super();
    
    if (!marketData) throw new Error('MarketDataEngine required');

    this.marketData = marketData;
    this.strategy = new StrategyDetector();
    this.confidence = new ConfidenceEngine();
    this.riskManager = new RiskManager();
    this.monitor = new SignalMonitor(marketData, (id, result, price) => this._onSignalClose(id, result, price));
    this.tradeLogger = new TradeLogger();
    this.activeSignals = new Map();
    this.isScanning = false;
    this.scanStats = {
      lastScan: null,
      signalsToday: 0,
      scansCompleted: 0,
    };
    
    // Anti-correlation tracking
    this.lastSignalDirection = null;
    this.consecutiveSameDirection = 0;
    
    this._todayKey = getTodayKey();
    this._recentScans = new Map();
    
    signalLogger.info('SignalGenerator initialized v3.3-community');
  }
    async analyzeSymbol(symbol, force = false) {
    if (!symbol) {
      signalLogger.debug('No symbol provided');
      return null;
    }

    signalLogger.info(`=== START: ${symbol} ===`);

    const normalizedSymbol = this.marketData.normalizeSymbol(symbol);
    if (!normalizedSymbol) {
      signalLogger.info(`FAIL: normalizeSymbol returned null`);
      return null;
    }
    signalLogger.info(`Normalized: ${normalizedSymbol}`);

    try {
      // ─── FETCH CORE TIMEFRAMES ──────────────────────────────
      signalLogger.info(`[${normalizedSymbol}] Fetching 15m OHLCV...`);
      const m15 = await withTimeout(
        this.marketData.fetchOHLCV(normalizedSymbol, '15m', 100), 
        8000, 
        `OHLCV 15m ${normalizedSymbol}`
      );
      signalLogger.info(`[${normalizedSymbol}] 15m result: ${m15 ? m15.length + ' candles' : 'NULL'}`);
      if (!m15 || m15.length < 20) {
        signalLogger.info(`[${normalizedSymbol}] FAIL: 15m insufficient data`);
        return null;
      }
      await sleep(200);

      signalLogger.info(`[${normalizedSymbol}] Fetching 1h OHLCV...`);
      const h1 = await withTimeout(
        this.marketData.fetchOHLCV(normalizedSymbol, '1h', 80), 
        8000, 
        `OHLCV 1h ${normalizedSymbol}`
      );
      signalLogger.info(`[${normalizedSymbol}] 1h result: ${h1 ? h1.length + ' candles' : 'NULL'}`);
      if (!h1 || h1.length < 10) {
        signalLogger.info(`[${normalizedSymbol}] FAIL: 1h insufficient data`);
        return null;
      }
      await sleep(200);

      // ─── FETCH OPTIONAL TIMEFRAMES ───────────────────────────
      let m5 = null;
      try {
        signalLogger.info(`[${normalizedSymbol}] Fetching 5m OHLCV (optional)...`);
        m5 = await withTimeout(
          this.marketData.fetchOHLCV(normalizedSymbol, '5m', 100), 
          5000, 
          `OHLCV 5m ${normalizedSymbol}`
        );
        signalLogger.info(`[${normalizedSymbol}] 5m result: ${m5 ? m5.length + ' candles' : 'NULL'}`);
      } catch (e) {
        signalLogger.info(`[${normalizedSymbol}] 5m fetch failed (optional): ${e.message}`);
      }
      await sleep(200);

      let h4 = null;
      try {
        signalLogger.info(`[${normalizedSymbol}] Fetching 4h OHLCV (optional)...`);
        h4 = await withTimeout(
          this.marketData.fetchOHLCV(normalizedSymbol, '4h', 50), 
          5000, 
          `OHLCV 4h ${normalizedSymbol}`
        );
        signalLogger.info(`[${normalizedSymbol}] 4h result: ${h4 ? h4.length + ' candles' : 'NULL'}`);
      } catch (e) {
        signalLogger.info(`[${normalizedSymbol}] 4h fetch failed (optional): ${e.message}`);
      }

      // ─── FETCH CURRENT PRICE ──────────────────────────────────
      signalLogger.info(`[${normalizedSymbol}] Fetching current price...`);
      let currentPrice = null;
      let retries = 2;
      while (retries > 0 && !currentPrice) {
        try {
          currentPrice = await withTimeout(
            this.marketData.getCurrentPrice(normalizedSymbol), 
            5000, 
            `price ${normalizedSymbol}`
          );
        } catch (e) {
          signalLogger.info(`[${normalizedSymbol}] Price fetch attempt failed: ${e.message}`);
        }
        if (!currentPrice) {
          retries--;
          if (retries > 0) {
            signalLogger.info(`[${normalizedSymbol}] Retrying price fetch... (${retries} left)`);
            await sleep(300);
          }
        }
      }
      
      signalLogger.info(`[${normalizedSymbol}] Price result: ${currentPrice}`);
      if (!currentPrice || currentPrice <= 0) {
        signalLogger.info(`[${normalizedSymbol}] FAIL: no valid price`);
        return null;
      }

      // ─── FETCH 24H VOLUME ─────────────────────────────────────
      signalLogger.info(`[${normalizedSymbol}] Fetching 24h volume...`);
      let volume24h = 0;
      try {
        volume24h = await withTimeout(
          this.marketData.get24hVolume(normalizedSymbol), 
          5000, 
          `volume ${normalizedSymbol}`
        );
      } catch (e) {
        signalLogger.info(`[${normalizedSymbol}] Volume fetch failed: ${e.message}`);
      }
      
      signalLogger.info(`[${normalizedSymbol}] Volume result: $${volume24h} (min: $${CONFIG.TA.MIN_VOLUME_USD})`);
      if (!volume24h || volume24h < CONFIG.TA.MIN_VOLUME_USD) {
        signalLogger.info(`[${normalizedSymbol}] FAIL: volume $${volume24h} below minimum $${CONFIG.TA.MIN_VOLUME_USD}`);
        return null;
      }

      // ─── RUN TECHNICAL ANALYSIS ─────────────────────────────
      signalLogger.info(`[${normalizedSymbol}] Running timeframe analysis...`);
      const analysis15m = runTimeframeAnalysis(m15, '15m');
      const analysis1h = runTimeframeAnalysis(h1, '1h');
      const analysis5m = m5 ? runTimeframeAnalysis(m5, '5m') : null;
      const analysis4h = h4 ? runTimeframeAnalysis(h4, '4h') : null;

      signalLogger.info(`[${normalizedSymbol}] Analysis results — 15m: ${analysis15m ? 'OK' : 'NULL'}, 1h: ${analysis1h ? 'OK' : 'NULL'}, 5m: ${analysis5m ? 'OK' : 'NULL'}, 4h: ${analysis4h ? 'OK' : 'NULL'}`);

      if (!analysis15m || !analysis1h) {
        signalLogger.info(`[${normalizedSymbol}] FAIL: core analysis returned null`);
        return null;
      }

      signalLogger.info(`[${normalizedSymbol}] Building multi-timeframe confluence...`);
      const multiTimeframe = buildMultiTimeframe(analysis15m, analysis1h, analysis4h);

      // ─── FETCH BTC TREND ────────────────────────────────────
      signalLogger.info(`[${normalizedSymbol}] Fetching BTC trend...`);
      let btcTrend = { primary: 'neutral', strength: 0, volatile: false };
      try {
        btcTrend = await withTimeout(this.marketData.getBTCTrend(), 5000, 'BTC trend');
        signalLogger.info(`[${normalizedSymbol}] BTC trend: ${btcTrend.primary} (strength: ${btcTrend.strength})`);
      } catch (e) {
        signalLogger.info(`[${normalizedSymbol}] BTC trend fetch failed: ${e.message}`);
      }

      const primary = analysis15m;

      // ─── DETECT STRATEGY SETUP ──────────────────────────────
      signalLogger.info(`[${normalizedSymbol}] Detecting strategy setup...`);
      const setup = this.strategy.detect({
        ...primary,
        multiTimeframe,
        price: currentPrice,
      });

      signalLogger.info(`[${normalizedSymbol}] Strategy detect: ${setup ? setup.type + ' ' + setup.direction + ' (R:R ' + setup.rr.toFixed(2) + ':1)' : 'NULL'}`);
      
      if (!setup) {
        signalLogger.info(`[${normalizedSymbol}] FAIL: no strategy setup matched`);
        return null;
      }

      if (setup.rr < CONFIG.RISK.MIN_RR || setup.rr > 10 || !isFinite(setup.rr)) {
        signalLogger.info(`[${normalizedSymbol}] FAIL: R:R ${setup.rr?.toFixed?.(2) || 'invalid'} outside valid range [${CONFIG.RISK.MIN_RR}, 10]`);
        return null;
      }

      const fullAnalysis = {
        symbol: normalizedSymbol,
        price: currentPrice,
        multiTimeframe,
        momentum: primary.momentum,
        volume: primary.volume,
        levels: primary.levels,
        structure: primary.structure,
        sweep: primary.sweep,
        setup,
        atr: primary.atr,
        btcTrend,
        ohlcv: m15,
      };

      // ─── CALCULATE CONFIDENCE ───────────────────────────────
      signalLogger.info(`[${normalizedSymbol}] Calculating confidence score...`);
      const confidence = this.confidence.calculate(fullAnalysis);

      signalLogger.info(
        `[${normalizedSymbol}] RESULT: ${setup.type} ${setup.direction} | ` +
        `Score: ${confidence.score}% | R:R ${setup.rr.toFixed(2)}:1 | ` +
        `Vol: ${primary.volume.ratio.toFixed(2)}x | ` +
        `Tier: ${confidence.tier} | Passed: ${confidence.passed}`
      );

      if (!force && !confidence.passed) {
        signalLogger.info(`[${normalizedSymbol}] REJECTED: ${confidence.recommendation}`);
        signalLogger.info(`=== END: ${symbol} [REJECTED] ===`);
        return null;
      }

      signalLogger.info(`[${normalizedSymbol}] PASSED: ${confidence.tier} grade signal`);
      signalLogger.info(`=== END: ${symbol} [PASSED] ===`);

      return {
        ...fullAnalysis,
        confidence,
        timestamp: Date.now(),
      };

    } catch (err) {
      signalLogger.error({ err }, `[${normalizedSymbol}] CRASH during analysis`);
      signalLogger.info(`=== END: ${symbol} [CRASH] ===`);
      return null;
    }
  }

  buildSignal(analysis) {
    const { symbol, price, confidence, setup, multiTimeframe, momentum, volume, levels, atr } = analysis;
    
    const currentCapital = CONFIG.CHALLENGE.CURRENT_CAPITAL;
    const streakData = this.riskManager.getStreakData();
    const position = calculatePosition(setup, confidence, atr, currentCapital, streakData);
    
    if (!position) {
      signalLogger.warn('Position calculation failed — rejecting signal');
      return null;
    }

    const cleanSymbol = (raw) => {
      if (!raw) return 'UNKNOWN';
      return raw.replace(/:USDT$/, '').replace(/\/USDT$/, '');
    };
    
    const displaySymbol = cleanSymbol(symbol);
    const fullSymbol = symbol;

    const progress = ((currentCapital - CONFIG.CHALLENGE.START_CAPITAL) / 
                     (CONFIG.CHALLENGE.TARGET - CONFIG.CHALLENGE.START_CAPITAL)) * 100;

    const fmtPrice = (p) => {
      if (p === undefined || p === null) return 'N/A';
      const val = parseFloat(p);
      if (isNaN(val)) return 'N/A';
      if (val >= 10000) return val.toFixed(0);
      if (val >= 1000) return val.toFixed(1);
      if (val >= 100) return val.toFixed(2);
      if (val >= 1) return val.toFixed(4);
      if (val >= 0.01) return val.toFixed(6);
      if (val >= 0.0001) return val.toFixed(8);
      return val.toExponential(4);
    };

    const isLong = setup.direction === 'bullish';
    const entry = setup.entry;
    const stop = setup.stop;
    const target = setup.target;
    
    const scalePrice = entry + (target - entry) * 0.5;
    
    let takeProfit2 = setup.takeProfit2;
    if (!takeProfit2 && setup.rr >= 2.5) {
      const tpDistance = Math.abs(target - entry);
      takeProfit2 = isLong 
        ? entry + (tpDistance * 1.5)
        : entry - (tpDistance * 1.5);
    }

    if (takeProfit2) {
      const tp2Correct = isLong ? takeProfit2 > target : takeProfit2 < target;
      if (!tp2Correct) {
        signalLogger.warn(`TP2 direction wrong for ${displaySymbol}, fixing`);
        takeProfit2 = isLong 
          ? target + Math.abs(target - entry) * 0.5
          : target - Math.abs(target - entry) * 0.5;
      }
    }

    const steps = [
      `Enter ${setup.timeframe} on ${isLong ? 'green' : 'red'} candle close`,
      `Stop: $${fmtPrice(stop)} (${((Math.abs(stop - entry) / entry) * 100).toFixed(2)}%)`,
      `Target 1: $${fmtPrice(target)} (R:R ${setup.rr.toFixed(2)}:1)`,
    ];

    if (setup.rr >= 2) {
      steps.push(`Scale 50% at $${fmtPrice(scalePrice)} (1:1 R:R), move SL to breakeven`);
    }

    if (takeProfit2) {
      steps.push(`Target 2: $${fmtPrice(takeProfit2)} (full close)`);
    }

    const maxHold = setup.maxHold || (setup.timeframe?.includes('5M') ? '2-4 hours' : '8-24 hours');

    return {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      validUntil: new Date(Date.now() + 24 * 3600000).toISOString(),
      
      symbol: fullSymbol,
      displaySymbol,
      direction: isLong ? 'LONG' : 'SHORT',
      strategy: setup.type,
      quality: setup.quality,
      
      confidence: {
        score: confidence.score,
        tier: confidence.tier,
        level: confidence.confidence,
        details: confidence.details,
        bonuses: confidence.bonuses,
        penalties: confidence.penalties,
        recommendation: confidence.recommendation,
      },

      entry: {
        price: entry,
        zone: { min: entry * 0.998, max: entry * 1.002 },
      },
      
      stopLoss: stop,
      takeProfit: target,
      takeProfit2,
      scalePrice,
      riskReward: setup.rr.toFixed(2),
      
      position: {
        riskPct: position.riskPct,
        riskAmount: position.riskAmount,
        leverage: position.leverage,
        baseQty: position.baseQty,
        notionalValue: position.notionalValue,
        margin: position.margin,
        estProfit: position.estProfit,
        estLoss: position.estLoss,
        unit: position.unit,
        meta: position.meta,
      },

      analysis: {
        trend: multiTimeframe?.primary?.primary || 'neutral',
        trendStrength: multiTimeframe?.primary?.strength || 0,
        trendAlignment: multiTimeframe?.alignment || 'single',
        rsi: momentum?.rsi?.value?.toFixed(1) || '50.0',
        rsiCondition: momentum?.rsi?.condition || 'neutral',
        macdTrend: momentum?.macd?.trend || 'neutral',
        macdCrossover: momentum?.macd?.crossover || 'none',
        volumeRatio: volume?.ratio?.toFixed(2) || '1.00',
        volumeTrend: volume?.trend || 'normal',
        support: levels?.support ? fmtPrice(levels.support) : 'N/A',
        resistance: levels?.resistance ? fmtPrice(levels.resistance) : 'N/A',
        supportTouches: levels?.supportTouches || 0,
        resistanceTouches: levels?.resistanceTouches || 0,
        structure: setup.context || multiTimeframe?.primary?.primary || 'neutral',
        atr: atr?.percent ? atr.percent.toFixed(2) + '%' : 'N/A',
      },

      execution: {
        steps,
        invalidation: setup.invalidation,
        warning: setup.warning || null,
        maxHold,
        scalePrice: scalePrice ? fmtPrice(scalePrice) : null,
      },

      challenge: {
        startCapital: CONFIG.CHALLENGE.START_CAPITAL,
        currentCapital: currentCapital.toFixed(2),
        target: CONFIG.CHALLENGE.TARGET,
        progress: Math.max(0, Math.min(100, progress)).toFixed(1),
        daysLeft: CONFIG.CHALLENGE.DAYS,
      },

      meta: {
        scannedAt: new Date().toISOString(),
        dataQuality: 'multi-timeframe',
        version: '3.3-community',
      },
    };
  }

  async generateSignal(symbol, force = false) {
    signalLogger.info(`Generating signal: ${symbol} (force=${force})`);

    if (!force && !this.riskManager.canTrade()) {
      signalLogger.warn('Signal blocked by risk manager');
      return null;
    }

    const todayCount = this._getTodaySignalCount();
    if (!force && todayCount >= CONFIG.RISK.MAX_SIGNALS_PER_DAY) {
      signalLogger.info(`Daily limit reached: ${todayCount}/${CONFIG.RISK.MAX_SIGNALS_PER_DAY}`);
      return null;
    }

    if (!force && this.activeSignals.size >= CONFIG.RISK.MAX_ACTIVE_TRADES) {
      signalLogger.warn(`Max active trades: ${this.activeSignals.size}/${CONFIG.RISK.MAX_ACTIVE_TRADES}`);
      return null;
    }

    this._markScanned(symbol);

    const analysis = await this.analyzeSymbol(symbol, force);
    if (!analysis) return null;

    // ─── ANTI-CORRELATION: Prevent consecutive same-direction signals ─
    if (analysis.setup.direction === this.lastSignalDirection) {
      this.consecutiveSameDirection++;
      if (this.consecutiveSameDirection >= 2) {
        if (analysis.confidence.score < 70) {
          signalLogger.info(`REJECTED: ${symbol} — ${analysis.setup.direction} #${this.consecutiveSameDirection + 1}, need 70%+`);
          return null;
        }
      }
    } else {
      this.consecutiveSameDirection = 0;
    }
    this.lastSignalDirection = analysis.setup.direction;

    // ─── COMMUNITY GATE: Minimum standards for public signals ─
    const MIN_CONFIDENCE = 60;
    const MIN_VOLUME = 0.8;
    const MIN_RR = 1.8;

    if (!force && analysis.confidence.score < MIN_CONFIDENCE) {
      signalLogger.info(`[${symbol}] REJECTED: Confidence ${analysis.confidence.score}% < ${MIN_CONFIDENCE}% (community standard)`);
      return null;
    }
    
    if (!force && analysis.volume?.ratio < MIN_VOLUME) {
      signalLogger.info(`[${symbol}] REJECTED: Volume ${analysis.volume.ratio}x < ${MIN_VOLUME}x (dead coin)`);
      return null;
    }
    
    if (!force && analysis.setup.rr < MIN_RR) {
      signalLogger.info(`[${symbol}] REJECTED: R:R ${analysis.setup.rr} < ${MIN_RR} (poor reward)`);
      return null;
    }

    const signal = this.buildSignal(analysis);
    if (!signal) return null;

    this.activeSignals.set(signal.id, signal);
    this._incrementTodayCount();

    this.emit('signal', signal);

    await this.tradeLogger.log('SIGNAL_GENERATED', {
      signalId: signal.id,
      symbol: signal.symbol,
      direction: signal.direction,
      confidence: signal.confidence.score,
      strategy: signal.strategy,
      quality: signal.quality,
      rr: signal.riskReward,
      entry: signal.entry.price,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
    });

    signalLogger.info(
      `SIGNAL CREATED: ${signal.id.slice(0, 8)} | ` +
      `${symbol} ${signal.direction} | ` +
      `${signal.confidence.score}% ${signal.quality}`
    );

    this.monitor.start(signal);

    return signal;
  }

  async startContinuousScanning() {
    if (this.isScanning) {
      signalLogger.warn('Scanning already active');
      return;
    }
    
    this.isScanning = true;
    signalLogger.info('Starting continuous scanning...');
    this.emit('scanning_started');

    while (this.isScanning) {
      try {
        if (!this.riskManager.canTrade()) {
          await sleep(60000);
          continue;
        }

        const todayCount = this._getTodaySignalCount();
        if (todayCount >= CONFIG.RISK.MAX_SIGNALS_PER_DAY) {
          signalLogger.info(`Daily limit reached, pausing 5min...`);
          await sleep(300000);
          continue;
        }

        this.scanStats.scansCompleted++;
        signalLogger.info(`Cycle #${this.scanStats.scansCompleted} | Signals: ${todayCount}/${CONFIG.RISK.MAX_SIGNALS_PER_DAY}`);

        const symbols = await this.marketData.getTopVolumeSymbols(CONFIG.SCAN.TOP_VOLUME_COUNT);
        signalLogger.info(`Got ${symbols.length} symbols to scan`);

        if (symbols.length === 0) {
          await sleep(120000);
          continue;
        }

        const shuffled = [...symbols].sort(() => 0.5 - Math.random());
        let attempted = 0;
        let created = 0;

        for (const symbol of shuffled) {
          if (!this.isScanning) break;

          if (this._wasRecentlyScanned(symbol)) {
            signalLogger.debug(`Skipping ${symbol} — recently scanned`);
            continue;
          }
          
          const hasActive = Array.from(this.activeSignals.values())
            .some(s => s.symbol === symbol && Date.now() - new Date(s.timestamp).getTime() < 7200000);
          
          if (hasActive) {
            signalLogger.debug(`Skipping ${symbol} — active signal exists`);
            continue;
          }

          attempted++;
          
          try {
            const signal = await withTimeout(
              this.generateSignal(symbol),
              25000,
              `generateSignal ${symbol}`
            );
            
            if (signal) {
              created++;
              await sleep(5000);
              if (this._getTodaySignalCount() >= CONFIG.RISK.MAX_SIGNALS_PER_DAY) break;
            }
          } catch (err) {
            signalLogger.error({ err }, `Timeout or error on ${symbol}`);
          }
          
          await sleep(1500);
        }

        signalLogger.info(`Cycle done: ${attempted} attempted, ${created} signals created`);
        
        const waitTime = created > 0 ? 60000 : 30000;
        signalLogger.info(`Waiting ${waitTime/1000}s...`);
        await sleep(waitTime);
        
      } catch (err) {
        signalLogger.error({ err }, 'Scan loop error');
        await sleep(60000);
      }
    }
  }

  stopScanning() {
    signalLogger.info('Stopping scanning...');
    this.isScanning = false;
    this.emit('scanning_stopped');
  }

  _onSignalClose(signalId, result, exitPrice) {
    const signal = this.activeSignals.get(signalId);
    if (!signal) {
      signalLogger.warn(`Close callback for unknown signal: ${signalId.slice(0, 8)}`);
      return;
    }

    const isWin = result.includes('take_profit');
    const multiplier = result === 'take_profit_2' ? 1.5 : 1;
    const pnl = isWin 
      ? parseFloat(signal.position.estProfit) * multiplier
      : -parseFloat(signal.position.estLoss);
    
    const pnlPct = (pnl / CONFIG.CHALLENGE.CURRENT_CAPITAL) * 100;

    signalLogger.info(
      `CLOSED: ${signal.symbol} ${result.toUpperCase()} @ $${exitPrice.toFixed(4)} | ` +
      `P&L: $${pnl.toFixed(2)} (${pnlPct > 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`
    );

    this.riskManager.recordResult(pnl);
    CONFIG.CHALLENGE.CURRENT_CAPITAL += pnl;

    this.tradeLogger.log('SIGNAL_CLOSED', {
      signalId,
      symbol: signal.symbol,
      result,
      exitPrice,
      pnl,
      pnlPct,
      duration: Date.now() - new Date(signal.timestamp).getTime(),
    });

    this.emit('signal_closed', { signal, result, exitPrice, pnl, pnlPct });
    this.activeSignals.delete(signalId);
  }

  _wasRecentlyScanned(symbol) {
    const lastScan = this._recentScans.get(symbol);
    if (!lastScan) return false;
    return Date.now() - lastScan < 120000;
  }

  _markScanned(symbol) {
    this._recentScans.set(symbol, Date.now());
    const cutoff = Date.now() - 3600000;
    for (const [sym, time] of this._recentScans) {
      if (time < cutoff) this._recentScans.delete(sym);
    }
  }

  _getTodaySignalCount() {
    const today = getTodayKey();
    if (today !== this._todayKey) {
      this._todayKey = today;
      this.scanStats.signalsToday = 0;
      this._recentScans.clear();
    }
    return this.scanStats.signalsToday;
  }

  _incrementTodayCount() {
    this._getTodaySignalCount();
    this.scanStats.signalsToday++;
  }

  getActiveSignals() {
    return Array.from(this.activeSignals.values());
  }

  getStats() {
    return {
      ...this.scanStats,
      activeSignals: this.activeSignals.size,
      isScanning: this.isScanning,
      riskStatus: this.riskManager.getStatus(),
    };
  }
}
