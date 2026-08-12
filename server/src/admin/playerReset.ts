import { db } from '../db/index.js';

// The actual reset, shared by both trigger paths: the manual Shell script
// (scripts/reset-players.ts) and the boot-time env-var-gated path below.
// See scripts/reset-players.ts for exactly what is and isn't touched.
export async function resetAllPlayers(): Promise<number> {
  const players = await db.query('SELECT id FROM players');
  await db.query('DELETE FROM player_holdings');
  await db.query('DELETE FROM quest_progress');
  await db.query('DELETE FROM player_rank_progress');
  await db.query('DELETE FROM staking_positions');
  await db.query(
    'UPDATE players SET usdd_balance = 100, trades_count = 0, total_volume = 0, realized_pnl = 0'
  );
  return players.rows.length;
}

const RESET_MARKER_ID = 'player_reset';

// Exported so scripts/reset-players.ts can mark the reset done too — keeps
// both trigger paths mutually idempotent (whichever runs first "wins", and
// the other becomes a no-op if it's ever also triggered afterward).
export async function markResetDone(): Promise<void> {
  await db.query(
    `INSERT INTO admin_reset_log (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET ran_at = now()`,
    [RESET_MARKER_ID]
  );
}

// Runs the same full reset as scripts/reset-players.ts, but triggered by a
// plain redeploy instead of a Shell session: set RUN_PLAYER_RESET=CONFIRM in
// Render's environment variables, then deploy (or just restart the service).
// Safe to leave the env var set afterward — the admin_reset_log marker makes
// this idempotent, so a later unrelated restart with the var still present
// is a harmless no-op. (Still recommended to remove the var once done, just
// for clarity.) Call this early in boot, before the HTTP server starts
// accepting traffic.
export async function maybeRunPlayerResetOnBoot(): Promise<void> {
  if (process.env.RUN_PLAYER_RESET !== 'CONFIRM') return;

  const existing = await db.query('SELECT 1 FROM admin_reset_log WHERE id = $1', [RESET_MARKER_ID]);
  if (existing.rows.length > 0) {
    console.log('[playerReset] RUN_PLAYER_RESET is set but a reset already ran — skipping.');
    return;
  }

  console.log('[playerReset] RUN_PLAYER_RESET=CONFIRM detected — resetting all players...');
  const count = await resetAllPlayers();
  await markResetDone();
  console.log(
    `[playerReset] Done — ${count} player(s) reset to a fresh $100 balance with no holdings, ` +
      'quest/rank/staking progress. Trading bot configs left untouched.'
  );
}
