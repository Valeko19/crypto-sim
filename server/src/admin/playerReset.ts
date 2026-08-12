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
  // An already-enabled bot fires on its own schedule (the background job
  // polls independently of the reset) and would otherwise immediately spend
  // the freshly-reset $100 balance on its configured coin the moment the
  // server comes back up — observed in practice on the first real reset run.
  // Target/interval/amount stay as configured (still not "portfolio"), only
  // the running state is turned off — the player re-enables it themselves.
  await db.query('UPDATE trading_bots SET enabled = FALSE');
  return players.rows.length;
}

// Runs the same full reset as scripts/reset-players.ts, but triggered by a
// plain redeploy instead of a Shell session: set RUN_PLAYER_RESET to any new,
// never-used-before value (e.g. a date like "2026-08-20") in Render's
// environment variables, then deploy (or just restart the service).
//
// The exact VALUE is the one-time token, not just the var's presence — each
// distinct value can only ever trigger one reset (recorded as its own row in
// admin_reset_log), so:
//   - an unrelated later restart with the same value still set is a safe
//     no-op (already consumed), and
//   - wanting another reset later during the beta just means setting the var
//     to a NEW value and deploying again — no code changes needed, repeatable
//     as many times as the beta needs.
// Once beta is over, simply stop setting the var (or remove it) and no
// further resets will ever run automatically. Call this early in boot,
// before the HTTP server starts accepting traffic.
export async function maybeRunPlayerResetOnBoot(): Promise<void> {
  const token = process.env.RUN_PLAYER_RESET;
  if (!token) return;

  const markerId = `player_reset:${token}`;
  const existing = await db.query('SELECT 1 FROM admin_reset_log WHERE id = $1', [markerId]);
  if (existing.rows.length > 0) {
    console.log(`[playerReset] RUN_PLAYER_RESET=${token} was already consumed — skipping.`);
    return;
  }

  console.log(`[playerReset] RUN_PLAYER_RESET=${token} detected — resetting all players...`);
  const count = await resetAllPlayers();
  await db.query('INSERT INTO admin_reset_log (id) VALUES ($1)', [markerId]);
  console.log(
    `[playerReset] Done — ${count} player(s) reset to a fresh $100 balance with no holdings, ` +
      'quest/rank/staking progress. All trading bots disabled (config left intact).'
  );
}
