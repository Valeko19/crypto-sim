import { EngineState, CoinState, MacroMode, CANDLE_INTERVAL_MS, MAX_CANDLES, MAX_MINUTE_SAMPLES } from './state.js';
import { MACRO_CONFIG, MacroPhase, nextPhase, fearGreedLabel } from './macroCycle.js';
import { repriceTo, price } from './amm.js';
import { gravityPctPerMin } from './gravity.js';

const TICK_MS = 1000;
const FIVE_MIN_MS = 5 * 60_000;
const LIVELINESS_TRIGGER_PCT = 5; // move over 5 min window that "wakes up" a coin
const LIVELINESS_MIN_MULT = 1.3;
const LIVELINESS_MAX_MULT = 2;
const LIVELINESS_CAP = 2.5;
// Noise amplitude as a fraction of current drift magnitude. A candle aggregates
// 5 ticks, and drift accumulates linearly (x5) while independent zero-mean noise
// only accumulates as sqrt(5) (~x2.24) — so whatever ratio makes single ticks
// flip sign is significantly damped by the time 5 of them sum into one candle.
// This value is picked to still produce visible reversal CANDLES (not just ticks).
const RELATIVE_NOISE_FACTOR = 11;

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Smoothed random walk in [-1,1]-ish via sum of two uniforms (cheap bell-shaped noise).
function gaussianish(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
}

// --- Macro drift mode machine -------------------------------------------------
// Most of a phase is spent in 'trend' (drift matching the phase's overall
// direction). It's occasionally interrupted by a 'counter' interlude (a
// temporary, noticeably-sized move AGAINST that direction — sized to plausibly
// read as a reversal) or a 'choppy' interlude (high-amplitude, no net
// direction — a volatile sideways patch, distinct from a quiet pause). Mode
// durations are drawn as FRACTIONS of the total phase length, so the same
// relative structure holds at any game-speed. Only in the final stretch of the
// phase does a "homing" pull blend in toward the target move (see
// `macroDriftForTick`) — the path before that is genuinely unplanned.
const MIN_MODE_TICKS = 15; // floor so even short phases (e.g. 2 min euphoria) still get real segments
const TREND_FRAC_RANGE: [number, number] = [0.15, 0.28];
const COUNTER_FRAC_RANGE: [number, number] = [0.08, 0.16];
const CHOPPY_FRAC_RANGE: [number, number] = [0.08, 0.16];
const COUNTER_MOVE_RANGE: [number, number] = [0.10, 0.22]; // 10-22% temporary swing against the trend
const CORRECTION_START_FRAC = 0.82; // homing pull ramps in over the final ~18% of the phase
// Ceiling on the homing correction's rate, as a multiple of the phase's own
// flat-average rate. Without this, `remainingLogReturn / remainingTicks` blows
// up without bound as remainingTicks shrinks toward its 1-tick floor whenever
// the free-roaming mode machine has left a large gap to close late in the
// phase — producing a single-tick crash/spike instead of a brisk-but-organic
// correction. Capping means a very-late, very-large gap may not be fully
// closed by the exact last tick (ending just outside the target range on rare
// occasions) — an acceptable trade-off against a game-breaking vertical move.
const MAX_HOMING_RATE_MULTIPLIER = 6;
const MIN_HOMING_RATE_CAP_PCT_PER_MIN = 3; // floor so tiny-target phases (e.g. accumulation) still get a real cap

function phaseTotalTicks(state: EngineState): number {
  return Math.max(1, state.macroPhaseEndTick - state.macroPhaseStartTick);
}

// Converts a target log-return, to be achieved over `ticks` ticks, into the
// existing "%/min" drift convention used throughout the tick loop.
function logReturnToDriftPctPerMin(logReturn: number, ticks: number): number {
  return (logReturn / Math.max(1, ticks)) * 100 * 60;
}

function modeDurationTicks(state: EngineState, fracRange: [number, number]): number {
  return Math.max(MIN_MODE_TICKS, Math.round(phaseTotalTicks(state) * randRange(fracRange[0], fracRange[1])));
}

function enterTrendMode(state: EngineState) {
  const durationTicks = modeDurationTicks(state, TREND_FRAC_RANGE);
  // "Flat average" rate the whole phase would need at a constant speed — trend
  // mode moves faster than this baseline since it isn't active 100% of the time.
  const avgRatePerMin = logReturnToDriftPctPerMin(state.macroPhaseTargetLogReturn, phaseTotalTicks(state));
  state.macroMode = 'trend';
  state.macroModeEndTick = state.tickCount + durationTicks;
  state.macroModeDriftPctPerMin = avgRatePerMin * randRange(1.0, 2.2);
}

function enterCounterMode(state: EngineState) {
  const durationTicks = modeDurationTicks(state, COUNTER_FRAC_RANGE);
  const overallUp = state.macroPhaseTargetLogReturn >= 0;
  // Against the OVERALL direction, an absolute swing regardless of how big the
  // phase's own target is — this is what makes it read as a plausible fakeout.
  const swingMultiplier = overallUp ? randRange(1 - COUNTER_MOVE_RANGE[1], 1 - COUNTER_MOVE_RANGE[0])
                                     : 1 / randRange(1 - COUNTER_MOVE_RANGE[1], 1 - COUNTER_MOVE_RANGE[0]);
  const counterLogReturn = Math.log(swingMultiplier);
  state.macroMode = 'counter';
  state.macroModeEndTick = state.tickCount + durationTicks;
  state.macroModeDriftPctPerMin = logReturnToDriftPctPerMin(counterLogReturn, durationTicks);
}

function enterChoppyMode(state: EngineState) {
  const durationTicks = modeDurationTicks(state, CHOPPY_FRAC_RANGE);
  const avgRatePerMin = Math.abs(logReturnToDriftPctPerMin(state.macroPhaseTargetLogReturn, phaseTotalTicks(state)));
  state.macroMode = 'choppy';
  state.macroModeEndTick = state.tickCount + durationTicks;
  state.macroChoppyAmplitudePctPerMin = avgRatePerMin * randRange(1.6, 3.0);
  state.macroModeDriftPctPerMin = state.macroChoppyAmplitudePctPerMin * gaussianish();
}

// Called every tick: advances the mode machine when the current mode's
// (randomly-drawn) duration elapses, and resamples 'choppy' fresh each tick
// (zero-mean, so it swings without ever trending anywhere).
function updateMacroMode(state: EngineState) {
  if (state.tickCount >= state.macroModeEndTick) {
    if (state.macroMode === 'trend') {
      if (Math.random() < 0.5) enterCounterMode(state);
      else enterChoppyMode(state);
    } else {
      enterTrendMode(state); // counter/choppy interludes always resolve back to trend
    }
  } else if (state.macroMode === 'choppy') {
    state.macroModeDriftPctPerMin = state.macroChoppyAmplitudePctPerMin * gaussianish();
  }
}

// The actual per-tick macro drift: the live mode-machine's rate for most of the
// phase, blended into a "homing" correction over the final stretch so the total
// move still lands in the phase's target range no matter how the free-roaming
// part behaved. The homing target is recomputed from the ACTUAL current price
// every tick, so it adapts to noise/mode behavior instead of assuming a path.
function macroDriftForTick(state: EngineState): number {
  const totalTicks = phaseTotalTicks(state);
  const progressFrac = (state.tickCount - state.macroPhaseStartTick) / totalTicks;

  if (progressFrac < CORRECTION_START_FRAC) return state.macroModeDriftPctPerMin;

  const btcrPrice = price(state.coins['btcr'].pool);
  const accumulatedLogReturn = Math.log(btcrPrice / state.macroPhaseStartPrice);
  const remainingLogReturn = state.macroPhaseTargetLogReturn - accumulatedLogReturn;
  const remainingTicks = Math.max(1, state.macroPhaseEndTick - state.tickCount);
  const rawHomingRate = logReturnToDriftPctPerMin(remainingLogReturn, remainingTicks);

  const avgRatePerMin = Math.abs(logReturnToDriftPctPerMin(state.macroPhaseTargetLogReturn, totalTicks));
  const homingCap = Math.max(avgRatePerMin * MAX_HOMING_RATE_MULTIPLIER, MIN_HOMING_RATE_CAP_PCT_PER_MIN);
  const homingRate = Math.max(-homingCap, Math.min(homingCap, rawHomingRate));

  const correctionWeight = Math.min(1, (progressFrac - CORRECTION_START_FRAC) / (1 - CORRECTION_START_FRAC));
  return state.macroModeDriftPctPerMin * (1 - correctionWeight) + homingRate * correctionWeight;
}

function enterPhase(state: EngineState, phase: MacroPhase) {
  const cfg = MACRO_CONFIG[phase];
  const durationMin = randRange(cfg.minDurationMin, cfg.maxDurationMin);
  const totalTicks = Math.round(durationMin * 60);
  const targetMultiplier = randRange(cfg.totalMoveRange[0], cfg.totalMoveRange[1]);

  state.macroPhase = phase;
  state.macroPhaseStartTick = state.tickCount;
  state.macroPhaseEndTick = state.tickCount + totalTicks;
  state.macroPhaseTargetLogReturn = Math.log(targetMultiplier);
  state.macroPhaseStartPrice = price(state.coins['btcr'].pool);

  enterTrendMode(state); // every phase starts off trending
  state.macroPhaseDriftPctPerMin = state.macroModeDriftPctPerMin;
}

function maybeAdvanceMacroPhase(state: EngineState) {
  if (state.tickCount === 0 || state.tickCount >= state.macroPhaseEndTick) {
    const next = state.tickCount === 0 ? state.macroPhase : nextPhase(state.macroPhase);
    enterPhase(state, next);
  }
}

export function forcePhase(state: EngineState, phase: MacroPhase) {
  enterPhase(state, phase);
}

export function phaseProgress(state: EngineState): { progressPct: number; remainingSec: number; elapsedSec: number; durationSec: number } {
  const elapsedTicks = state.tickCount - state.macroPhaseStartTick;
  const durationTicks = Math.max(1, state.macroPhaseEndTick - state.macroPhaseStartTick);
  const progressPct = Math.max(0, Math.min(100, (elapsedTicks / durationTicks) * 100));
  const remainingTicks = Math.max(0, state.macroPhaseEndTick - state.tickCount);
  return {
    progressPct,
    elapsedSec: Math.round((elapsedTicks * TICK_MS) / 1000),
    remainingSec: Math.round((remainingTicks * TICK_MS) / 1000),
    durationSec: Math.round((durationTicks * TICK_MS) / 1000),
  };
}

function updateLocalCycle(cs: CoinState, state: EngineState) {
  const lc = cs.localCycle;
  const cfg = cs.config;
  if (cfg.localCycleMaxMin === 0) return; // top1 has no local cycle

  if (lc.phase === 'idle') {
    // small chance per tick to start a rise; tuned so average gap ~= mid of the
    // coin's own local-cycle range, per the "10-60 min rise->peak->pullback" spec.
    const avgGapMin = (cfg.localCycleMinMin + cfg.localCycleMaxMin) / 2;
    const chancePerTick = 1 / (avgGapMin * 60);
    if (Math.random() < chancePerTick) {
      const durationMin = randRange(cfg.localCycleMinMin, cfg.localCycleMaxMin) * 0.6;
      const [volMin, volMax] = cfg.volPerMinPct;
      const magnitude = randRange(volMin, volMax) * randRange(1.5, 3);
      const upBias = MACRO_CONFIG[state.macroPhase].localCycleUpBias;
      lc.phase = 'rising';
      lc.phaseEndTick = state.tickCount + Math.round(durationMin * 60);
      lc.driftPctPerMin = magnitude * (Math.random() < upBias ? 1 : -1);
      lc.riseGainPct = 0;
    }
  } else if (lc.phase === 'rising') {
    lc.riseGainPct += lc.driftPctPerMin / 60;
    if (state.tickCount >= lc.phaseEndTick) {
      const pullbackDurationMin = randRange(cfg.localCycleMinMin, cfg.localCycleMaxMin) * 0.4;
      const retrace = randRange(0.3, 0.7);
      lc.phase = 'pullback';
      lc.phaseEndTick = state.tickCount + Math.round(pullbackDurationMin * 60);
      lc.driftPctPerMin = -(lc.riseGainPct * retrace) / pullbackDurationMin;
    }
  } else if (lc.phase === 'pullback') {
    if (state.tickCount >= lc.phaseEndTick) {
      lc.phase = 'idle';
      lc.driftPctPerMin = 0;
      lc.riseGainPct = 0;
    }
  }
}

function updateLiveliness(cs: CoinState, now: number) {
  const cutoff = now - FIVE_MIN_MS;
  cs.fiveMinHistory = cs.fiveMinHistory.filter(s => s.t >= cutoff);
  const currentPrice = price(cs.pool);
  cs.fiveMinHistory.push({ t: now, p: currentPrice });

  const oldest = cs.fiveMinHistory[0];
  const movePct = Math.abs((currentPrice / oldest.p - 1) * 100);

  // Decay existing multiplier toward 1 first.
  const dt = now - cs.livelinessLastUpdateMs;
  cs.livelinessLastUpdateMs = now;
  const decayFactor = Math.pow(0.5, dt / cs.livelinessHalfLifeMs);
  cs.livelinessMultiplier = 1 + (cs.livelinessMultiplier - 1) * decayFactor;

  if (movePct > LIVELINESS_TRIGGER_PCT) {
    const bump = randRange(LIVELINESS_MIN_MULT, LIVELINESS_MAX_MULT);
    cs.livelinessMultiplier = Math.min(LIVELINESS_CAP, Math.max(cs.livelinessMultiplier, bump));
    cs.livelinessHalfLifeMs = randRange(15, 30) * 60_000;
  }
}

const TICKS_PER_CANDLE = CANDLE_INTERVAL_MS / TICK_MS;

// Bucketed by tick count (not wall-clock time) so candle spacing stays exactly
// uniform even if a tick's actual firing jitters a bit under event-loop load —
// wall-clock bucketing could otherwise skip or double a bucket and leave a
// visible gap between candles on the chart.
function updateCandle(cs: CoinState, state: EngineState) {
  const p = price(cs.pool);
  const bucketIndex = Math.floor(state.tickCount / TICKS_PER_CANDLE);
  const bucketStart = state.engineStartMs + bucketIndex * CANDLE_INTERVAL_MS;
  if (!cs.currentCandle || cs.currentCandle.t !== bucketStart) {
    // Carry the previous candle's close over as this candle's open so there's
    // no visible price gap at the boundary — `p` already reflects this tick's
    // own price move and folds in as the first high/low/close update instead,
    // exactly like every other tick within the candle.
    const openPrice = cs.currentCandle ? cs.currentCandle.c : p;
    if (cs.currentCandle) {
      cs.candles.push(cs.currentCandle);
      if (cs.candles.length > MAX_CANDLES) cs.candles.shift();
    }
    cs.currentCandle = { t: bucketStart, o: openPrice, h: Math.max(openPrice, p), l: Math.min(openPrice, p), c: p };
  } else {
    cs.currentCandle.h = Math.max(cs.currentCandle.h, p);
    cs.currentCandle.l = Math.min(cs.currentCandle.l, p);
    cs.currentCandle.c = p;
  }
}

function updateMinuteHistory(cs: CoinState, now: number) {
  const last = cs.minuteHistory[cs.minuteHistory.length - 1];
  if (now - last.t >= 60_000) {
    cs.minuteHistory.push({ t: now, p: price(cs.pool) });
    if (cs.minuteHistory.length > MAX_MINUTE_SAMPLES) cs.minuteHistory.shift();
  }
}

export function tick(state: EngineState) {
  const now = Date.now();
  maybeAdvanceMacroPhase(state);
  updateMacroMode(state);
  state.macroPhaseDriftPctPerMin = macroDriftForTick(state);

  const btcr = state.coins['btcr'];
  const macroDriftPerTick = state.macroPhaseDriftPctPerMin / 60;
  const macroVolMult = MACRO_CONFIG[state.macroPhase].volMultiplier;

  for (const cs of Object.values(state.coins)) {
    const cfg = cs.config;
    updateLocalCycle(cs, state);

    let macroDriftContribution: number;
    let localDriftContribution: number;
    if (cfg.id === 'btcr') {
      macroDriftContribution = macroDriftPerTick;
      localDriftContribution = 0;
    } else {
      const localDriftPerTick = cs.localCycle.driftPctPerMin / 60;
      // beta amplifies the macro-driven share beyond 1x — alts/memes swing harder
      // than the leader, not just a damped fraction of its move.
      macroDriftContribution = cfg.macroCorrelation * cfg.beta * macroDriftPerTick;
      localDriftContribution = (1 - cfg.macroCorrelation) * localDriftPerTick;
    }
    const driftPctPerTick = macroDriftContribution + localDriftContribution;

    const [volMin, volMax] = cfg.volPerMinPct;
    const baseVolPerMin = randRange(volMin, volMax);
    const baseNoiseContribution = (gaussianish() * baseVolPerMin / Math.sqrt(60)) * macroVolMult * cs.livelinessMultiplier;
    // Noise proportional to the CURRENT drift magnitude, on top of the small
    // ambient baseline above. A fixed vol/min baseline reads as a flat line next
    // to a phase drift strong enough to move the price 50-80%+ in minutes — this
    // term keeps the chart visibly jagged (false breakouts, wobble) at any drift
    // scale without needing separate noise tuning per phase/category.
    const relativeNoiseContribution = RELATIVE_NOISE_FACTOR * Math.abs(driftPctPerTick) * gaussianish();
    // Long-horizon anchor pull (see gravity.ts) — computed after the relative
    // noise term so it isn't fed into that term's scaling, and kept fully
    // independent of the macro phase/mode machine above.
    const gravityContribution = gravityPctPerMin(cs) / 60;
    const totalPct = driftPctPerTick + baseNoiseContribution + relativeNoiseContribution + gravityContribution;

    cs.lastTick = {
      macroDriftPct: macroDriftContribution,
      localDriftPct: localDriftContribution,
      baseNoisePct: baseNoiseContribution,
      relativeNoisePct: relativeNoiseContribution,
      gravityPct: gravityContribution,
      totalPct,
    };

    const currentPrice = price(cs.pool);
    const targetPrice = Math.max(currentPrice * (1 + totalPct / 100), currentPrice * 1e-6);
    repriceTo(cs.pool, targetPrice);

    updateLiveliness(cs, now);
    updateCandle(cs, state);
    updateMinuteHistory(cs, now);
  }

  // Fear & greed: phase base, nudged by BTCR's recent (5 min window) momentum.
  const btcrMove = (() => {
    const hist = btcr.fiveMinHistory;
    if (hist.length < 2) return 0;
    return (price(btcr.pool) / hist[0].p - 1) * 100;
  })();
  const base = MACRO_CONFIG[state.macroPhase].fearGreedBase;
  const nudge = Math.max(-15, Math.min(15, btcrMove * 3));
  state.fearGreedIndex = Math.round(Math.max(0, Math.min(100, base + nudge)));

  state.tickCount++;
}

export function startEngineLoop(state: EngineState, onTick: () => void): NodeJS.Timeout {
  return setInterval(() => {
    tick(state);
    onTick();
  }, TICK_MS);
}

export { fearGreedLabel };
