import { useEffect, useState } from 'react';
import { api, LeaderboardView, RankInfo } from '../lib/api';
import { formatCompact, formatUsdd } from '../lib/format';
import { rankEmoji } from '../lib/rankVisuals';

export function LeaderboardScreen() {
  const [ranks, setRanks] = useState<RankInfo[] | null>(null);
  const [league, setLeague] = useState<string | null>(null);
  const [board, setBoard] = useState<LeaderboardView | null>(null);

  useEffect(() => {
    api.getRanks().then(r => setRanks(r.ranks));
    api.getPortfolio().then(p => setLeague(p.league));
  }, []);

  useEffect(() => {
    if (!league) return;
    api.getLeaderboard(league).then(setBoard);
  }, [league]);

  if (!ranks || !league) return <div className="p-4 text-muted">Загрузка…</div>;

  return (
    <div className="px-4 pt-4">
      <h1 className="mb-3 text-2xl font-bold">Рейтинг</h1>

      <div className="mb-3 flex flex-wrap gap-2">
        {ranks.map(r => (
          <button
            key={r.name}
            onClick={() => setLeague(r.name)}
            className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
              league === r.name ? 'border-transparent bg-accent-gradient text-white' : 'border-border text-muted hover:text-white'
            }`}
          >
            {rankEmoji(r.name)} {r.name}
          </button>
        ))}
      </div>

      {board && (
        <>
          <p className="mb-3 text-sm text-muted">
            {rankEmoji(board.league)} Лига {board.league} · ${formatCompact(board.minCapital)}+ · {board.totalPlayers} игроков
          </p>
          <div className="space-y-2">
            {board.entries.map(entry => (
              <div
                key={entry.place}
                className={`flex items-center gap-3 rounded-2xl border p-3 ${
                  entry.isPlayer ? 'border-accent-to/50 bg-card-light' : 'border-border bg-card'
                }`}
              >
                <span className="w-6 shrink-0 text-sm font-semibold text-muted">{entry.place}</span>
                <span className={`flex-1 truncate font-semibold ${entry.isPlayer ? 'text-white' : ''}`}>
                  {entry.username}
                </span>
                <span className="shrink-0 font-mono text-sm">{formatUsdd(entry.netWorth)}</span>
              </div>
            ))}
            {board.entries.length === 0 && <p className="py-8 text-center text-sm text-muted">В этой лиге пока никого нет.</p>}
          </div>
        </>
      )}
    </div>
  );
}
