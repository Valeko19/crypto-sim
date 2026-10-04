import { db } from '../db/index.js';
import { saveValuationPrices, recordRankPeaks } from '../db/rankValuation.js';
import { marketTransaction, withMarketState } from './marketRecovery.js';
import type { EngineState } from './state.js';

// Caller owns market lock. Draft remains private until prices, pools and peaks
// commit together. A rollback publishes neither prices nor achievements;
// an uncertain outcome is reconciled from durable state under the same lock.
export async function commitMarketMutationLocked(state: EngineState, mutate: (draft: EngineState) => void) {
  const draft = structuredClone(state);
  mutate(draft);
  await marketTransaction(state, async tx => {
    await saveValuationPrices(tx, draft);
    await tx.query(`INSERT INTO coin_pools (coin_id, coin_reserve, usdd_reserve, reference_price)
      SELECT coin_id, coin_reserve, usdd_reserve, reference_price FROM jsonb_to_recordset($1::jsonb)
      AS p(coin_id text, coin_reserve double precision, usdd_reserve double precision, reference_price double precision)
      ON CONFLICT (coin_id) DO UPDATE SET coin_reserve=EXCLUDED.coin_reserve,
      usdd_reserve=EXCLUDED.usdd_reserve, reference_price=EXCLUDED.reference_price`,
    [JSON.stringify(Object.entries(draft.coins).map(([coin_id, cs]) => ({ coin_id,
      coin_reserve: cs.pool.coinReserve, usdd_reserve: cs.pool.usddReserve, reference_price: cs.pool.referencePrice ?? null })))]);
    await recordRankPeaks(tx);
  }, () => { Object.assign(state, draft); });
}

export function commitMarketMutation(state: EngineState, mutate: (draft: EngineState) => void) {
  return withMarketState(state, () => commitMarketMutationLocked(state, mutate));
}

// Balance-only mutations serialize with market publication through the DB:
// durable prices and money always change in complete transactions.
export async function creditBalance(playerId: string, amount: number): Promise<number> {
  return db.transaction(async tx => {
    const result = await tx.query<{ usdd_balance: number }>(
      'UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2 RETURNING usdd_balance', [amount, playerId]);
    await recordRankPeaks(tx, playerId);
    return result.rows[0]?.usdd_balance;
  });
}
