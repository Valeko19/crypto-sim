// Staking rewards distribution — runs on a plain setInterval from index.ts,
// same fire-and-forget convention as driftNpcBots/persistPoolSnapshots. This
// is the one background job in the project measured in real wall-clock time
// rather than game ticks, and it never touches state.coins[id].pool (no
// interaction with the AMM/pricing engine at all — only reads the live price
// to value a position's guaranteed-minimum share).
import { EngineState } from './state.js';
import { price } from './amm.js';
import { COIN_MAP } from '../config/coins.js';
import {
  STAKING_GUARANTEED_RATE_PER_MS, STAKING_DISTRIBUTION_INTERVAL_MS,
  STAKING_FLEXIBLE_MULTIPLIER, STAKING_LOCKED_MULTIPLIER,
} from '../config/staking.js';
import { getAllOpenStakingPositions, drainFeePool, addPendingRewards, StakingPositionRow } from '../db/queries.js';

// Locked-rate applies only while the lock is still active; an expired locked
// position that hasn't been withdrawn yet earns at the flexible rate instead —
// no incentive to "forget" to withdraw in order to keep the bonus forever.
function effectiveMultiplier(p: StakingPositionRow, nowMs: number): number {
  if (p.mode === 'locked' && p.lock_until && new Date(p.lock_until).getTime() > nowMs) {
    return STAKING_LOCKED_MULTIPLIER;
  }
  return STAKING_FLEXIBLE_MULTIPLIER;
}

export async function distributeStakingRewards(state: EngineState): Promise<void> {
  const positions = await getAllOpenStakingPositions();
  if (positions.length === 0) return;
  const now = Date.now();

  const byCoin = new Map<string, StakingPositionRow[]>();
  for (const p of positions) {
    const list = byCoin.get(p.coin_id);
    if (list) list.push(p);
    else byCoin.set(p.coin_id, [p]);
  }

  for (const [coinId, coinPositions] of byCoin) {
    const cfg = COIN_MAP[coinId];
    const cs = state.coins[coinId];
    if (!cfg || !cs) continue;

    const totalStaked = coinPositions.reduce((sum, p) => sum + p.amount, 0);
    if (totalStaked <= 0) continue; // nobody to pay — leave the fee pool accumulating untouched

    const pool = await drainFeePool(coinId);
    const currentPrice = price(cs.pool);

    for (const p of coinPositions) {
      // Guaranteed minimum: small, never-zero baseline scaled by this
      // position's USD value — paid even with zero trading activity.
      const guaranteed = p.amount * currentPrice * STAKING_GUARANTEED_RATE_PER_MS * STAKING_DISTRIBUTION_INTERVAL_MS;
      // Share of this coin's OWN accumulated trade-fee pool, proportional to
      // this position's share of the coin's total staked amount.
      const poolShare = (p.amount / totalStaked) * pool;
      const reward = (guaranteed + poolShare) * effectiveMultiplier(p, now);
      if (reward > 0) await addPendingRewards(p.id, reward);
    }
  }
}
