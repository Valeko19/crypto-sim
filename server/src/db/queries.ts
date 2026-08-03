import { randomUUID } from 'node:crypto';
import { db } from './index.js';
import { StakingMode } from '../config/staking.js';

export const LOCAL_PLAYER_ID = 'local_player';

export interface PlayerRow {
  id: string;
  username: string;
  usdd_balance: number;
  trades_count: number;
  total_volume: number;
  realized_pnl: number;
}

export interface HoldingRow {
  player_id: string;
  coin_id: string;
  amount: number;
  avg_buy_price: number;
}

export async function ensureLocalPlayer(): Promise<PlayerRow> {
  const existing = await db.query<PlayerRow>('SELECT * FROM players WHERE id = $1', [LOCAL_PLAYER_ID]);
  if (existing.rows.length > 0) return existing.rows[0];
  const STARTING_BONUS = 100;
  const inserted = await db.query<PlayerRow>(
    `INSERT INTO players (id, username, usdd_balance) VALUES ($1, $2, $3) RETURNING *`,
    [LOCAL_PLAYER_ID, '@local_player', STARTING_BONUS]
  );
  return inserted.rows[0];
}

export async function getPlayer(id: string): Promise<PlayerRow> {
  const res = await db.query<PlayerRow>('SELECT * FROM players WHERE id = $1', [id]);
  return res.rows[0];
}

export async function getHoldings(playerId: string): Promise<HoldingRow[]> {
  const res = await db.query<HoldingRow>('SELECT * FROM player_holdings WHERE player_id = $1', [playerId]);
  return res.rows;
}

export async function getHolding(playerId: string, coinId: string): Promise<HoldingRow | null> {
  const res = await db.query<HoldingRow>(
    'SELECT * FROM player_holdings WHERE player_id = $1 AND coin_id = $2',
    [playerId, coinId]
  );
  return res.rows[0] ?? null;
}

export async function applyBuy(
  playerId: string,
  coinId: string,
  coinAmount: number,
  usddSpent: number,
  execPrice: number
): Promise<void> {
  const existing = await getHolding(playerId, coinId);
  if (existing) {
    const newAmount = existing.amount + coinAmount;
    const newAvgPrice = (existing.amount * existing.avg_buy_price + coinAmount * execPrice) / newAmount;
    await db.query(
      'UPDATE player_holdings SET amount = $1, avg_buy_price = $2 WHERE player_id = $3 AND coin_id = $4',
      [newAmount, newAvgPrice, playerId, coinId]
    );
  } else {
    await db.query(
      'INSERT INTO player_holdings (player_id, coin_id, amount, avg_buy_price) VALUES ($1, $2, $3, $4)',
      [playerId, coinId, coinAmount, execPrice]
    );
  }
  await db.query(
    `UPDATE players SET usdd_balance = usdd_balance - $1, trades_count = trades_count + 1,
     total_volume = total_volume + $1 WHERE id = $2`,
    [usddSpent, playerId]
  );
}

export async function applySell(
  playerId: string,
  coinId: string,
  coinAmount: number,
  usddReceived: number,
  execPrice: number
): Promise<void> {
  const existing = await getHolding(playerId, coinId);
  if (!existing) throw new Error('No holding to sell');
  const realizedPnl = (execPrice - existing.avg_buy_price) * coinAmount;
  const remaining = existing.amount - coinAmount;
  if (remaining <= 1e-9) {
    await db.query('DELETE FROM player_holdings WHERE player_id = $1 AND coin_id = $2', [playerId, coinId]);
  } else {
    await db.query(
      'UPDATE player_holdings SET amount = $1 WHERE player_id = $2 AND coin_id = $3',
      [remaining, playerId, coinId]
    );
  }
  await db.query(
    `UPDATE players SET usdd_balance = usdd_balance + $1, trades_count = trades_count + 1,
     total_volume = total_volume + $1, realized_pnl = realized_pnl + $2 WHERE id = $3`,
    [usddReceived, realizedPnl, playerId]
  );
}

export interface QuestProgressRow {
  player_id: string;
  quest_type: string;
  coin_id: string;
  threshold: number;
  claimed_at: string | null;
}

export async function getQuestProgress(playerId: string): Promise<QuestProgressRow[]> {
  const res = await db.query<QuestProgressRow>('SELECT * FROM quest_progress WHERE player_id = $1', [playerId]);
  return res.rows;
}

export async function claimQuestRow(
  playerId: string,
  questType: string,
  coinId: string,
  threshold: number
): Promise<void> {
  await db.query(
    `INSERT INTO quest_progress (player_id, quest_type, coin_id, threshold, claimed_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (player_id, quest_type, coin_id, threshold)
     DO UPDATE SET claimed_at = now()`,
    [playerId, questType, coinId, threshold]
  );
}

export interface NpcBotRow {
  id: string;
  username: string;
  simulated_net_worth: number;
  league: string;
}

export async function listNpcBots(): Promise<NpcBotRow[]> {
  const res = await db.query<NpcBotRow>('SELECT * FROM npc_bots');
  return res.rows;
}

export async function countNpcBots(): Promise<number> {
  const res = await db.query<{ count: string }>('SELECT COUNT(*)::int as count FROM npc_bots');
  return Number(res.rows[0].count);
}

export async function insertNpcBot(bot: NpcBotRow): Promise<void> {
  await db.query(
    'INSERT INTO npc_bots (id, username, simulated_net_worth, league) VALUES ($1, $2, $3, $4)',
    [bot.id, bot.username, bot.simulated_net_worth, bot.league]
  );
}

export async function updateNpcBot(id: string, netWorth: number, league: string): Promise<void> {
  await db.query('UPDATE npc_bots SET simulated_net_worth = $1, league = $2 WHERE id = $3', [netWorth, league, id]);
}

export interface PoolSnapshotRow {
  coin_id: string;
  coin_reserve: number;
  usdd_reserve: number;
}

export async function getAllPoolSnapshots(): Promise<PoolSnapshotRow[]> {
  const res = await db.query<PoolSnapshotRow>('SELECT * FROM coin_pools');
  return res.rows;
}

export async function savePoolSnapshot(coinId: string, coinReserve: number, usddReserve: number): Promise<void> {
  await db.query(
    `INSERT INTO coin_pools (coin_id, coin_reserve, usdd_reserve) VALUES ($1, $2, $3)
     ON CONFLICT (coin_id) DO UPDATE SET coin_reserve = $2, usdd_reserve = $3`,
    [coinId, coinReserve, usddReserve]
  );
}

// Total held across ALL players for a coin — used to reconcile the pool reserve
// at boot so it can never re-issue supply that's already owned (see index.ts).
export async function getTotalHeldForCoin(coinId: string): Promise<number> {
  const res = await db.query<{ total: number }>(
    'SELECT COALESCE(SUM(amount), 0)::float as total FROM player_holdings WHERE coin_id = $1',
    [coinId]
  );
  return Number(res.rows[0].total);
}

export async function capHoldingAmount(playerId: string, coinId: string, newAmount: number): Promise<void> {
  await db.query(
    'UPDATE player_holdings SET amount = $1 WHERE player_id = $2 AND coin_id = $3',
    [newAmount, playerId, coinId]
  );
}

// --- Staking: per-coin fee pool ---------------------------------------------
// Fed by that coin's own trade fees (routes.ts /trade) instead of the fee just
// vanishing; drained periodically to that coin's stakers (engine/staking.ts).

export async function getFeePool(coinId: string): Promise<number> {
  const res = await db.query<{ pool_usdd: number }>('SELECT pool_usdd FROM coin_fee_pools WHERE coin_id = $1', [coinId]);
  return res.rows[0]?.pool_usdd ?? 0;
}

export async function addToFeePool(coinId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  await db.query(
    `INSERT INTO coin_fee_pools (coin_id, pool_usdd) VALUES ($1, $2)
     ON CONFLICT (coin_id) DO UPDATE SET pool_usdd = coin_fee_pools.pool_usdd + $2`,
    [coinId, amount]
  );
}

// Reads the current pool then zeroes it — safe without an explicit transaction
// since this whole codebase is a single Node process with no concurrent writers.
export async function drainFeePool(coinId: string): Promise<number> {
  const current = await getFeePool(coinId);
  if (current > 0) {
    await db.query('UPDATE coin_fee_pools SET pool_usdd = 0 WHERE coin_id = $1', [coinId]);
  }
  return current;
}

// --- Staking: positions ------------------------------------------------------
// Staking never moves coins out of player_holdings — a position only reserves
// part of the holding from being sold. All timestamps are real wall-clock time
// (see config/staking.ts), not game ticks.

export interface StakingPositionRow {
  id: string;
  player_id: string;
  coin_id: string;
  amount: number;
  mode: StakingMode;
  staked_at: string;
  lock_until: string | null;
  unstake_requested_at: string | null;
  unstake_available_at: string | null;
  pending_rewards: number;
}

// True while `p` still reserves its amount from being sold / still counts as
// "locked-rate eligible" — false once a lock has expired or a requested
// flexible unstake's cooldown has elapsed, even if the row hasn't been
// withdrawn (deleted) yet.
export function isPositionReserved(p: StakingPositionRow, nowMs: number): boolean {
  if (p.mode === 'locked') {
    return !p.lock_until || new Date(p.lock_until).getTime() > nowMs;
  }
  return !p.unstake_requested_at || !p.unstake_available_at || new Date(p.unstake_available_at).getTime() > nowMs;
}

export async function createStakingPosition(
  playerId: string,
  coinId: string,
  amount: number,
  mode: StakingMode,
  lockUntil: Date | null
): Promise<StakingPositionRow> {
  const id = randomUUID();
  const res = await db.query<StakingPositionRow>(
    `INSERT INTO staking_positions (id, player_id, coin_id, amount, mode, lock_until)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [id, playerId, coinId, amount, mode, lockUntil ? lockUntil.toISOString() : null]
  );
  return res.rows[0];
}

export async function getStakingPositions(playerId: string): Promise<StakingPositionRow[]> {
  const res = await db.query<StakingPositionRow>(
    'SELECT * FROM staking_positions WHERE player_id = $1 ORDER BY staked_at',
    [playerId]
  );
  return res.rows;
}

export async function getPositionById(positionId: string): Promise<StakingPositionRow | null> {
  const res = await db.query<StakingPositionRow>('SELECT * FROM staking_positions WHERE id = $1', [positionId]);
  return res.rows[0] ?? null;
}

// Every open position across every player/coin — used by the periodic rewards
// distribution job (engine/staking.ts), which needs the full picture to split
// each coin's fee pool proportionally among that coin's stakers.
export async function getAllOpenStakingPositions(): Promise<StakingPositionRow[]> {
  const res = await db.query<StakingPositionRow>('SELECT * FROM staking_positions');
  return res.rows;
}

export async function requestUnstakePosition(positionId: string, availableAt: Date): Promise<void> {
  await db.query(
    'UPDATE staking_positions SET unstake_requested_at = now(), unstake_available_at = $2 WHERE id = $1',
    [positionId, availableAt.toISOString()]
  );
}

export async function deleteStakingPosition(positionId: string): Promise<void> {
  await db.query('DELETE FROM staking_positions WHERE id = $1', [positionId]);
}

export async function addPendingRewards(positionId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  await db.query('UPDATE staking_positions SET pending_rewards = pending_rewards + $2 WHERE id = $1', [positionId, amount]);
}

// Sums and zeroes pending_rewards across every one of this player's positions
// in this coin — the route handler credits the returned total to usdd_balance,
// same two-step "claim row, then credit balance" shape as the daily-bonus claim.
export async function claimCoinRewards(playerId: string, coinId: string): Promise<number> {
  const res = await db.query<{ total: number }>(
    'SELECT COALESCE(SUM(pending_rewards), 0)::float as total FROM staking_positions WHERE player_id = $1 AND coin_id = $2',
    [playerId, coinId]
  );
  const total = Number(res.rows[0].total);
  if (total > 0) {
    await db.query(
      'UPDATE staking_positions SET pending_rewards = 0 WHERE player_id = $1 AND coin_id = $2',
      [playerId, coinId]
    );
  }
  return total;
}

// How much of this (player, coin) holding is currently reserved by open
// staking positions — used to cap how much can be sold/staked further.
export async function reservedStakedAmount(playerId: string, coinId: string): Promise<number> {
  const res = await db.query<StakingPositionRow>(
    'SELECT * FROM staking_positions WHERE player_id = $1 AND coin_id = $2',
    [playerId, coinId]
  );
  const now = Date.now();
  let reserved = 0;
  for (const p of res.rows) {
    if (isPositionReserved(p, now)) reserved += p.amount;
  }
  return reserved;
}
