import { EngineState, CoinState } from './state.js';
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
//
// ownedRatio (below) alone only ever protects the UPSIDE: it defends a coin
// that's been genuinely bought up, but doesn't notice a player repeatedly
// buying low and selling high on the SAME coin, extracting real net profit
// each cycle, if nothing organically buys it back afterward — ownedRatio
// returns to 1 the moment they're fully back out, "forgetting" the extraction
// ever happened, so the loop could repeat forever at the same level.
// extractedRatio is the symmetric downside counterpart: it tracks accumulated
// net USDD pulled out without organic replacement (netExtracted, settled
// periodically — see updateNetExtracted below) and pulls justifiedPrice DOWN
// by it, with the same squared convexity ownedRatio uses for the upside.
// Unlike ownedRatio's freeFloat, extractedRatio's scale (liquidityScale) is
// each coin's own starting pool depth in USDD, not a per-tick state value —
// fixed forever once computed from that coin's (immutable) config.

const GRAVITY_BASE_RATE_PCT_PER_MIN = 0.4;
const GRAVITY_KNEE_LOG_GAP = Math.log(2); // where the super-linear term starts to bite
const GRAVITY_MAX_RATIO = 1000; // clamp so justifiedPrice can't blow up even near full float ownership
const GRAVITY_MAX_PCT_PER_MIN = 15; // hard ceiling on the pull itself — smooth pressure, never a single-tick shock

// Multiplies each coin's OWN initial pool USDD depth (freeFloat * startPrice)
// to get its liquidityScale — the denominator scale extractedRatio is judged
// against. 1.0 means a net outflow equal to the coin's entire starting pool
// depth roughly halves extractedRatio (the same halving-point shape
// ownedRatio has at owned = freeFloat/2). Tune here, not per-coin.
const LIQUIDITY_SCALE_MULTIPLIER = 1;

export function justifiedPrice(cs: CoinState): number {
  const freeFloat = cs.config.emission * (1 - cs.config.npcLockedPct);
  const owned = Math.min(Math.max(cs.playerOwnedCoins, 0), freeFloat * 0.999);
  const ownedRatio = Math.min(freeFloat / (freeFloat - owned), GRAVITY_MAX_RATIO);

  const liquidityScale = freeFloat * cs.config.startPrice * LIQUIDITY_SCALE_MULTIPLIER;
  const netExtracted = Math.max(cs.netExtracted, 0);
  const extractedRatio = liquidityScale / (liquidityScale + netExtracted);

  return cs.projectLevel * ownedRatio * ownedRatio * extractedRatio * extractedRatio;
}

// Periodic settlement of each coin's pendingNetFlowUsdd (accumulated live,
// per-trade, in engine/trade.ts) into its persistent netExtracted counter —
// called on a plain setInterval from index.ts, same fire-and-forget
// convention as persistPoolSnapshots/distributeStakingRewards. A period of
// net selling (negative flow) grows netExtracted; a period of net buying
// (positive flow — organic capital returning) shrinks it back down, floored
// at 0 so it can never end up "helping" the price. Balanced two-way trading
// within a period nets close to zero either way, so this doesn't fire on
// ordinary trading at all.
export function updateNetExtracted(state: EngineState): void {
  for (const cs of Object.values(state.coins)) {
    const netFlow = cs.pendingNetFlowUsdd;
    if (netFlow < 0) {
      cs.netExtracted += -netFlow;
    } else if (netFlow > 0) {
      cs.netExtracted = Math.max(0, cs.netExtracted - netFlow);
    }
    cs.pendingNetFlowUsdd = 0;
  }
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
