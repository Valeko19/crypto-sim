import { createHash, randomUUID } from 'node:crypto';
import type { PGliteInterface } from '@electric-sql/pglite';
import { STARTING_USDD } from '../config/player.js';
import { createInitialState } from '../engine/state.js';
import { price } from '../engine/amm.js';
import { holdingsUpperBound, remainingSupply } from '../engine/supply.js';

export const CLEARED_TABLES = [
  'player_holdings', 'quest_progress', 'player_daily_volume', 'player_rank_progress',
  'player_earned_totals', 'staking_positions', 'trading_bots', 'trade_requests',
  'trade_log', 'auth_sessions',
] as const;
type Client = Pick<PGliteInterface, 'query'>;
export interface ResetReceipt { epoch: string; previousEpoch: string; identitiesHash: string; players: number; }
const marker = (operationId: string) => `full_game_reset:${operationId}`;
function identityHash(rows: unknown[]) { return createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
async function identities(client: Client) {
  return (await client.query('SELECT id, username, created_at FROM players ORDER BY id COLLATE "C"')).rows;
}
async function exists(client: Client, table: string) {
  return (await client.query<{name: string | null}>('SELECT to_regclass($1)::text AS name', [table])).rows[0].name !== null;
}
export async function inspectReset(client: Client) {
  const players = await identities(client);
  const counts: Record<string, number> = {};
  for (const table of [...CLEARED_TABLES, 'coin_pools', 'market_valuation_prices', 'market_commit']) {
    counts[table] = await exists(client, table) ? Number((await client.query<{count:string}>(`SELECT count(*) FROM ${table}`)).rows[0].count) : 0;
  }
  const epoch = await exists(client, 'game_epoch')
    ? (await client.query<{epoch:string}>('SELECT epoch FROM game_epoch WHERE singleton=TRUE')).rows[0]?.epoch : '0';
  if (!epoch) throw new Error('Missing current epoch');
  const balances = (await client.query<{usdd_balance:number}>('SELECT usdd_balance FROM players')).rows;
  const holdings = (await client.query<{coin_id:string;amount:number}>('SELECT coin_id,amount FROM player_holdings')).rows;
  const pools = (await client.query<{coin_id:string;coin_reserve:number;usdd_reserve:number}>('SELECT * FROM coin_pools')).rows;
  const invalidHoldings = holdings.filter(h => !Number.isFinite(h.amount) || h.amount < 0).length;
  const supplyViolations: string[] = [];
  for (const [id, coin] of Object.entries(createInitialState().coins)) {
    const amounts = holdings.filter(h => h.coin_id === id).map(h => h.amount);
    if (amounts.some(a => !Number.isFinite(a) || a < 0)) { supplyViolations.push(id); continue; }
    const owned = holdingsUpperBound(amounts), available = coin.config.emission * (1 - coin.config.npcLockedPct);
    if (owned > available || pools.some(p => p.coin_id === id && p.coin_reserve > remainingSupply(available, owned))) supplyViolations.push(id);
  }
  return { players: players.length, devPlayers: players.filter((p:any) => p.id.startsWith('dev_')).length,
    identitiesHash: identityHash(players), epoch, counts, startingBalance: STARTING_USDD,
    currentInvariants: {
      invalidBalances: balances.filter(p => !Number.isFinite(p.usdd_balance) || p.usdd_balance < 0).length,
      invalidHoldings, supplyViolations,
      invalidPools: pools.filter(p => ![p.coin_reserve,p.usdd_reserve].every(n=>Number.isFinite(n)&&n>=0)).length,
    },
    market: initialPools() };
}
function initialPools() {
  return Object.entries(createInitialState().coins).map(([coinId, cs]) => ({ coinId,
    coinReserve: cs.pool.coinReserve, usddReserve: cs.pool.usddReserve,
    referencePrice: cs.config.startPrice, valuation: price(cs.pool) }));
}
export async function readResetReceipt(client: Client, operationId: string): Promise<ResetReceipt | null> {
  const result = await client.query<{details?: ResetReceipt}>(
    'SELECT to_jsonb(r)->\'details\' AS details FROM admin_reset_log r WHERE id=$1', [marker(operationId)]);
  return result.rows[0]?.details ?? null;
}
export async function verifyFullReset(client: Client, receipt: ResetReceipt) {
  const current = await inspectReset(client);
  if (current.players !== receipt.players || current.identitiesHash !== receipt.identitiesHash) throw Error('Reset verification: identity changed');
  if (current.epoch !== receipt.epoch) throw Error('Reset verification: epoch mismatch');
  if (current.currentInvariants.supplyViolations.length) throw Error('Reset verification: supply exceeded');
  for (const table of CLEARED_TABLES) if (current.counts[table] !== 0) throw Error(`Reset verification: ${table} not empty`);
  const bad = await client.query(`SELECT id FROM players WHERE usdd_balance IS DISTINCT FROM $1
    OR trades_count IS DISTINCT FROM 0 OR total_volume IS DISTINCT FROM 0
    OR realized_pnl IS DISTINCT FROM 0 OR total_fees_paid IS DISTINCT FROM 0`, [STARTING_USDD]);
  if (bad.rows.length) throw Error('Reset verification: player finance not clean');
  const pools = await client.query<{coin_id:string; coin_reserve:number; usdd_reserve:number; reference_price:number}>('SELECT * FROM coin_pools');
  const valuations = await client.query<{coin_id:string; price:number}>('SELECT * FROM market_valuation_prices');
  const expected = initialPools();
  if (pools.rows.length !== expected.length || valuations.rows.length !== expected.length) throw Error('Reset verification: market cardinality');
  for (const p of expected) {
    const row = pools.rows.find(r=>r.coin_id===p.coinId), v = valuations.rows.find(r=>r.coin_id===p.coinId);
    if (!row || !v || row.coin_reserve !== p.coinReserve || row.usdd_reserve !== p.usddReserve
      || row.reference_price !== p.referencePrice || v.price !== p.valuation
      || ![row.coin_reserve,row.usdd_reserve,v.price].every(n=>Number.isFinite(n)&&n>0)) throw Error(`Reset verification: pool ${p.coinId}`);
  }
  const commits = await client.query<{revision:string}>('SELECT revision FROM market_commit');
  if (commits.rows.length!==1 || commits.rows[0].revision!==`reset:${receipt.epoch}`) throw Error('Reset verification: market receipt');
  return current;
}

// Offline operation: deliberately independent of live engine/market recovery.
// The CLI owns the only DB instance. All calls here must use that same instance.
export async function applyFullReset(db: PGliteInterface, operationId: string, epoch = randomUUID()) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(operationId)) throw Error('Invalid reset operation ID');
  const prior = await readResetReceipt(db, operationId);
  if (prior) { await verifyFullReset(db, prior); return { receipt: prior, alreadyCommitted: true }; }
  const before = await inspectReset(db);
  if (epoch === before.epoch || !epoch) throw Error('Reset requires a new epoch');
  const receipt: ResetReceipt = { epoch, previousEpoch: before.epoch, players: before.players, identitiesHash: before.identitiesHash };
  try {
    await db.transaction(async tx => {
      await tx.query(`UPDATE players SET usdd_balance=$1, trades_count=0, total_volume=0, realized_pnl=0, total_fees_paid=0`, [STARTING_USDD]);
      for (const table of CLEARED_TABLES) await tx.query(`DELETE FROM ${table}`);
      await tx.query('DELETE FROM coin_pools');
      await tx.query('DELETE FROM market_valuation_prices');
      await tx.query('DELETE FROM market_commit');
      for (const p of initialPools()) {
        await tx.query('INSERT INTO coin_pools(coin_id,coin_reserve,usdd_reserve,reference_price) VALUES($1,$2,$3,$4)', [p.coinId,p.coinReserve,p.usddReserve,p.referencePrice]);
        await tx.query('INSERT INTO market_valuation_prices(coin_id,price) VALUES($1,$2)', [p.coinId,p.valuation]);
      }
      await tx.query('CREATE TABLE IF NOT EXISTS game_epoch (singleton BOOLEAN PRIMARY KEY CHECK(singleton), epoch TEXT NOT NULL)');
      await tx.query('INSERT INTO game_epoch VALUES(TRUE,$1) ON CONFLICT(singleton) DO UPDATE SET epoch=EXCLUDED.epoch', [epoch]);
      await tx.query('INSERT INTO market_commit(singleton,revision) VALUES(TRUE,$1)', [`reset:${epoch}`]);
      await tx.query('ALTER TABLE admin_reset_log ADD COLUMN IF NOT EXISTS details JSONB');
      await tx.query('INSERT INTO admin_reset_log(id,details) VALUES($1,$2)', [marker(operationId),JSON.stringify(receipt)]);
      await verifyFullReset(tx, receipt);
    });
  } catch (error) {
    // Query the durable marker, never infer rollback from a rejected Promise.
    // If this connection is unusable, the CLI closes/reopens and repeats ONLY
    // this read. It never repeats the destructive transaction automatically.
    const committed = await readResetReceipt(db, operationId);
    if (!committed) throw error;
    await verifyFullReset(db, committed);
    return { receipt: committed, alreadyCommitted: true };
  }
  await verifyFullReset(db, receipt);
  return { receipt, alreadyCommitted: false };
}
