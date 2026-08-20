import { EngineState, CoinState, MacroMode, CANDLE_INTERVAL_MS, MAX_CANDLES, RECENT_CHANGE_WINDOW_MS } from './state.js';
import { MACRO_CONFIG, MacroPhase, nextPhase, fearGreedLabel } from './macroCycle.js';
import { repriceTo, price } from './amm.js';
import { gravityPctPerMin } from './gravity.js';
import { logReturnToDriftPctPerMin } from './driftMath.js';
import { maybeTriggerNews, newsDriftContribution, advanceNewsEvent } from './news.js';

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
// Caps how much of noiseAmp's full range (see NOISE_AMP_MAX below) this term
// gets to use — see the long comment at its use site in the main tick loop
// for why (RELATIVE_NOISE_FACTOR * noiseAmp is an up-to-35x multiplier on the
// drift at noiseAmp's full ceiling, and noiseAmp staying elevated across
// several correlated ticks is what compounds into a near-vertical move).
const RELATIVE_NOISE_AMP_CAP = 1.8;
// Array#shift() is O(n) — negligible at the real cadence (once per candle
// close, i.e. every CANDLE_INTERVAL_MS), but adds up badly under
// /debug/fast-forward's tight synchronous tick loop (see api/routes.ts),
// which can replay tens of thousands of candle closes per coin in one call.
// Letting the array overshoot MAX_CANDLES by this many entries before
// trimming it back down in one batched slice() amortizes that cost across
// many pushes instead of paying it on every single one.
const CANDLE_TRIM_BATCH = 200;

// --- Sub-candle texture ---------------------------------------------------
// The mode machine above gives the phase its large-scale structure (trend
// legs, fakeout reversals, choppy patches). Within one continuous trend leg
// the noise terms above still draw from a FIXED-width distribution every
// tick, which makes candles come out too uniform (near-identical body size,
// no wicks). Two independent, mean-zero additions fix the texture without
// touching the mode machine, the target/homing math, or gravity:
//
// 1. `noiseAmpState` — a bounded, mean-reverting (Ornstein-Uhlenbeck-ish)
//    multiplier on the noise terms, so the noise's own SCALE clusters over a
//    ~1-2 candle timescale (calm patches vs. bursty patches) instead of every
//    tick being drawn from the same width. Multiplying an already zero-mean
//    noise term by a random positive scalar keeps it zero-mean (the amp state
//    is independent of the noise draw), so this can't bias the phase target.
// 2. A rare single-tick "stumble" — a short impulse against the coin's
//    current drift direction, exactly cancelled on the very next tick (stored
//    in `stumblePending`), so its net contribution across the pair of ticks
//    is precisely zero. Landing mid-candle it reads as a wick; landing across
//    a candle boundary it occasionally reads as one off-color candle — never
//    a sustained reversal, since it's gone again one tick later.
const NOISE_AMP_MEAN_REVERSION = 0.15; // per-tick pull of noiseAmpState back toward 1
const NOISE_AMP_SHOCK = 0.14; // per-tick random shock size
const NOISE_AMP_MIN = 0.3;
const NOISE_AMP_MAX = 3.2;
const STUMBLE_CHANCE_PER_TICK = 0.005; // ~once every ~3.3min per coin on average
const STUMBLE_MAGNITUDE_RANGE: [number, number] = [2.5, 5]; // multiple of the coin's typical per-tick noise scale

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Smoothed random walk in [-1,1]-ish via sum of two uniforms (cheap bell-shaped noise).
function gaussianish(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
}

// Bounded mean-reverting walk around 1.0 — see "Sub-candle texture" above.
function updateNoiseAmpState(cs: CoinState): number {
  const next = cs.noiseAmpState + NOISE_AMP_MEAN_REVERSION * (1 - cs.noiseAmpState) + NOISE_AMP_SHOCK * gaussianish();
  cs.noiseAmpState = Math.max(NOISE_AMP_MIN, Math.min(NOISE_AMP_MAX, next));
  return cs.noiseAmpState;
}

// Mean-zero single-tick counter-impulse — see "Sub-candle texture" above. Pass
// the coin's current drift direction so the stumble opposes whatever it's
// presently doing; returns this tick's contribution (0 most ticks). Caller is
// responsible for handling any already-pending reversal before calling this.
function updateStumble(cs: CoinState, driftPctPerTick: number, baseVolPerMin: number): number {
  if (Math.random() < STUMBLE_CHANCE_PER_TICK) {
    const trendSign = driftPctPerTick >= 0 ? 1 : -1;
    const perTickVolScale = baseVolPerMin / Math.sqrt(60);
    const magnitude = perTickVolScale * randRange(STUMBLE_MAGNITUDE_RANGE[0], STUMBLE_MAGNITUDE_RANGE[1]);
    const impulse = -trendSign * magnitude;
    cs.stumblePending = impulse; // reversed on the very next tick
    return impulse;
  }
  return 0;
}

// A single trend-mode segment can span a large fraction of a phase's ticks
// (up to ~28% — TREND_FRAC_RANGE below) with a roughly constant drift
// direction, which produces a long tail of same-color candle streaks
// whenever per-candle noise isn't big enough to occasionally flip a close
// back against that drift. This was originally scoped to bear only (its
// trend segments were measured to be the worst offender at the time), but a
// diagnostic run across all five phases (server/scripts/diagnose-volatility.ts)
// found accumulation/early_bull/bull now produce LONGER max streaks per
// phase than bear does (15 trials each: accumulation up to 27, early_bull up
// to 29, bull up to 28, vs bear's 20) — so this now runs for every phase, not
// just bear. The plain per-tick stumble above mostly can't fix this on its
// own: it spikes and cancels one tick later, and since a candle spans 5
// ticks, ~80% of the time both the spike and its cancellation land inside
// the SAME candle and net out before that candle even closes — invisible as
// anything but a wick, never as an actual color flip. Shortening trend
// segments to compensate was tried (for bear) and rejected: it measurably
// undershot the phase's own calibrated target (the capped homing correction
// can't always make up lost ground). Instead: on the specific tick that's
// about to CLOSE a candle, with a chance that escalates once real same-color
// streaks have built up (tracked via `sameColorStreak`), push just far
// enough to flip that candle's close to the other side of its open — then
// cancel the exact same amount on the next tick (the new candle's first
// tick), so the net effect across the pair is still exactly zero, only this
// time reliably landing on the one candle that needed to flip.
const STREAK_GRACE = 5; // candles of the same color before any extra chance kicks in
const STREAK_HAZARD_RATE = 0.05; // added chance per candle past the grace streak
const STREAK_HAZARD_MAX = 0.55; // cap so it's a strong nudge, never a certainty
const STREAK_FLIP_BUFFER_PCT = 0.4; // how far past zero the flip pushes, so the new color is unambiguous

// Caller is responsible for handling any already-pending reversal before
// calling this (see updateStumble above).
function maybeBreakColorStreak(cs: CoinState, state: EngineState): number {
  const isClosingTick = state.tickCount % TICKS_PER_CANDLE === TICKS_PER_CANDLE - 1;
  if (!isClosingTick || !cs.currentCandle) return 0;
  const streak = cs.sameColorStreak;
  if (streak < STREAK_GRACE) return 0;
  const hazard = Math.min(STREAK_HAZARD_MAX, STREAK_HAZARD_RATE * (streak - STREAK_GRACE + 1));
  if (Math.random() >= hazard) return 0;

  const openPrice = cs.currentCandle.o;
  const currentPrice = price(cs.pool);
  const currentMovePct = (currentPrice / openPrice - 1) * 100;
  // Push to the opposite side of zero (relative to how this candle is
  // currently trending) plus a small buffer, so the flip is unambiguous.
  const targetSign = currentMovePct >= 0 ? -1 : 1;
  const impulse = -currentMovePct + targetSign * STREAK_FLIP_BUFFER_PCT;
  cs.stumblePending = impulse; // cancelled on the new candle's first tick
  return impulse;
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

// Floor so trend/choppy mode amplitude never collapses toward zero just
// because the phase's own TARGET move happens to be small (accumulation) or
// a particular draw happens to land near it (any phase, in principle). Without
// this, `avgRatePerMin` below — derived purely from the target log-return —
// goes to ~0 for accumulation specifically, which then also flattens
// relativeNoiseContribution in the main loop (it scales off the same drift),
// leaving nothing but the tiny ambient baseline noise: a visually dead flat
// line instead of a quiet-but-alive chop. The floor is anchored to the
// phase's own volMultiplier (already lower for accumulation than every other
// phase) and BTCR's ambient vol/min, so relative phase ordering (accumulation
// quietest, euphoria/bear loudest) is preserved — it only ever raises a
// mode's rate, never lowers a phase's naturally larger one.
const MODE_RATE_FLOOR_FACTOR = 2.2;

function modeRateFloorPctPerMin(state: EngineState): number {
  const [volMin, volMax] = state.coins['btcr'].config.volPerMinPct;
  const ambientVolPerMin = (volMin + volMax) / 2;
  return ambientVolPerMin * MACRO_CONFIG[state.macroPhase].volMultiplier * MODE_RATE_FLOOR_FACTOR;
}

function modeDurationTicks(state: EngineState, fracRange: [number, number]): number {
  return Math.max(MIN_MODE_TICKS, Math.round(phaseTotalTicks(state) * randRange(fracRange[0], fracRange[1])));
}

function enterTrendMode(state: EngineState) {
  const durationTicks = modeDurationTicks(state, TREND_FRAC_RANGE);
  // "Flat average" rate the whole phase would need at a constant speed — trend
  // mode moves faster than this baseline since it isn't active 100% of the time.
  const avgRatePerMin = logReturnToDriftPctPerMin(state.macroPhaseTargetLogReturn, phaseTotalTicks(state));
  const sign = avgRatePerMin >= 0 ? 1 : -1;
  const magnitude = Math.max(Math.abs(avgRatePerMin), modeRateFloorPctPerMin(state));
  state.macroMode = 'trend';
  state.macroModeStartTick = state.tickCount;
  state.macroModeEndTick = state.tickCount + durationTicks;
  state.macroModeDriftPctPerMin = sign * magnitude * randRange(1.0, 2.2);
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
  state.macroModeStartTick = state.tickCount;
  state.macroModeEndTick = state.tickCount + durationTicks;
  state.macroModeDriftPctPerMin = logReturnToDriftPctPerMin(counterLogReturn, durationTicks);
}

function enterChoppyMode(state: EngineState) {
  const durationTicks = modeDurationTicks(state, CHOPPY_FRAC_RANGE);
  const avgRatePerMin = Math.abs(logReturnToDriftPctPerMin(state.macroPhaseTargetLogReturn, phaseTotalTicks(state)));
  const magnitude = Math.max(avgRatePerMin, modeRateFloorPctPerMin(state));
  state.macroMode = 'choppy';
  state.macroModeStartTick = state.tickCount;
  state.macroModeEndTick = state.tickCount + durationTicks;
  state.macroChoppyAmplitudePctPerMin = magnitude * randRange(1.6, 3.0);
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
      const closedColor: 'red' | 'green' = cs.currentCandle.c >= cs.currentCandle.o ? 'green' : 'red';
      cs.sameColorStreak = closedColor === cs.lastCandleColor ? cs.sameColorStreak + 1 : 1;
      cs.lastCandleColor = closedColor;
      cs.candles.push(cs.currentCandle);
      if (cs.candles.length > MAX_CANDLES + CANDLE_TRIM_BATCH) cs.candles = cs.candles.slice(-MAX_CANDLES);
    }
    cs.currentCandle = { t: bucketStart, o: openPrice, h: Math.max(openPrice, p), l: Math.min(openPrice, p), c: p };
  } else {
    cs.currentCandle.h = Math.max(cs.currentCandle.h, p);
    cs.currentCandle.l = Math.min(cs.currentCandle.l, p);
    cs.currentCandle.c = p;
  }
}

// Dense (every-tick) rolling window, same technique as fiveMinHistory below —
// the oldest surviving sample approximates "price RECENT_CHANGE_WINDOW_MS ago"
// closely regardless of tick timing, unlike a once-a-minute sampled history.
function updateRecentHistory(cs: CoinState, now: number) {
  const cutoff = now - RECENT_CHANGE_WINDOW_MS;
  cs.recentHistory = cs.recentHistory.filter(s => s.t >= cutoff);
  cs.recentHistory.push({ t: now, p: price(cs.pool) });
}

export function tick(state: EngineState) {
  // Simulated wall-clock position, not the real Date.now() — matches how
  // updateCandle already buckets by tickCount instead of real time (same
  // rationale: stays exactly uniform regardless of a tick's real firing
  // jitter). Critically, this also keeps recentHistory/fiveMinHistory's
  // rolling-window trims correct under POST /debug/fast-forward (see
  // api/routes.ts), which replays many ticks in a tight synchronous loop —
  // real time barely advances across that loop, so a literal Date.now() would
  // make the trim's cutoff stay ~constant and the "recent" arrays would grow
  // unbounded for the whole fast-forwarded window instead of staying capped.
  const now = state.engineStartMs + state.tickCount * TICK_MS;
  maybeAdvanceMacroPhase(state);
  updateMacroMode(state);
  maybeTriggerNews(state);
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
    // Amplitude itself clusters tick-to-tick (see updateNoiseAmpState) instead
    // of every tick drawing from the same fixed width — this is what makes
    // candle bodies/wicks vary in size instead of forming an even staircase.
    const noiseAmp = updateNoiseAmpState(cs);
    const baseNoiseContribution = (gaussianish() * baseVolPerMin / Math.sqrt(60)) * macroVolMult * cs.livelinessMultiplier * noiseAmp;
    // Noise proportional to the CURRENT drift magnitude, on top of the small
    // ambient baseline above. A fixed vol/min baseline reads as a flat line next
    // to a phase drift strong enough to move the price 50-80%+ in minutes — this
    // term keeps the chart visibly jagged (false breakouts, wobble) at any drift
    // scale without needing separate noise tuning per phase/category.
    //
    // Tried multiplying this by macroVolMult first (same as baseNoiseContribution)
    // to keep it from growing relatively louder as a phase's ambient floor gets
    // quieter — measured via server/scripts/diagnose-volatility.ts to make things
    // WORSE for bull/euphoria/bear specifically, since their volMultiplier is
    // ABOVE 1 (they're meant to be louder than accumulation/early_bull), so that
    // scaling amplified this term there instead of taming it. The real problem is
    // the term's own worst-case ceiling: RELATIVE_NOISE_FACTOR(11) * noiseAmp (up
    // to 3.2) is an up-to-35x multiplier on the drift, and noiseAmp staying
    // elevated across several correlated ticks (it's mean-reverting, not
    // independent per tick) is what compounds into a near-vertical multi-candle
    // move. Capping the noiseAmp this term sees (not the shared noiseAmp state
    // itself, which baseNoiseContribution and updateStumble still use at full
    // range for their own legitimate texture) tames that tail directly, in every
    // phase equally, without touching the per-phase loudness ordering at all.
    const relativeNoiseContribution =
      RELATIVE_NOISE_FACTOR * Math.abs(driftPctPerTick) * gaussianish() * Math.min(noiseAmp, RELATIVE_NOISE_AMP_CAP);
    // Rare mean-zero single-tick stumble against the current direction — see
    // "Sub-candle texture" above; net zero across the two ticks it spans. Any
    // already-pending reversal takes priority; otherwise a targeted
    // streak-breaking flip gets first shot before falling back to the ambient one.
    let stumbleContribution: number;
    if (cs.stumblePending !== 0) {
      stumbleContribution = -cs.stumblePending;
      cs.stumblePending = 0;
    } else {
      stumbleContribution = maybeBreakColorStreak(cs, state);
      if (stumbleContribution === 0) stumbleContribution = updateStumble(cs, driftPctPerTick, baseVolPerMin);
    }
    // Long-horizon anchor pull (see gravity.ts) — computed after the relative
    // noise term so it isn't fed into that term's scaling, and kept fully
    // independent of the macro phase/mode machine above.
    const gravityContribution = gravityPctPerMin(cs) / 60;
    // Global news shock (see engine/news.ts) — same category-scaling factor as
    // macro drift, added straight into totalPct like gravity, never into
    // driftPctPerTick/relativeNoiseContribution (that term is calibrated
    // against ambient drift orders of magnitude smaller than a news ramp).
    const newsContribution = newsDriftContribution(state, cfg);
    const totalPct = driftPctPerTick + baseNoiseContribution + relativeNoiseContribution + stumbleContribution + gravityContribution + newsContribution;

    cs.lastTick = {
      macroDriftPct: macroDriftContribution,
      localDriftPct: localDriftContribution,
      baseNoisePct: baseNoiseContribution,
      relativeNoisePct: relativeNoiseContribution,
      stumblePct: stumbleContribution,
      gravityPct: gravityContribution,
      newsPct: newsContribution,
      totalPct,
    };

    const currentPrice = price(cs.pool);
    const targetPrice = Math.max(currentPrice * (1 + totalPct / 100), currentPrice * 1e-6);
    repriceTo(cs.pool, targetPrice);

    updateLiveliness(cs, now);
    updateCandle(cs, state);
    updateRecentHistory(cs, now);
  }

  advanceNewsEvent(state);

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
