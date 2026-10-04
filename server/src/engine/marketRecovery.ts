import { randomUUID } from 'node:crypto';
import type { Transaction } from '@electric-sql/pglite';
import { db } from '../db/index.js';
import { COINS } from '../config/coins.js';
import { price, type Pool } from './amm.js';
import { holdingsUpperBound, remainingSupply } from './supply.js';
import { withMarketLock } from './marketLock.js';
import type { EngineState } from './state.js';

export class MarketUnavailableError extends Error {
  readonly status = 503;
  constructor(message = 'Market recovery required; retry later with the same requestId') { super(message); }
}

interface PendingCommit { revision: string; publish?: () => void; committed?: boolean }
const recovering = new WeakMap<EngineState, PendingCommit>();
const initialized = new WeakSet<EngineState>();

// Caller holds market lock. Read-only reconciliation: never repair durable
// pools from live memory. Validate a complete snapshot before publishing any.
export async function recoverMarketLocked(state: EngineState): Promise<void> {
  const pending = recovering.get(state);
  if (!pending) return;
  try {
    const recovered = await db.transaction(async tx => {
      const pools = await tx.query<{ coin_id: string; coin_reserve: number; usdd_reserve: number; reference_price: number | null; valuation: number }>(
        'SELECT p.*, v.price AS valuation FROM coin_pools p JOIN market_valuation_prices v USING (coin_id)');
      const holdings = await tx.query<{ coin_id: string; amount: number }>('SELECT coin_id, amount FROM player_holdings');
      const receipt = await tx.query<{ revision: string }>('SELECT revision FROM market_commit WHERE singleton = TRUE');
      const result = COINS.map(cfg => {
        const row = pools.rows.find(p => p.coin_id === cfg.id);
        if (!row) throw new Error('missing durable pool');
        const pool: Pool = { coinReserve: row.coin_reserve, usddReserve: row.usdd_reserve,
          ...(row.reference_price == null ? {} : { referencePrice: row.reference_price }) };
        const owned = holdingsUpperBound(holdings.rows.filter(h => h.coin_id === cfg.id).map(h => h.amount));
        if (![pool.coinReserve, pool.usddReserve].every(n => Number.isFinite(n) && n >= 0)
          || ((pool.coinReserve === 0) !== (pool.usddReserve === 0))
          || !Number.isFinite(price(pool)) || price(pool) <= 0 || price(pool) !== row.valuation
          || pool.coinReserve > remainingSupply(cfg.emission * (1 - cfg.npcLockedPct), owned)) {
          throw new Error('invalid durable market snapshot');
        }
        return { coinId: cfg.id, pool, owned };
      });
      return { result, committed: receipt.rows[0]?.revision === pending.revision };
    });
    // A durable receipt proves that this exact candidate committed. Preserve
    // its tick metadata once, but pools always come from DB. Daily turnover
    // was settled in that transaction already; publication never increments it.
    pending.committed = recovered.committed;
    if (recovered.committed) { pending.publish?.(); pending.publish = undefined; }
    for (const item of recovered.result) {
      state.coins[item.coinId].pool = item.pool;
      state.coins[item.coinId].playerOwnedCoins = item.owned;
    }
    recovering.delete(state);
    initialized.add(state);
  } catch {
    // Keep the gate closed. A later operation retries this read-only recovery
    // under the same FIFO lock, before executing any of its own work.
    throw new MarketUnavailableError();
  }
}

export function withMarketState<T>(state: EngineState, work: () => Promise<T> | T): Promise<T> {
  return withMarketLock(async () => { await recoverMarketLocked(state); return work(); });
}

export function ensureMarketReady(state: EngineState): Promise<void> {
  return recovering.has(state) ? withMarketState(state, () => {}) : Promise.resolve();
}

// Caller holds market lock. Promise rejection alone is NOT evidence of rollback.
export async function marketTransaction<T>(state: EngineState, work: (tx: Transaction) => Promise<T>, publish: (value: T) => void): Promise<T> {
  await recoverMarketLocked(state);
  const pending: PendingCommit = { revision: randomUUID() };
  try {
    const result = await db.transaction(async tx => {
      const value = await work(tx);
      pending.publish = () => publish(value);
      if (!initialized.has(state)) {
        // Materialize untouched genesis pools as part of the first SUCCESSFUL
        // market transaction. Never overwrite an existing durable pool here.
        await tx.query(`INSERT INTO coin_pools (coin_id, coin_reserve, usdd_reserve, reference_price)
          SELECT coin_id, coin_reserve, usdd_reserve, reference_price FROM jsonb_to_recordset($1::jsonb)
          AS p(coin_id text, coin_reserve double precision, usdd_reserve double precision, reference_price double precision)
          ON CONFLICT (coin_id) DO NOTHING`, [JSON.stringify(COINS.map(cfg => ({
            coin_id: cfg.id, coin_reserve: state.coins[cfg.id].pool.coinReserve,
            usdd_reserve: state.coins[cfg.id].pool.usddReserve,
            reference_price: state.coins[cfg.id].pool.referencePrice ?? null,
          })))]);
      }
      await tx.query(`INSERT INTO market_commit (singleton, revision) VALUES (TRUE, $1)
        ON CONFLICT (singleton) DO UPDATE SET revision = EXCLUDED.revision`, [pending.revision]);
      return value;
    });
    publish(result);
    initialized.add(state);
    return result;
  } catch (error) {
    recovering.set(state, pending);
    await recoverMarketLocked(state);
    if (pending.committed) throw new MarketUnavailableError('Operation committed and market recovered; retry with the same requestId');
    // Keep the original failure visible. Replay with the same requestId reads
    // the durable result; a rolled-back request has no reservation to replay.
    throw error;
  }
}
