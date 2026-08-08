import type { EngineState } from './state.js';
import type { CoinConfig } from '../config/coins.js';
import { logReturnToDriftPctPerMin } from './driftMath.js';
import {
  NewsDirection, NewsStrength,
  NEWS_MIN_INTERVAL_MS, NEWS_MAX_INTERVAL_MS, NEWS_BANNER_DURATION_MS,
  NEWS_RAMP_TICKS_RANGE, NEWS_STRENGTH_WEIGHTS, NEWS_EFFECT_RANGE, NEWS_HEADLINES,
} from '../config/news.js';

export interface ActiveNewsEvent {
  headline: string;
  direction: NewsDirection;
  ratePctPerMin: number; // constant rate for the whole ramp
  remainingTicks: number;
}

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pickStrength(): NewsStrength {
  const entries = Object.entries(NEWS_STRENGTH_WEIGHTS) as [NewsStrength, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = Math.random() * total;
  for (const [strength, weight] of entries) {
    if (r < weight) return strength;
    r -= weight;
  }
  return entries[entries.length - 1][0];
}

// Draws without replacement from a shuffled copy of the full list for this
// direction+strength, reshuffling fresh once exhausted — so a headline can't
// repeat until every other one in its own list has shown.
function drawHeadline(state: EngineState, direction: NewsDirection, strength: NewsStrength): string {
  const key = `${direction}_${strength}`;
  let deck = state.newsDecks[key];
  if (!deck || deck.length === 0) {
    deck = [...NEWS_HEADLINES[direction][strength]];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
  }
  const headline = deck.pop()!;
  state.newsDecks[key] = deck;
  return headline;
}

export function triggerNewsEvent(
  state: EngineState,
  opts?: { direction?: NewsDirection; strength?: NewsStrength }
): ActiveNewsEvent {
  const direction: NewsDirection = opts?.direction ?? (Math.random() < 0.5 ? 'positive' : 'negative');
  const strength: NewsStrength = opts?.strength ?? pickStrength();
  const headline = drawHeadline(state, direction, strength);

  const [lo, hi] = NEWS_EFFECT_RANGE[direction][strength];
  const targetPct = randRange(lo, hi);
  const durationTicks = Math.round(randRange(NEWS_RAMP_TICKS_RANGE[0], NEWS_RAMP_TICKS_RANGE[1]));
  // Same log-return -> %/min conversion the macro-cycle homing correction
  // already uses, so the compounded per-tick moves land on the intended total
  // percentage instead of drifting from naive linear division.
  const logReturn = Math.log(1 + targetPct / 100);
  const ratePctPerMin = logReturnToDriftPctPerMin(logReturn, durationTicks);

  const event: ActiveNewsEvent = { headline, direction, ratePctPerMin, remainingTicks: durationTicks };
  state.activeNewsEvent = event;
  state.activeNewsBanner = { headline, direction, expiresAt: Date.now() + NEWS_BANNER_DURATION_MS };
  state.nextNewsEventAt = Date.now() + randRange(NEWS_MIN_INTERVAL_MS, NEWS_MAX_INTERVAL_MS);
  return event;
}

export function maybeTriggerNews(state: EngineState): void {
  if (Date.now() < state.nextNewsEventAt) return;
  triggerNewsEvent(state);
}

// Called once PER COIN inside tick.ts's existing per-coin loop — mirrors
// exactly how macroDriftContribution scales by cfg.macroCorrelation*cfg.beta
// for every coin except the reference (btcr).
export function newsDriftContribution(state: EngineState, cfg: CoinConfig): number {
  const ev = state.activeNewsEvent;
  if (!ev || ev.remainingTicks <= 0) return 0;
  const perTick = ev.ratePctPerMin / 60;
  return cfg.id === 'btcr' ? perTick : cfg.macroCorrelation * cfg.beta * perTick;
}

// Called once PER TICK (not per coin), after the per-coin loop.
export function advanceNewsEvent(state: EngineState): void {
  if (state.activeNewsEvent) {
    state.activeNewsEvent.remainingTicks--;
    if (state.activeNewsEvent.remainingTicks <= 0) state.activeNewsEvent = null;
  }
  if (state.activeNewsBanner && state.activeNewsBanner.expiresAt <= Date.now()) {
    state.activeNewsBanner = null;
  }
}
