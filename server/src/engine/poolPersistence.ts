import { db } from '../db/index.js';
import { savePoolSnapshotWithClient } from '../db/queries.js';
import { COINS } from '../config/coins.js';
import { EngineState } from './state.js';
import { withMarketLock } from './marketLock.js';

export function persistPoolSnapshots(state: EngineState): Promise<void> {
  return withMarketLock(() => db.transaction(async tx => {
    for (const cfg of COINS) {
      const pool = state.coins[cfg.id].pool;
      await savePoolSnapshotWithClient(tx, cfg.id, pool.coinReserve, pool.usddReserve, pool.referencePrice);
    }
  }));
}
