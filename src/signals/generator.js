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
    
    signalLogger.info('SignalGenerator initialized');
  }

  /**
   * Analyze a single symbol across timeframes
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
      // Fetch timeframe data with rate-limit delays
      const m15 = await this.marketData.fetchOHLCV(normalizedSymbol, '15m', 100);
      await sleep(300);
      
      const h1 = await this.marketData.fetchOHLCV(normalizedSymbol, '1h', 80);
      
      let m5 = null;
      let h4 = null;
      
      try {
        await sleep(300);
        m5 = await this.marketData.fetchOHLCV(normalizedSymbol, '5m', 100);
      } catch {
        // 5m is optional — don't fail if unavailable
      }
      
      try {
        await sleep(300);
        h4 = await this.marketData.fetchOHLCV(normalizedSymbol, '4h', 50);
      } catch {
        // 4h is optional — don't fail if unavailable
      }

      // Must have 15m and 1h at minimum
      if (!m15 || m15.length < 20 || !h1 || h1.length < 10) {
        signalLogger.debug(`Insufficient data: ${normalizedSymbol}`);
        return null;
      }

      // Get price with retry logic
      let currentPrice = null;
      let retries = 3;
      while (retries > 0 && !currentPrice) {
        currentPrice = await this.marketData.getCurrentPrice(normalizedSymbol);
        if (!currentPrice) {
          retries--;
          await sleep(500);
        }
      }
      
      if (!currentPrice || currentPrice <= 0) {
        signalLogger.debug(`No valid price: ${normalizedSymbol}`);
        return null;
      }

      // Volume check — reject illiquid coins
      const volume24h = await this.marketData.get24hVolume(normalizedSymbol);
      if (!volume24h || volume24h < CONFIG.TA.MIN_VOLUME_USD) {
        signalLogger.debug(`Low volume rejected: ${normalizedSymbol} $${volume24h || 0}`);
        return null;
      }

      // Run analysis per timeframe
      const analysis15m = runTimeframeAnalysis(m15, '15m');
      const analysis1h = runTimeframeAnalysis(h1, '1h');
      const analysis5m = m5 ? runTimeframeAnalysis(m5, '5m') : null;
      const analysis4h = h4 ? runTimeframeAnalysis(h4, '4h') : null;

      // Multi-timeframe confluence
      const multiTimeframe = buildMultiTimeframe(analysis15m, analysis1h, analysis4h);

      // BTC trend filter — reduces altcoin risk when BTC is volatile/opposing
      const btcTrend = await this.marketData.getBTCTrend();

      // Primary analysis uses 15m as entry timeframe
      const primary = analysis15m;

      // Detect strategy setup from available patterns
      const setup = this.strategy.detect({
        ...primary,
        multiTimeframe,
        price: currentPrice,
      });

      if (!setup) {
        signalLogger.debug(`No strategy match: ${normalizedSymbol}`);
        return null;
      }

      // Validate minimum risk:reward
      if (setup.rr < CONFIG.RISK.MIN_RR) {
        signalLogger.debug(`R:R too low: ${normalizedSymbol} ${setup.rr.toFixed(2)}:1 (min ${CONFIG.RISK.MIN_RR})`);
        return null;
      }

      // Build complete analysis object for confidence scoring
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

      // Calculate confidence score
      const confidence = this.confidence.calculate(fullAnalysis);

      signalLogger.info(
        `${normalizedSymbol}: ${setup.type} ${setup.direction} | ` +
        `Score: ${confidence.score}% | R:R ${setup.rr.toFixed(2)}:1 | ` +
        `Vol: ${primary.volume.ratio.toFixed(2)}x`
      );

      // Apply confidence filter unless forced (diagnostic mode)
      if (!force && !confidence.passed) {
        signalLogger.info(`REJECTED: ${normalizedSymbol} — ${confidence.recommendation}`);
        return null;
      }

      signalLogger.info(`PASSED: ${normalizedSymbol} — ${confidence.tier} grade signal`);

      return {
        ...fullAnalysis,
        confidence,
        timestamp: Date.now(),
      };

    } catch (err) {
      signalLogger.error(`Analysis failed: ${normalizedSymbol} — ${err.message}`);
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

    // Challenge progress percentage
    const progress = ((currentCapital - CONFIG.CHALLENGE.START_CAPITAL) / 
                     (CONFIG.CHALLENGE.TARGET - CONFIG.CHALLENGE.START_CAPITAL)) * 100;

    // Execution steps for trader
    const steps = [
      `Enter ${setup.timeframe} on ${setup.direction === 'bullish' ? 'green' : 'red'} candle close`,
      `Stop: $${setup.stop.toFixed(4)} (${((Math.abs(setup.stop - setup.entry) / setup.entry) * 100).toFixed(2)}%)`,
      `Target 1: $${setup.target.toFixed(4)} (R:R ${setup.rr.toFixed(2)}:1)`,
    ];

    // Scale-out plan for good R:R setups
    if (setup.rr >= 2) {
      const scalePrice = setup.entry + (setup.target - setup.entry) * 0.5 * (setup.direction === 'bullish' ? 1 : -1);
      steps.push(`Scale 50% at $${scalePrice.toFixed(4)} (1:1 R:R), move SL to breakeven`);
    }

    // Second take profit for excellent R:R
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
        bonuses: confidence.bonuses,        // FIXED: was "bonalties"
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
        version: '3.0-institutional',
      },
    };
  }

  /**
   * Generate signal for symbol with full risk checks
   */
  async generateSignal(symbol, force = false) {
    signalLogger.info(`Generating signal: ${symbol} (force=${force})`);

    // Risk state check — cooldown, daily loss limits, consecutive losses
    if (!force && !this.riskManager.canTrade()) {
      signalLogger.warn('Signal blocked by risk manager');
      return null;
    }

    // Daily signal cap
    const todayCount = this._getTodaySignalCount();
    if (!force && todayCount >= CONFIG.RISK.MAX_SIGNALS_PER_DAY) {
      signalLogger.info(`Daily limit reached: ${todayCount}/${CONFIG.RISK.MAX_SIGNALS_PER_DAY}`);
      return null;
    }

    // Max concurrent positions
    if (!force && this.activeSignals.size >= CONFIG.RISK.MAX_ACTIVE_TRADES) {
      signalLogger.warn(`Max active trades: ${this.activeSignals.size}/${CONFIG.RISK.MAX_ACTIVE_TRADES}`);
      return null;
    }

    // Run full analysis
    const analysis = await this.analyzeSymbol(symbol, force);
    if (!analysis) return null;

    // Build signal object
    const signal = this.buildSignal(analysis);
    if (!signal) return null;

    // Track active signal
    this.activeSignals.set(signal.id, signal);
    this._incrementTodayCount();

    // Emit for bot notification
    this.emit('signal', signal);

    // Persist to trade log
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

    // Start price monitoring for SL/TP
    this.monitor.start(signal);

    return signal;
  }

  /**
   * Start continuous market scanning
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
        // Skip cycle if in cooldown or daily loss limit hit
        if (!this.riskManager.canTrade()) {
          await sleep(60000);
          continue;
        }

        const todayCount = this._getTodaySignalCount();
        if (todayCount >= CONFIG.RISK.MAX_SIGNALS_PER_DAY) {
          signalLogger.info(`Daily limit reached (${todayCount}), pausing 5min...`);
          await sleep(300000);
          continue;
        }

        this.scanStats.scansCompleted++;
        signalLogger.info(
          `Scan cycle #${this.scanStats.scansCompleted} | ` +
          `Signals: ${todayCount}/${CONFIG.RISK.MAX_SIGNALS_PER_DAY}`
        );

        // Get top volume pairs and shuffle for variety
        const symbols = await this.marketData.getTopVolumeSymbols(CONFIG.SCAN.TOP_VOLUME_COUNT);
        const shuffled = [...symbols].sort(() => 0.5 - Math.random());

        for (const symbol of shuffled) {
          if (!this.isScanning) break;
          
          // Skip if already have active signal for this symbol (2h cooldown per symbol)
          const hasActive = Array.from(this.activeSignals.values())
            .some(s => s.symbol === symbol && Date.now() - new Date(s.timestamp).getTime() < 7200000);
          
          if (hasActive) {
            signalLogger.debug(`Skipping ${symbol} — active signal exists`);
            continue;
          }

          const signal = await this.generateSignal(symbol);
          if (signal) {
            // Throttle between signals
            await sleep(3000);
            
            // Check if daily limit hit after this signal
            if (this._getTodaySignalCount() >= CONFIG.RISK.MAX_SIGNALS_PER_DAY) {
              break;
            }
          } else {
            // Brief pause between failed scans
            await sleep(500);
          }
        }

        this.scanStats.lastScan = new Date();
        
        // Randomized wait between cycles (30-60s) to avoid pattern detection
        const waitTime = 30000 + Math.random() * 30000;
        await sleep(waitTime);
        
      } catch (err) {
        signalLogger.error(`Scan loop error: ${err.message}`);
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

    // Update risk state (consecutive losses, cooldown)
    this.riskManager.recordResult(pnl);
    
    // Update challenge capital
    CONFIG.CHALLENGE.CURRENT_CAPITAL += pnl;

    // Persist close to trade log
    this.tradeLogger.log('SIGNAL_CLOSED', {
      signalId,
      symbol: signal.symbol,
      result,
      exitPrice,
      pnl,
      pnlPct,
      duration: Date.now() - new Date(signal.timestamp).getTime(),
    });

    // Emit for bot notifications
    this.emit('signal_closed', { signal, result, exitPrice, pnl, pnlPct });
    
    // Remove from active
    this.activeSignals.delete(signalId);
  }

  // ─── INTERNAL HELPERS ──────────────────────────────────────

  _getTodaySignalCount() {
    const today = getTodayKey();
    if (today !== this._todayKey) {
      this._todayKey = today;
      this.scanStats.signalsToday = 0;
    }
    return this.scanStats.signalsToday;
  }

  _incrementTodayCount() {
    this._getTodaySignalCount(); // Ensure date rollover
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
      
