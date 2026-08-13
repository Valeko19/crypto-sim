import { PortfolioView } from '../api/helpers.js';
import { getAllHighestLeagueIndexes, setHighestLeagueIndex } from '../db/queries.js';

// Called every tick with the SAME portfolios map the tick loop already built
// for the per-connection WS push — no extra portfolio computation needed,
// just one bulk read of stored peaks. Only players who actually advanced past
// their own peak get a write (rare event), so this stays cheap at any tick
// rate. This only ever tracks the PEAK reached — it no longer credits any
// reward itself; a newly-crossed rank just becomes claimable (see GET /quests
// and POST /quests/claim's 'rank_reward:<index>' branch in api/routes.ts,
// same manual-claim pattern as the emission-capture ladder). If a player's
// net worth jumps past multiple ranks in one go (e.g. a big win), every
// newly-crossed rank becomes claimable, not just the final one landed on —
// achieved is always `highestLeagueIndex >= rankIndex`, so nothing in between
// is ever skipped.
export async function checkRankUpRewards(portfolios: Map<string, PortfolioView>): Promise<void> {
  const highestByPlayer = await getAllHighestLeagueIndexes();
  for (const [playerId, view] of portfolios) {
    const priorHighest = highestByPlayer.get(playerId) ?? 0;
    if (view.leagueIndex <= priorHighest) continue;
    await setHighestLeagueIndex(playerId, view.leagueIndex);
  }
}
