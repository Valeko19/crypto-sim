import { COINS, COIN_MAP, CoinConfig } from '../config/coins.js';
import { Pool, price } from './amm.js';
import { MacroPhase, MACRO_CONFIG } from './macroCycle.js';

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
  gravityPct: number;
  totalPct: number;
}

export interface CoinState {
  config: CoinConfig;
  pool: Pool;
  npcLockedAmount: number;
  minuteHistory: { t: number; p: number }[]; // ~1 sample/min, up to 24h, for 24h change
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
  macroModeEndTick: number;
  macroModeDriftPctPerMin: number; // current mode's rate (resampled every tick while choppy)
  macroChoppyAmplitudePctPerMin: number; // reference amplitude while macroMode === 'choppy'
  fearGreedIndex: number;
  coins: Record<string, CoinState>;
}

const CANDLE_INTERVAL_MS = 5_000;
const MAX_CANDLES = 600; // 50 min of 5s candles
const MAX_MINUTE_SAMPLES = 1440; // 24h

export function createInitialState(): EngineState {
  const coins: Record<string, CoinState> = {};
  for (const cfg of COINS) {
    const coinReserve = cfg.emission * (1 - cfg.npcLockedPct);
    const usddReserve = coinReserve * cfg.startPrice;
    coins[cfg.id] = {
      config: cfg,
      pool: { coinReserve, usddReserve },
      npcLockedAmount: cfg.emission * cfg.npcLockedPct,
      minuteHistory: [{ t: Date.now(), p: cfg.startPrice }],
      fiveMinHistory: [{ t: Date.now(), p: cfg.startPrice }],
      candles: [],
      currentCandle: null,
      livelinessMultiplier: 1,
      livelinessHalfLifeMs: 20 * 60_000,
      livelinessLastUpdateMs: Date.now(),
      localCycle: { phase: 'idle', phaseEndTick: 0, driftPctPerMin: 0, riseGainPct: 0 },
      lastTick: { macroDriftPct: 0, localDriftPct: 0, baseNoisePct: 0, relativeNoisePct: 0, gravityPct: 0, totalPct: 0 },
      projectLevel: cfg.startPrice,
      playerOwnedCoins: 0, // corrected at boot from real holdings (see index.ts)
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
    macroModeEndTick: 0,
    macroModeDriftPctPerMin: 0,
    macroChoppyAmplitudePctPerMin: 0,
    fearGreedIndex: MACRO_CONFIG.accumulation.fearGreedBase,
    coins,
  };
}

export { CANDLE_INTERVAL_MS, MAX_CANDLES, MAX_MINUTE_SAMPLES };

export function getPrice(state: EngineState, coinId: string): number {
  return price(state.coins[coinId].pool);
}

export function change24hPct(cs: CoinState): number {
  if (cs.minuteHistory.length === 0) return 0;
  const oldest = cs.minuteHistory[0];
  const current = price(cs.pool);
  return (current / oldest.p - 1) * 100;
}
