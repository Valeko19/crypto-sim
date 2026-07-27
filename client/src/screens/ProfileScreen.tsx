import { useEffect, useState } from 'react';
import { api, PortfolioView } from '../lib/api';
import { useMarketSocket } from '../hooks/useMarketSocket';
import { CoinAvatar } from '../components/CoinAvatar';
import { formatUsdd, formatPct, pctColorClass, formatCompact } from '../lib/format';
import { ShareIcon } from '../components/icons';
import { LOCAL_PLAYER_USERNAME } from '../lib/telegram';

export function ProfileScreen() {
  const [portfolio, setPortfolio] = useState<PortfolioView | null>(null);
  const [leaguePlace, setLeaguePlace] = useState<number | null>(null);
  const live = useMarketSocket();

  useEffect(() => {
    api.getPortfolio().then(setPortfolio);
  }, []);

  const current = live.portfolio ?? portfolio;

  useEffect(() => {
    if (!current) return;
    api.getLeaderboard(current.league).then(board => {
      const me = board.entries.find(e => e.isPlayer);
      setLeaguePlace(me?.place ?? null);
    });
  }, [current?.league]);

  if (!current) return <div className="p-4 text-muted">Загрузка…</div>;

  const initials = LOCAL_PLAYER_USERNAME.replace('@', '').slice(0, 2).toUpperCase();

  return (
    <div className="px-4 pt-4">
      <div className="flex items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent-gradient text-lg font-bold shadow-glow">
          {initials}
        </div>
        <div className="flex-1">
          <div className="font-semibold">{LOCAL_PLAYER_USERNAME}</div>
          <div className="text-sm text-muted">Ранг: {current.rank}</div>
        </div>
        <div className="text-right">
          <div className="rounded-full bg-card-light px-3 py-1 text-xs font-medium">Лига {current.league}</div>
          {leaguePlace != null && <div className="mt-1 text-xs text-muted">#{leaguePlace} в лиге</div>}
        </div>
      </div>

      <h2 className="mb-2 mt-6 text-sm font-medium text-muted">Портфель</h2>
      <div className="rounded-2xl border border-border bg-card-light p-4">
        <div className="text-sm text-muted">Общий баланс</div>
        <div className="text-3xl font-bold">{formatUsdd(current.netWorth)}</div>
      </div>

      <div className="mt-2 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex items-center gap-3 p-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-positive/20 text-sm font-bold text-positive">
            $
          </div>
          <div className="flex-1">
            <div className="font-semibold">USDD</div>
            <div className="text-xs text-muted">Свободные средства</div>
          </div>
          <div className="font-semibold">{formatUsdd(current.usddBalance)}</div>
        </div>

        {current.holdings.map(h => (
          <div key={h.coinId} className="flex items-center gap-3 p-3">
            <CoinAvatar coinId={h.coinId} symbol={h.symbol} size={40} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{h.symbol}</div>
              <div className="truncate text-xs text-muted">
                {formatCompact(h.amount)} монет · {h.pctEmission.toFixed(3)}% эмиссии
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="font-semibold">{formatUsdd(h.value)}</div>
              <div className={`text-xs ${pctColorClass(h.pnlPct)}`}>{formatPct(h.pnlPct)}</div>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-3 text-sm text-muted">
        Сделок: {current.tradesCount} · Объём: {formatUsdd(current.totalVolume)} · Реализ. P&L:{' '}
        <span className={pctColorClass(current.realizedPnl)}>{formatUsdd(current.realizedPnl)}</span>
      </p>

      <button className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-border bg-card py-3 text-sm text-muted hover:text-white">
        <ShareIcon className="h-5 w-5" />
        Пригласить друга
      </button>
    </div>
  );
}
