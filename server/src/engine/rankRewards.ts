import { PortfolioView } from '../api/helpers.js';
import { RANK_UP_REWARDS } from '../config/ranks.js';
import { getAllHighestLeagueIndexes, setHighestLeagueIndex } from '../db/queries.js';

// Called every tick with the SAME portfolios map the tick loop already built
// for the per-connection WS push — no extra portfolio computation needed,
// just one bulk read of stored peaks. Only players who actually advanced
// past their own peak get a write (rare event), so this stays cheap at any
// tick rate. If a player's net worth jumps past multiple ranks in one go
// (e.g. a big win), every newly-crossed rank's reward is credited, not just
// the final one landed on.
export async function checkRankUpRewards(portfolios: Map<string, PortfolioView>): Promise<void> {
  const highestByPlayer = await getAllHighestLeagueIndexes();
  for (const [playerId, view] of portfolios) {
    const priorHighest = highestByPlayer.get(playerId) ?? 0;
    if (view.leagueIndex <= priorHighest) continue;

    let reward = 0;
    for (let i = priorHighest + 1; i <= view.leagueIndex; i++) {
      reward += RANK_UP_REWARDS[i] ?? 0;
    }
    if (reward > 0) {
      const { db } = await import('../db/index.js');
      await db.query('UPDATE players SET usdd_balance = usdd_balance + $1 WHERE id = $2', [reward, playerId]);
    }
    await setHighestLeagueIndex(playerId, view.leagueIndex);
  }
}
