// ONE-TIME beta-reset script. NOT part of the app's normal runtime — nothing
// in server/src imports this file, there is no API route or UI button for
// it. Run manually, once, from a shell with access to the SAME PGDATA_DIR
// the live server uses (see the deployment instructions given alongside this
// script) whenever the beta needs to restart every existing player from a
// clean slate.
//
// There is also a Shell-free alternative that runs the identical reset from
// a normal redeploy instead — see admin/playerReset.ts's maybeRunPlayerResetOnBoot,
// triggered by setting RUN_PLAYER_RESET to a new value in Render's env vars.
// Both paths share the same resetAllPlayers() logic; pick whichever is more
// convenient at the time — this script's own --yes flag is its confirmation,
// independent of the other path's env-var token.
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
//   - player_earned_totals -> deleted entirely (the "Всего получено" lifetime
//     counters shown per quest section go back to $0)
//   - trading_bots.enabled -> false for every bot (an already-enabled bot
//     otherwise fires on its own background schedule and immediately spends
//     the freshly-reset $100 balance the moment the server is back up —
//     target/interval/amount are left as configured, only the running state
//     is turned off; the player re-enables it themselves)
//
// Safety: requires an explicit --yes flag so it can never run by accident.
import { initDb } from '../src/db/index.js';
import { resetAllPlayers } from '../src/admin/playerReset.js';

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error(
      'This PERMANENTLY wipes progress for ALL existing players: balance -> $100, ' +
        'all holdings/quest progress/rank progress/staking positions deleted, all bots disabled. ' +
        'Re-run with --yes to actually execute.'
    );
    process.exit(1);
  }

  await initDb();

  console.log('Resetting all players...');
  const count = await resetAllPlayers();

  console.log(
    `Done. ${count} player(s) reset to a fresh $100 balance with no holdings, quest progress, ` +
      'rank progress, or staking positions. All trading bots were disabled (config left intact).'
  );
  process.exit(0);
}

main().catch(err => {
  console.error('Reset failed:', err);
  process.exit(1);
});
