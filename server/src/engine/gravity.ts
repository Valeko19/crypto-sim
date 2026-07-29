import { CoinState } from './state.js';
import { price } from './amm.js';

// Long-horizon anchor: counteracts the fact that macro/local drift is a
// multiplicative random walk with no mean reversion, so its variance (and, for
// high-beta coins, even its mean) grows without bound over many cycles. This
// operates on a much slower timescale than a single phase and is fully
// independent of the macro mode machine / phase targets in tick.ts.
//
// The trick: a coin's price is only allowed to "deserve" staying far from its
// category anchor (`projectLevel`) to the extent that real player buying
// actually reduced its free float. `justifiedPrice` computes what the AMM
// price would be if ONLY real net player buying (`playerOwnedCoins`) had
// happened to an idealized pool starting at the anchor — using the exact same
// x*y=k relationship the rest of the engine uses. Gravity then pulls the
// ACTUAL price toward that justified price, not toward the anchor directly —
// so real player positions are never dragged back down, only unowned drift is.

const GRAVITY_BASE_RATE_PCT_PER_MIN = 0.4;
const GRAVITY_KNEE_LOG_GAP = Math.log(2); // where the super-linear term starts to bite
const GRAVITY_MAX_RATIO = 1000; // clamp so justifiedPrice can't blow up even near full float ownership
const GRAVITY_MAX_PCT_PER_MIN = 15; // hard ceiling on the pull itself — smooth pressure, never a single-tick shock

export function justifiedPrice(cs: CoinState): number {
  const freeFloat = cs.config.emission * (1 - cs.config.npcLockedPct);
  const owned = Math.min(Math.max(cs.playerOwnedCoins, 0), freeFloat * 0.999);
  const ratio = Math.min(freeFloat / (freeFloat - owned), GRAVITY_MAX_RATIO);
  return cs.projectLevel * ratio * ratio;
}

export function gravityPctPerMin(cs: CoinState): number {
  const jp = justifiedPrice(cs);
  const currentPrice = price(cs.pool);
  const logGap = Math.log(currentPrice / jp);
  const growth = 1 + Math.pow(Math.abs(logGap) / GRAVITY_KNEE_LOG_GAP, 2);
  // Scaled by the same macroCorrelation*beta factor tick.ts uses to amplify this
  // coin's macro-driven drift, so higher-beta alts/memes (which receive a
  // proportionally stronger injected signal) settle into a comparable
  // equilibrium excursion band instead of a wider one — without this, a
  // high-beta alt's normal excursion could occasionally exceed a momentarily
  // low top1 excursion even though both are individually "in range".
  const betaScale = cs.config.macroCorrelation * cs.config.beta;
  const effectiveBaseRate = GRAVITY_BASE_RATE_PCT_PER_MIN * betaScale;
  const raw = -effectiveBaseRate * logGap * growth;
  return Math.max(-GRAVITY_MAX_PCT_PER_MIN, Math.min(GRAVITY_MAX_PCT_PER_MIN, raw));
}

export { GRAVITY_BASE_RATE_PCT_PER_MIN, GRAVITY_KNEE_LOG_GAP };
