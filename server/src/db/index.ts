import { PGlite } from '@electric-sql/pglite';
import path from 'node:path';

// Embedded real Postgres (compiled to WASM) — no local Postgres install/service
// required. Data persists to disk between dev-server restarts.
// PGDATA_DIR overrides the location in production (Render's default web
// service filesystem is ephemeral and wipes on every deploy — PGDATA_DIR
// points at a mounted persistent disk instead; see render.yaml).
const dataDir = process.env.PGDATA_DIR ?? path.join(process.cwd(), '.pgdata');

// Lower the WASM linear memory's initial reservation (default is large enough
// that Render's free 512MB instance OOM'd on boot even with an empty DB and
// zero traffic) — this project's actual data (11 coins, a handful of NPC
// bots, one or two players) needs nowhere near PGlite's default headroom.
export const db = new PGlite(dataDir, { initialMemory: 128 * 1024 * 1024 });

export async function initDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      usdd_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
      trades_count INTEGER NOT NULL DEFAULT 0,
      total_volume DOUBLE PRECISION NOT NULL DEFAULT 0,
      realized_pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS player_holdings (
      player_id TEXT NOT NULL REFERENCES players(id),
      coin_id TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      avg_buy_price DOUBLE PRECISION NOT NULL DEFAULT 0,
      PRIMARY KEY (player_id, coin_id)
    );

    CREATE TABLE IF NOT EXISTS quest_progress (
      player_id TEXT NOT NULL REFERENCES players(id),
      quest_type TEXT NOT NULL,
      coin_id TEXT NOT NULL DEFAULT 'none',
      threshold DOUBLE PRECISION NOT NULL DEFAULT 0,
      claimed_at TIMESTAMPTZ,
      PRIMARY KEY (player_id, quest_type, coin_id, threshold)
    );

    CREATE TABLE IF NOT EXISTS npc_bots (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      simulated_net_worth DOUBLE PRECISION NOT NULL,
      league TEXT NOT NULL
    );

    -- AMM pool reserves, snapshotted periodically so a server restart resumes
    -- prices where they left off instead of re-issuing already-sold supply
    -- (which let cumulative holdings exceed 100% of emission across restarts).
    CREATE TABLE IF NOT EXISTS coin_pools (
      coin_id TEXT PRIMARY KEY,
      coin_reserve DOUBLE PRECISION NOT NULL,
      usdd_reserve DOUBLE PRECISION NOT NULL
    );

    -- Staking never moves coins out of player_holdings — a position only
    -- *reserves* part of the holding from being sold (see reservedStakedAmount
    -- in db/queries.ts). Real wall-clock time throughout (staked_at/lock_until/
    -- unstake_available_at), not game ticks. Reward is a fixed APR (see
    -- config/staking.ts) on the USD value fixed at stake time (stake_price) —
    -- not the coin's current price, so a player can't inflate their own
    -- reward by moving the coin's price on the AMM after staking.
    CREATE TABLE IF NOT EXISTS staking_positions (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id),
      coin_id TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      mode TEXT NOT NULL,
      stake_price DOUBLE PRECISION NOT NULL DEFAULT 0,
      staked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      lock_until TIMESTAMPTZ,
      unstake_requested_at TIMESTAMPTZ,
      unstake_available_at TIMESTAMPTZ,
      pending_rewards DOUBLE PRECISION NOT NULL DEFAULT 0
    );

    -- One row per player: purchase flag + the single active bot's target config,
    -- combined so retargeting (switching the one bot to a new coin) is just an
    -- overwrite of this same row, never a second row. amount means USDD for a
    -- 'buy' bot and coin quantity for a 'sell' bot, mirroring how /trade itself
    -- splits amountUsdd/amountCoin by side.
    CREATE TABLE IF NOT EXISTS trading_bots (
      player_id TEXT PRIMARY KEY REFERENCES players(id),
      purchased BOOLEAN NOT NULL DEFAULT FALSE,
      coin_id TEXT,
      side TEXT,
      interval_ms BIGINT,
      amount DOUBLE PRECISION,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      next_run_at TIMESTAMPTZ
    );
  `);
}
