import { randomUUID } from 'node:crypto';
import { db } from './index.js';
import { StakingMode, STAKING_FLEXIBLE_APR, STAKING_LOCKED_APR } from '../config/staking.js';

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

// Single atomic upsert — closes the race between two near-simultaneous first
// requests for the same brand-new id, and keeps username fresh if the player
// renamed themselves in Telegram since their last visit (previously it was
// only ever written on INSERT and never touched again).
export async function ensurePlayer(id: string, username: string): Promise<PlayerRow> {
  const STARTING_BONUS = 100;
  const res = await db.query<PlayerRow>(
    `INSERT INTO players (id, username, usdd_balance) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET username = $2
     RETURNING *`,
    [id, username, STARTING_BONUS]
  );
  return res.rows[0];
}

// For call sites that only need the row to exist and don't know the real
// username (the trading-bot background job calls executeTrade outside any
// HTTP/WS auth handshake) — never touches username, so it can't clobber a
// real Telegram name with a placeholder. Use ensurePlayer above wherever the
// real username is actually known (REST middleware, WS auth handshake).
export async function ensurePlayerExists(id: string): Promise<void> {
  await db.query(
    `INSERT INTO players (id, username, usdd_balance) VALUES ($1, $1, 100)
     ON CONFLICT (id) DO NOTHING`,
    [id]
  );
}

export async function getAllPlayers(): Promise<PlayerRow[]> {
  return (await db.query<PlayerRow>('SELECT * FROM players')).rows;
}

export async function getPlayer(id: string): Promise<PlayerRow> {
  const res = await db.query<PlayerRow>('SELECT * FROM players WHERE id = $1', [id]);
  return res.rows[0];
}

export async function getHoldings(playerId: string): Promise<HoldingRow[]> {
  const res = await db.query<HoldingRow>('SELECT * FROM player_holdings WHERE player_id = $1', [playerId]);
  return res.rows;
}

export async function getAllHoldings(): Promise<HoldingRow[]> {
  return (await db.query<HoldingRow>('SELECT * FROM player_holdings')).rows;
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

// --- Lifetime earned totals (per quest section) -----------------------------
// One column per section on the Quests screen — see player_earned_totals'
// table comment (db/index.ts). Column names can't be parameterized, so each
// category gets its own static query rather than interpolating an identifier.

export type EarnedCategory = 'daily' | 'emission' | 'rank';

const EARNED_TOTAL_UPSERT: Record<EarnedCategory, string> = {
  daily: `INSERT INTO player_earned_totals (player_id, daily_earned_total) VALUES ($1, $2)
          ON CONFLICT (player_id) DO UPDATE SET daily_earned_total = player_earned_totals.daily_earned_total + $2`,
  emission: `INSERT INTO player_earned_totals (player_id, emission_earned_total) VALUES ($1, $2)
             ON CONFLICT (player_id) DO UPDATE SET emission_earned_total = player_earned_totals.emission_earned_total + $2`,
  rank: `INSERT INTO player_earned_totals (player_id, rank_earned_total) VALUES ($1, $2)
         ON CONFLICT (player_id) DO UPDATE SET rank_earned_total = player_earned_totals.rank_earned_total + $2`,
};

export async function addEarnedTotal(playerId: string, category: EarnedCategory, amount: number): Promise<void> {
  if (amount <= 0) return;
  await db.query(EARNED_TOTAL_UPSERT[category], [playerId, amount]);
}

export interface EarnedTotals {
  daily: number;
  emission: number;
  rank: number;
}

export async function getEarnedTotals(playerId: string): Promise<EarnedTotals> {
  const res = await db.query<{ daily_earned_total: number; emission_earned_total: number; rank_earned_total: number }>(
    'SELECT daily_earned_total, emission_earned_total, rank_earned_total FROM player_earned_totals WHERE player_id = $1',
    [playerId]
  );
  const row = res.rows[0];
  return {
    daily: Number(row?.daily_earned_total ?? 0),
    emission: Number(row?.emission_earned_total ?? 0),
    rank: Number(row?.rank_earned_total ?? 0),
  };
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

// --- Staking: positions ------------------------------------------------------
// Staking never moves coins out of player_holdings — a position only reserves
// part of the holding from being sold. All timestamps are real wall-clock time
// (see config/staking.ts), not game ticks. Reward is a fixed APR on the USD
// value fixed at stake time (stake_price) — no per-coin fee pool anymore.

export interface StakingPositionRow {
  id: string;
  player_id: string;
  coin_id: string;
  amount: number;
  mode: StakingMode;
  stake_price: number;
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

// Locked earns the locked APR only while the lock is genuinely still active;
// past its own expiry (but not yet withdrawn) it earns the flexible APR
// instead — no incentive to "forget" to withdraw to keep the higher rate
// forever. Shared by engine/staking.ts (distribution) and helpers.ts
// (display) so this logic only lives in one place.
export function effectiveApr(p: StakingPositionRow, nowMs: number): number {
  if (p.mode === 'locked' && p.lock_until && new Date(p.lock_until).getTime() > nowMs) {
    return STAKING_LOCKED_APR;
  }
  return STAKING_FLEXIBLE_APR;
}

export async function createStakingPosition(
  playerId: string,
  coinId: string,
  amount: number,
  mode: StakingMode,
  lockUntil: Date | null,
  stakePrice: number
): Promise<StakingPositionRow> {
  const id = randomUUID();
  const res = await db.query<StakingPositionRow>(
    `INSERT INTO staking_positions (id, player_id, coin_id, amount, mode, lock_until, stake_price)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [id, playerId, coinId, amount, mode, lockUntil ? lockUntil.toISOString() : null, stakePrice]
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
// distribution job (engine/staking.ts).
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

// Deletes without paying out pending_rewards — used for the locked early
// break-lock path, where accrued reward is forfeited by design.
export async function deleteStakingPosition(positionId: string): Promise<void> {
  await db.query('DELETE FROM staking_positions WHERE id = $1', [positionId]);
}

export async function addPendingRewards(positionId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  await db.query('UPDATE staking_positions SET pending_rewards = pending_rewards + $2 WHERE id = $1', [positionId, amount]);
}

// Atomic delete+read in one statement — a separate prior read is only ever
// used to decide ELIGIBILITY (isPositionReserved), never as the source of the
// paid-out amount, so a concurrent addPendingRewards landing between the
// eligibility check and this call is still captured correctly, and a second
// concurrent call (double-click/retry) finds nothing left to delete and
// returns null instead of double-crediting.
export async function withdrawStakingPosition(positionId: string, playerId: string): Promise<number | null> {
  const res = await db.query<{ pending_rewards: number }>(
    'DELETE FROM staking_positions WHERE id = $1 AND player_id = $2 RETURNING pending_rewards',
    [positionId, playerId]
  );
  return res.rows[0] ? Number(res.rows[0].pending_rewards) : null;
}

// Claims only FLEXIBLE positions' accrued reward for this (player, coin) —
// locked positions' reward is intentionally never independently claimable
// mid-lock; it's only ever settled by withdrawStakingPosition (full term) or
// forfeited by deleteStakingPosition (early break). Otherwise a player could
// claim a locked position's reward here first, THEN break the lock, keeping
// the reward the break-lock penalty is supposed to forfeit. Single UPDATE...
// RETURNING (not select-then-update) so there's no gap for a concurrent
// addPendingRewards to land unaccounted-for.
export async function claimFlexibleCoinRewards(playerId: string, coinId: string): Promise<number> {
  const res = await db.query<{ pending_rewards: number }>(
    `UPDATE staking_positions SET pending_rewards = 0
     WHERE player_id = $1 AND coin_id = $2 AND mode = 'flexible' AND pending_rewards > 0
     RETURNING pending_rewards`,
    [playerId, coinId]
  );
  return res.rows.reduce((sum, r) => sum + Number(r.pending_rewards), 0);
}

// --- Trading bot -------------------------------------------------------------
// One row per player: purchase flag + the single active bot's target config
// (see db/index.ts for the table comment). Retargeting to a new coin is just
// an overwrite of this same row via configureTradingBot's upsert.

export interface TradingBotRow {
  player_id: string;
  purchased: boolean;
  coin_id: string | null;
  side: 'buy' | 'sell' | null;
  interval_ms: number | null;
  amount: number | null;
  enabled: boolean;
  next_run_at: string | null;
}

export async function getTradingBot(playerId: string): Promise<TradingBotRow | null> {
  const res = await db.query<TradingBotRow>('SELECT * FROM trading_bots WHERE player_id = $1', [playerId]);
  return res.rows[0] ?? null;
}

// Deliberately never touches `enabled` — saving a config is a pure settings
// update, not a start/stop action, so the Включить/Отключить toggle stays
// the ONE place that changes whether the bot is actually running. A brand
// new row falls back to the column's own DEFAULT FALSE (configure, then
// explicitly enable); editing an existing (possibly paused) bot's settings
// can never silently resume it.
export async function configureTradingBot(
  playerId: string,
  coinId: string,
  side: 'buy' | 'sell',
  intervalMs: number,
  amount: number
): Promise<void> {
  const nextRunAt = new Date(Date.now() + intervalMs).toISOString();
  await db.query(
    `INSERT INTO trading_bots (player_id, purchased, coin_id, side, interval_ms, amount, next_run_at)
     VALUES ($1, TRUE, $2, $3, $4, $5, $6)
     ON CONFLICT (player_id) DO UPDATE SET
       coin_id = $2, side = $3, interval_ms = $4, amount = $5, next_run_at = $6`,
    [playerId, coinId, side, intervalMs, amount, nextRunAt]
  );
}

// Resets next_run_at when enabling, so resuming a long-paused bot doesn't
// immediately fire off a stale schedule from before it was turned off.
export async function setTradingBotEnabled(playerId: string, enabled: boolean): Promise<void> {
  if (enabled) {
    const bot = await getTradingBot(playerId);
    if (!bot?.interval_ms) return;
    await db.query('UPDATE trading_bots SET enabled = TRUE, next_run_at = $2 WHERE player_id = $1', [
      playerId,
      new Date(Date.now() + bot.interval_ms).toISOString(),
    ]);
  } else {
    await db.query('UPDATE trading_bots SET enabled = FALSE WHERE player_id = $1', [playerId]);
  }
}

// Every player with an active, purchased bot — polled by the background job.
export async function getAllEnabledTradingBots(): Promise<TradingBotRow[]> {
  const res = await db.query<TradingBotRow>('SELECT * FROM trading_bots WHERE enabled = TRUE AND purchased = TRUE');
  return res.rows;
}

export async function advanceBotNextRun(playerId: string, intervalMs: number): Promise<void> {
  await db.query('UPDATE trading_bots SET next_run_at = $2 WHERE player_id = $1', [
    playerId,
    new Date(Date.now() + intervalMs).toISOString(),
  ]);
}

// --- Rank-up rewards ---------------------------------------------------------
// See player_rank_progress's table comment (db/index.ts) — this only ever
// tracks the PEAK league index a player has reached, never the live one.

export async function getAllHighestLeagueIndexes(): Promise<Map<string, number>> {
  const res = await db.query<{ player_id: string; highest_league_index: number }>(
    'SELECT player_id, highest_league_index FROM player_rank_progress'
  );
  return new Map(res.rows.map(r => [r.player_id, r.highest_league_index]));
}

export async function getHighestLeagueIndex(playerId: string): Promise<number> {
  const res = await db.query<{ highest_league_index: number }>(
    'SELECT highest_league_index FROM player_rank_progress WHERE player_id = $1',
    [playerId]
  );
  return res.rows[0]?.highest_league_index ?? 0;
}

export async function setHighestLeagueIndex(playerId: string, index: number): Promise<void> {
  await db.query(
    `INSERT INTO player_rank_progress (player_id, highest_league_index) VALUES ($1, $2)
     ON CONFLICT (player_id) DO UPDATE SET highest_league_index = $2`,
    [playerId, index]
  );
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
