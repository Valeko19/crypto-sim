export type MacroPhase = 'accumulation' | 'early_bull' | 'bull' | 'euphoria' | 'bear';

// Fixed cyclical order (not a probability graph) per spec: accumulation -> early_bull
// -> bull -> euphoria -> bear -> back to accumulation. Durations are randomized within
// these configurable ranges each time a phase is entered; total cycle lands ~30-90 min
// (compressed from an original ~1-3 day design so the cycle is observable within a
// normal play session instead of only ever being reachable via the debug phase buttons).
export const MACRO_ORDER: MacroPhase[] = ['accumulation', 'early_bull', 'bull', 'euphoria', 'bear'];

export interface MacroPhaseConfig {
  minDurationMin: number;
  maxDurationMin: number;
  // Target multiplier for BTCR's OWN price over the FULL phase (e.g. bear 0.2-0.5
  // means it ends the phase at 20-50% of where it started, i.e. down 50-80%). The
  // per-tick drift is derived from this AND the actual drawn duration at phase-entry
  // time, so the total move lands in this range on ANY duration/speed — a fixed
  // %/min rate can't guarantee that, since a longer phase (or a slower target game
  // speed with hours-long phases) would compound a fixed rate into an arbitrarily
  // deeper move instead of the same capped range.
  totalMoveRange: [number, number];
  volMultiplier: number;
  fearGreedBase: number; // 0-100
  label: string; // Russian display label used by the debug phase buttons
  // Probability that a newly-triggered local mini-cycle (alts/memes) picks the
  // "rise" direction rather than a "dump" — without this, local cycles fire in
  // a random direction regardless of the prevailing phase, so plenty of coins
  // pump their way through a "bear" market purely by coin flip.
  localCycleUpBias: number;
}

// accumulation stays a flat consolidation by design. bull/bear targets come
// straight from the game's own spec: leader ÷2-÷5 over a bear phase, ×2-×5 over
// a bull phase, on ANY phase duration — alts/memes then amplify further via beta.
// The organic, noisy path to that target (false moves, reversal candles) comes
// from the separate relative-noise term in tick.ts, not from this drift range.
export const MACRO_CONFIG: Record<MacroPhase, MacroPhaseConfig> = {
  accumulation: { minDurationMin: 12, maxDurationMin: 32, totalMoveRange: [0.9, 1.15], volMultiplier: 1.0, fearGreedBase: 32, label: 'Зима', localCycleUpBias: 0.5 },
  early_bull: { minDurationMin: 8, maxDurationMin: 20, totalMoveRange: [1.15, 1.6], volMultiplier: 1.1, fearGreedBase: 55, label: 'Восстановление', localCycleUpBias: 0.62 },
  bull: { minDurationMin: 10, maxDurationMin: 24, totalMoveRange: [2, 5], volMultiplier: 1.3, fearGreedBase: 68, label: 'Бычий', localCycleUpBias: 0.72 },
  euphoria: { minDurationMin: 2, maxDurationMin: 8, totalMoveRange: [1.3, 2], volMultiplier: 1.8, fearGreedBase: 88, label: 'Распределение', localCycleUpBias: 0.78 },
  bear: { minDurationMin: 8, maxDurationMin: 24, totalMoveRange: [0.2, 0.5], volMultiplier: 1.5, fearGreedBase: 18, label: 'Медвежий', localCycleUpBias: 0.25 },
};

export function nextPhase(current: MacroPhase): MacroPhase {
  const idx = MACRO_ORDER.indexOf(current);
  return MACRO_ORDER[(idx + 1) % MACRO_ORDER.length];
}

export function fearGreedLabel(index: number): string {
  if (index < 20) return 'Крайний страх';
  if (index < 40) return 'Страх';
  if (index < 60) return 'Нейтрально';
  if (index < 80) return 'Жадность';
  return 'Крайняя жадность';
}
