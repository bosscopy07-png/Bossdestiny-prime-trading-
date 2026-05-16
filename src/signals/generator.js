// ==========================================
// REAL-TIME SIGNAL GENERATOR
// Orchestrates analysis, scoring, and signal creation
// ==========================================

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

// Utility: Promise with timeout
function withTimeout(promise, ms, context) {
  const timeout = new Promise((_, reject) => 
    setTimeout(() => reject(new Error(`${context} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

export class SignalGenerator extends EventEmitter {
  constructor(marketData) {
    super();
    
    if (!marketData) {
      throw new Error('MarketDataEngine required');
    }

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
    
    this._todayKey = getTodayKey();
    this._recentScans = new Map(); // Track recently scanned symbols
    
    signalLogger.info('SignalGenerator initialized');
  }

  /**
   * Analyze a single symbol across timeframes — with strict timeouts
   */
  async analyzeSymbol(symbol, force = false) {
    if (!symbol) {
      signalLogger.debug('No symbol provided');
      return null;
    }

    signalLogger.info(`Analyzing ${symbol}...`);

    const normalizedSymbol = this.marketData.normalizeSymbol(symbol);
    if (!normalizedSymbol) {
      signalLogger.warn(`Cannot normalize: ${symbol}`);
      return null;
    }

    try {
      // Fetch 15m with 8s timeout
      const m15 = await withTimeout(
        this.marketData.fetchOHLCV(normalizedSymbol, '15m', 100),
        8000,
        `OHLCV 15m ${normalizedSymbol}`
      );
      await sleep(200);
      
      // Fetch 1h with 8s timeout
      const h1 = await withTimeout(
        this.marketData.fetchOHLCV(normalizedSymbol, '1h', 80),
        8000,
        `OHLCV 1h ${normalizedSymbol}`
      );
      
      // Optional timeframes — 5s timeout, don't fail if missing
      let m5 = null;
      let h4 = null;
      
      try {
        await sleep(200);
        m5 = await withTimeout(
          this.marketData.fetchOHLCV(normalizedSymbol, '5m', 100),
          5000,
          `OHLCV 5m ${normalizedSymbol}`
        );
      } catch (e) {
        signalLogger.debug(`5m fetch failed: ${e.message}`);
      }
      
      try {
        await sleep(200);
        h4 = await withTimeout(
          this.marketData.fetchOHLCV(normalizedSymbol, '4h', 50),
          5000,
          `OHLCV 4h ${normalizedSymbol}`
        );
      } catch (e) {
        signalLogger.debug(`4h fetch failed: ${e.message}`);
      }

      if (!m15 || m15.length < 20 || !h1 || h1.length < 10) {
        signalLogger.debug(`Insufficient data: ${normalizedSymbol}`);
        return null;
      }

      // Get price with 5s timeout, 2 retries
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
          signalLogger.debug(`Price fetch attempt failed: ${e.message}`);
        }
        if (!currentPrice) {
          retries--;
          await sleep(300);
        }
      }
      
      if (!currentPrice || currentPrice <= 0) {
        signalLogger.debug(`No valid price: ${normalizedSymbol}`);
        return null;
      }

      // Volume check with 5s timeout
      let volume24h = 0;
      try {
        volume24h = await withTimeout(
          this.marketData.get24hVolume(normalizedSymbol),
          5000,
          `volume ${normalizedSymbol}`
        );
      } catch (e) {
        signalLogger.debug(`Volume fetch failed: ${e.message}`);
      }
      
      if (!volume24h || volume24h < CONFIG.TA.MIN_VOLUME_USD) {
        signalLogger.debug(`Low volume: ${normalizedSymbol} $${volume24h || 0}`);
        return null;
      }

      // Run analysis
      const analysis15m = runTimeframeAnalysis(m15, '15m');
      const analysis1h = runTimeframeAnalysis(h1, '1h');
      const analysis5m = m5 ? runTimeframeAnalysis(m5, '5m') : null;
      const analysis4h = h4 ? runTimeframeAnalysis(h4, '4h') : null;

      if (!analysis15m || !analysis1h) {
        signalLogger.debug(`Analysis returned null: ${normalizedSymbol}`);
        return null;
      }

      const multiTimeframe = buildMultiTimeframe(analysis15m, analysis1h, analysis4h);

      // BTC trend — 5s timeout
      let btcTrend = { primary: 'neutral', strength: 0, volatile: false };
      try {
        btcTrend = await withTimeout(
          this.marketData.getBTCTrend(),
          5000,
          'BTC trend'
        );
      } catch (e) {
        signalLogger.debug(`BTC trend failed: ${e.message}`);
      }

      const primary = analysis15m;

      const setup = this.strategy.detect({
        ...primary,
        multiTimeframe,
        price: currentPrice,
      });

      if (!setup) {
        signalLogger.debug(`No strategy: ${normalizedSymbol}`);
        return null;
      }

      // Validate R:R sanity
      if (setup.rr < CONFIG.RISK.MIN_RR || setup.rr > 10 || !isFinite(setup.rr)) {
        signalLogger.debug(`Bad R:R: ${normalizedSymbol} ${setup.rr?.toFixed?.(2) || 'invalid'}`);
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

      const confidence = this.confidence.calculate(fullAnalysis);

      signalLogger.info(
        `${normalizedSymbol}: ${setup.type} ${setup.direction} | ` +
        `Score: ${confidence.score}% | R:R ${setup.rr.toFixed(2)}:1`
      );

      if (!force && !confidence.passed) {
        signalLogger.info(`REJECTED: ${normalizedSymbol} — ${confidence.recommendation}`);
        return null;
      }

      signalLogger.info(`PASSED: ${normalizedSymbol} — ${confidence.tier} grade`);

      return {
        ...fullAnalysis,
        confidence,
        timestamp: Date.now(),
      };

    } catch (err) {
      signalLogger.error({ err }, `Analysis failed: ${normalizedSymbol}`);
      return null;
    }
  }

  /**
   * Build complete signal object from analysis
   */
  buildSignal(analysis) {
    const { symbol, price, confidence, setup, multiTimeframe, momentum, volume, levels, atr } = analysis;
    
    const currentCapital = CONFIG.CHALLENGE.CURRENT_CAPITAL;
    const position = calculatePosition(setup, confidence, atr, currentCapital);
    
    if (!position) {
      signalLogger.warn('Position calculation failed — rejecting signal');
      return null;
    }

    const progress = ((currentCapital - CONFIG.CHALLENGE.START_CAPITAL) / 
                     (CONFIG.CHALLENGE.TARGET - CONFIG.CHALLENGE.START_CAPITAL)) * 100;

    const steps = [
      `Enter ${setup.timeframe} on ${setup.direction === 'bullish' ? 'green' : 'red'} candle close`,
      `Stop: $${setup.stop.toFixed(4)} (${((Math.abs(setup.stop - setup.entry) / setup.entry) * 100).toFixed(2)}%)`,
      `Target 1: $${setup.target.toFixed(4)} (R:R ${setup.rr.toFixed(2)}:1)`,
    ];

    if (setup.rr >= 2) {
      const scalePrice = setup.entry + (setup.target - setup.entry) * 0.5 * (setup.direction === 'bullish' ? 1 : -1);
      steps.push(`Scale 50% at $${scalePrice.toFixed(4)} (1:1 R:R), move SL to breakeven`);
    }

    let takeProfit2 = null;
    if (setup.rr >= 2.5) {
      takeProfit2 = setup.entry + (setup.target - setup.entry) * 0.75 * (setup.direction === 'bullish' ? 1 : -1);
    }

    return {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      validUntil: new Date(Date.now() + 4 * 3600000).toISOString(),
      
      symbol,
      direction: setup.direction === 'bullish' ? 'LONG' : 'SHORT',
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
        price: setup.entry,
        zone: {
          min: setup.entry * 0.998,
          max: setup.entry * 1.002,
        },
      },
      
      stopLoss: setup.stop,
      takeProfit: setup.target,
      takeProfit2,
      riskReward: setup.rr.toFixed(2),
      
      position,

      analysis: {
        trend: multiTimeframe.primary.primary,
        trendStrength: multiTimeframe.primary.strength,
        trendAlignment: multiTimeframe.alignment,
        rsi: momentum.rsi.value.toFixed(1),
        rsiCondition: momentum.rsi.condition,
        macdTrend: momentum.macd.trend,
        macdCrossover: momentum.macd.crossover,
        volumeRatio: volume.ratio.toFixed(2),
        volumeTrend: volume.trend,
        support: levels.support?.toFixed(4) || 'N/A',
        resistance: levels.resistance?.toFixed(4) || 'N/A',
        supportTouches: levels.supportTouches,
        resistanceTouches: levels.resistanceTouches,
        structure: setup.context || multiTimeframe.primary.primary,
        atr: atr?.percent?.toFixed(2) + '%' || 'N/A',
      },

      execution: {
        steps,
        invalidation: setup.invalidation,
        warning: setup.warning || null,
        maxHold: setup.timeframe.includes('5M') ? '2-4 hours' : '4-8 hours',
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
        version: '3.1-institutional',
      },
    };
  }

  /**
   * Generate signal for symbol with full risk checks
   */
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

    const analysis = await this.analyzeSymbol(symbol, force);
    if (!analysis) return null;

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

  /**
   * Start continuous market scanning — SEQUENTIAL, not parallel
   */
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

          // Skip if recently scanned (15 min cooldown)
          if (this._wasRecentlyScanned(symbol)) {
            signalLogger.debug(`Skipping ${symbol} — recently scanned`);
            continue;
          }
          
          // Skip if active signal exists (2h cooldown per symbol)
          const hasActive = Array.from(this.activeSignals.values())
            .some(s => s.symbol === symbol && Date.now() - new Date(s.timestamp).getTime() < 7200000);
          
          if (hasActive) {
            signalLogger.debug(`Skipping ${symbol} — active signal exists`);
            continue;
          }

          attempted++;
          
          try {
            // CRITICAL: Timeout the ENTIRE generateSignal call, fully awaited
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
          
          // ALWAYS pause between coins
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

  /**
   * Handle signal closure from monitor
   */
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

  // ─── INTERNAL HELPERS ──────────────────────────────────────

  _wasRecentlyScanned(symbol) {
    const lastScan = this._recentScans.get(symbol);
    if (!lastScan) return false;
    return Date.now() - lastScan < 900000; // 15 minutes
  }

  _markScanned(symbol) {
    this._recentScans.set(symbol, Date.now());
    // Cleanup old entries
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
          
