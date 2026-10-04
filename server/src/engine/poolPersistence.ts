import { savePoolSnapshotWithClient } from '../db/queries.js';
import { COINS } from '../config/coins.js';
import { EngineState } from './state.js';
import { marketTransaction, withMarketState } from './marketRecovery.js';
import { saveValuationPrices } from '../db/rankValuation.js';

export function persistPoolSnapshots(state: EngineState): Promise<void> {
  return withMarketState(state, () => marketTransaction(state, async tx => {
    for (const cfg of COINS) {
      const pool = state.coins[cfg.id].pool;
      await savePoolSnapshotWithClient(tx, cfg.id, pool.coinReserve, pool.usddReserve, pool.referencePrice);
    }
    await saveValuationPrices(tx, state);
  }, () => {}));
}
