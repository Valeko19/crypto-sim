// ONE-TIME beta-reset script. NOT part of the app's normal runtime — nothing
// in server/src imports this file, there is no API route or UI button for
// it. Run manually, once, from a shell with access to the SAME PGDATA_DIR
// the live server uses (see the deployment instructions given alongside this
// script) whenever the beta needs to restart every existing player from a
// clean slate.
//
// Resets, for every player row already in the database:
//   - usdd_balance -> 100 (the same starting bonus ensurePlayer grants new players)
//   - trades_count / total_volume / realized_pnl -> 0 (lifetime stats reset
//     alongside the balance so they don't read as stale leftovers against an
//     otherwise-fresh account)
//   - player_holdings -> deleted entirely (no coin positions left)
//   - quest_progress -> deleted entirely (daily bonus, daily volume, emission
//     capture, and any future quest type are all cleared)
//   - player_rank_progress -> deleted entirely (peak-rank tracking drops back
//     to its default of 0 / Планктон, so rank-up rewards can be earned again
//     from scratch)
//   - staking_positions -> deleted entirely (both staked principal and any
//     accrued pending_rewards are forfeited)
//
// Deliberately NOT touched: trading_bots (bot target/interval/amount/enabled
// config isn't "portfolio progress" — the user asked to leave it as-is).
//
// Safety: requires an explicit --yes flag so it can never run by accident.
import { db, initDb } from '../src/db/index.js';

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error(
      'This PERMANENTLY wipes progress for ALL existing players: balance -> $100, ' +
        'all holdings/quest progress/rank progress/staking positions deleted. ' +
        'Trading bot configs are left untouched. Re-run with --yes to actually execute.'
    );
    process.exit(1);
  }

  await initDb();

  const players = await db.query('SELECT id FROM players');
  console.log(`Resetting ${players.rows.length} player(s)...`);

  await db.query('DELETE FROM player_holdings');
  await db.query('DELETE FROM quest_progress');
  await db.query('DELETE FROM player_rank_progress');
  await db.query('DELETE FROM staking_positions');
  await db.query(
    'UPDATE players SET usdd_balance = 100, trades_count = 0, total_volume = 0, realized_pnl = 0'
  );

  console.log(
    'Done. All players reset to a fresh $100 balance with no holdings, quest progress, ' +
      'rank progress, or staking positions. Trading bot configs were left untouched.'
  );
  process.exit(0);
}

main().catch(err => {
  console.error('Reset failed:', err);
  process.exit(1);
});
