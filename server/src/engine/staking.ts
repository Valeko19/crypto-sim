// Staking rewards distribution — runs on a plain setInterval from index.ts,
// same fire-and-forget convention as driftNpcBots/persistPoolSnapshots. Fixed
// APR (see config/staking.ts), same for every coin regardless of trading
// volume/category. No interaction with the AMM/pricing engine at all — the
// USD value used for accrual is fixed at stake time (position.stake_price),
// not the coin's current price, so this can't be inflated by moving the
// coin's price on the AMM after staking.
import { EngineState } from './state.js';
import { STAKING_DISTRIBUTION_INTERVAL_MS } from '../config/staking.js';
import { getAllOpenStakingPositions, addPendingRewards, effectiveApr } from '../db/queries.js';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export async function distributeStakingRewards(state: EngineState): Promise<void> {
  const positions = await getAllOpenStakingPositions();
  const now = Date.now();
  for (const p of positions) {
    const apr = effectiveApr(p, now);
    const reward = p.amount * p.stake_price * (apr / YEAR_MS) * STAKING_DISTRIBUTION_INTERVAL_MS;
    if (reward > 0) await addPendingRewards(p.id, reward);
  }
}
