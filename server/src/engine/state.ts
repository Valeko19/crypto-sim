import { COINS, COIN_MAP, CoinConfig } from '../config/coins.js';
import { Pool, price } from './amm.js';
import { MacroPhase, MACRO_CONFIG } from './macroCycle.js';
import { NewsDirection, NEWS_MIN_INTERVAL_MS, NEWS_MAX_INTERVAL_MS } from '../config/news.js';
import type { ActiveNewsEvent } from './news.js';

export interface Candle {
  t: number; // start time ms
  o: number; h: number; l: number; c: number;
}

export type LocalCyclePhase = 'idle' | 'rising' | 'pullback';

export interface LocalCycleState {
  phase: LocalCyclePhase;
  phaseEndTick: number;
  driftPctPerMin: number; // active drift while rising/pullback
  riseGainPct: number; // remembers the rise size so pullback can retrace a portion of it
}

// Per-tick component breakdown, kept only for the most recent tick — a diagnostic
// so the actual contribution of each force (macro drift, local cycle, base noise,
// relative noise) can be inspected directly instead of inferred from the chart.
export interface TickBreakdown {
  macroDriftPct: number;
  localDriftPct: number;
  baseNoisePct: number;
  relativeNoisePct: number;
  stumblePct: number;
  gravityPct: number;
  newsPct: number;
  totalPct: number;
}

export interface CoinState {
  config: CoinConfig;
  pool: Pool;
  npcLockedAmount: number;
  recentHistory: { t: number; p: number }[]; // dense samples, trimmed to RECENT_CHANGE_WINDOW_MS, for the displayed change %
  fiveMinHistory: { t: number; p: number }[]; // dense samples, trimmed to 5 min, for liveliness trigger
  candles: Candle[];
  currentCandle: Candle | null;
  livelinessMultiplier: number;
  livelinessHalfLifeMs: number;
  livelinessLastUpdateMs: number;
  localCycle: LocalCycleState;
  lastTick: TickBreakdown;
  // Long-horizon anchor (see gravity.ts): a category-appropriate reference price
  // set once at init, and the net amount of this coin real players have actually
  // bought (minus sold) via real trades — tracked separately from the pool's
  // reserves because those also move from background drift, not just real buys.
  projectLevel: number;
  playerOwnedCoins: number;
  // Sub-candle texture (see tick.ts): a bounded, mean-reverting multiplier on
  // the noise terms so amplitude itself clusters (calm patches vs. bursty
  // patches) instead of every tick drawing from the same fixed-width
  // distribution, plus a pending single-tick counter-impulse that gets exactly
  // cancelled the following tick (see `stumblePending`) so it can never bias
  // the phase's calibrated target — only ever shows up as a wick or, rarely, a
  // single off-color candle.
  noiseAmpState: number;
  stumblePending: number;
  // Tracks consecutive closed candles of the same color, so bear-phase streak
  // breaking (see tick.ts) can escalate specifically once a real streak has
  // built up, rather than firing at a flat rate regardless of context.
  lastCandleColor: 'red' | 'green' | null;
  sameColorStreak: number;
}

// The macro drift source lives tick-to-tick as a small state machine (see
// tick.ts `updateMacroMode`) instead of a pre-planned schedule: most of the
// phase is spent in 'trend' (drift matching the phase's overall direction),
// interrupted by occasional 'counter' (temporary against-trend move, sized to
// plausibly read as a reversal) and 'choppy' (high-amplitude, no-direction
// chop) interludes. Only in the final stretch of the phase does a "homing"
// pull blend in, correcting toward the phase's target move — so the path is
// genuinely unplanned/unpredictable, but the destination is still guaranteed.
export type MacroMode = 'trend' | 'counter' | 'choppy';

export interface EngineState {
  tickCount: number;
  engineStartMs: number; // candle timestamps are derived from tickCount off this anchor,
  // so candle spacing stays exactly uniform even if a tick's wall-clock firing jitters.
  macroPhase: MacroPhase;
  macroPhaseStartTick: number;
  macroPhaseEndTick: number;
  macroPhaseDriftPctPerMin: number; // the LIVE blended drift for the current tick
  macroPhaseTargetLogReturn: number; // ln(target multiplier) — fixed for the whole phase
  macroPhaseStartPrice: number; // BTCR price when the phase began, for measuring progress toward the target
  macroMode: MacroMode;
  macroModeStartTick: number; // when the current mode segment began — used to gauge how long it's run
  macroModeEndTick: number;
  macroModeDriftPctPerMin: number; // current mode's rate (resampled every tick while choppy)
  macroChoppyAmplitudePctPerMin: number; // reference amplitude while macroMode === 'choppy'
  fearGreedIndex: number;
  coins: Record<string, CoinState>;
  // News events (see engine/news.ts) are the one other place besides staking
  // measured in real wall-clock time rather than ticks — but unlike staking,
  // they don't need DB persistence: TICK_MS is a fixed 1000ms with no speed
  // multiplier anywhere, so a Date.now() gate checked once per tick already
  // IS real-time, and a server restart just resetting the schedule is fine
  // (exactly like macroPhase/macroMode already reset on restart).
  nextNewsEventAt: number; // Date.now() epoch ms of the next eligible event
  activeNewsEvent: ActiveNewsEvent | null; // in-progress ramp (a handful of ticks)
  activeNewsBanner: { headline: string; direction: NewsDirection; expiresAt: number } | null;
  newsDecks: Record<string, string[]>; // no-repeat-until-exhausted headline decks, keyed `${direction}_${strength}`
}

// The 5s timeframe was dropped entirely (10s is now the finest grain shown
// anywhere) — no game logic (gravity, modes, quests, etc.) ever reads the
// candle arrays, only the chart does, so the base interval can just BE the
// smallest timeframe needed instead of storing 5s bars and aggregating them
// up even for the 10s view.
const CANDLE_INTERVAL_MS = 10_000;
const MAX_CANDLES = 3_000; // ~8.3h of 10s candles
const RECENT_CHANGE_WINDOW_MS = 4 * 60_000; // the displayed % change looks back this far

export function createInitialState(): EngineState {
  const coins: Record<string, CoinState> = {};
  for (const cfg of COINS) {
    const coinReserve = cfg.emission * (1 - cfg.npcLockedPct);
    const usddReserve = coinReserve * cfg.startPrice;
    coins[cfg.id] = {
      config: cfg,
      pool: { coinReserve, usddReserve },
      npcLockedAmount: cfg.emission * cfg.npcLockedPct,
      recentHistory: [{ t: Date.now(), p: cfg.startPrice }],
      fiveMinHistory: [{ t: Date.now(), p: cfg.startPrice }],
      candles: [],
      currentCandle: null,
      livelinessMultiplier: 1,
      livelinessHalfLifeMs: 20 * 60_000,
      livelinessLastUpdateMs: Date.now(),
      localCycle: { phase: 'idle', phaseEndTick: 0, driftPctPerMin: 0, riseGainPct: 0 },
      lastTick: { macroDriftPct: 0, localDriftPct: 0, baseNoisePct: 0, relativeNoisePct: 0, stumblePct: 0, gravityPct: 0, newsPct: 0, totalPct: 0 },
      projectLevel: cfg.startPrice,
      playerOwnedCoins: 0, // corrected at boot from real holdings (see index.ts)
      noiseAmpState: 1,
      stumblePending: 0,
      lastCandleColor: null,
      sameColorStreak: 0,
    };
  }
  return {
    tickCount: 0,
    engineStartMs: Date.now(),
    macroPhase: 'accumulation',
    macroPhaseStartTick: 0,
    macroPhaseEndTick: 0,
    macroPhaseDriftPctPerMin: 0,
    macroPhaseTargetLogReturn: 0,
    macroPhaseStartPrice: COIN_MAP.btcr.startPrice,
    macroMode: 'trend',
    macroModeStartTick: 0,
    macroModeEndTick: 0,
    macroModeDriftPctPerMin: 0,
    macroChoppyAmplitudePctPerMin: 0,
    fearGreedIndex: MACRO_CONFIG.accumulation.fearGreedBase,
    coins,
    nextNewsEventAt: Date.now() + NEWS_MIN_INTERVAL_MS + Math.random() * (NEWS_MAX_INTERVAL_MS - NEWS_MIN_INTERVAL_MS),
    activeNewsEvent: null,
    activeNewsBanner: null,
    newsDecks: {},
  };
}

export { CANDLE_INTERVAL_MS, MAX_CANDLES, RECENT_CHANGE_WINDOW_MS };

export function getPrice(state: EngineState, coinId: string): number {
  return price(state.coins[coinId].pool);
}

// The oldest surviving sample in recentHistory (kept trimmed to
// RECENT_CHANGE_WINDOW_MS by updateRecentHistory in tick.ts) approximates the
// price ~4 minutes ago, so this is the change over that rolling window.
export function recentChangePct(cs: CoinState): number {
  if (cs.recentHistory.length === 0) return 0;
  const oldest = cs.recentHistory[0];
  const current = price(cs.pool);
  return (current / oldest.p - 1) * 100;
}
