import { EngineState, CoinState, CANDLE_INTERVAL_MS, MAX_CANDLES, MAX_MINUTE_SAMPLES } from './state.js';
import { MACRO_CONFIG, MacroPhase, nextPhase, fearGreedLabel } from './macroCycle.js';
import { repriceTo, price } from './amm.js';

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

// Derives the constant per-tick drift (in the existing "%/min" convention) that
// carries BTCR from 1x to a randomly-picked target multiplier by the time THIS
// specific phase instance ends, using log-return compounding so the total move
// lands in totalMoveRange exactly — regardless of how long the phase runs, i.e.
// independent of test-speed vs target-speed (1-3 days/cycle) duration.
function driftForTargetMove(totalMoveRange: [number, number], totalTicks: number): number {
  const targetMultiplier = randRange(totalMoveRange[0], totalMoveRange[1]);
  const driftPctPerTick = (Math.log(targetMultiplier) / totalTicks) * 100;
  return driftPctPerTick * 60;
}

function maybeAdvanceMacroPhase(state: EngineState) {
  if (state.tickCount === 0 || state.tickCount >= state.macroPhaseEndTick) {
    const next = state.tickCount === 0 ? state.macroPhase : nextPhase(state.macroPhase);
    const cfg = MACRO_CONFIG[next];
    const durationMin = randRange(cfg.minDurationMin, cfg.maxDurationMin);
    const totalTicks = Math.round(durationMin * 60);
    state.macroPhase = next;
    state.macroPhaseStartTick = state.tickCount;
    state.macroPhaseEndTick = state.tickCount + totalTicks;
    state.macroPhaseDriftPctPerMin = driftForTargetMove(cfg.totalMoveRange, totalTicks);
  }
}

export function forcePhase(state: EngineState, phase: MacroPhase) {
  const cfg = MACRO_CONFIG[phase];
  const durationMin = randRange(cfg.minDurationMin, cfg.maxDurationMin);
  const totalTicks = Math.round(durationMin * 60);
  state.macroPhase = phase;
  state.macroPhaseStartTick = state.tickCount;
  state.macroPhaseEndTick = state.tickCount + totalTicks;
  state.macroPhaseDriftPctPerMin = driftForTargetMove(cfg.totalMoveRange, totalTicks);
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
    const totalPct = driftPctPerTick + baseNoiseContribution + relativeNoiseContribution;

    cs.lastTick = {
      macroDriftPct: macroDriftContribution,
      localDriftPct: localDriftContribution,
      baseNoisePct: baseNoiseContribution,
      relativeNoisePct: relativeNoiseContribution,
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
