import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, PortfolioView } from '../lib/api';
import { useMarketSocket } from '../hooks/useMarketSocket';
import { CoinAvatar } from '../components/CoinAvatar';
import { formatUsdd, formatPct, formatPctPlain, pctColorClass, formatQtyCompact } from '../lib/format';
import { rankEmoji } from '../lib/rankVisuals';
import { RankBadge } from '../components/RankBadge';
import { ShareIcon, ChevronIcon } from '../components/icons';

export function ProfileScreen() {
  const [portfolio, setPortfolio] = useState<PortfolioView | null>(null);
  const [leaguePlace, setLeaguePlace] = useState<number | null>(null);
  const live = useMarketSocket();

  useEffect(() => {
    api.getPortfolio().then(setPortfolio);
  }, []);

  // live.portfolio updates every ~1s via WS (background drift moving holding
  // values), which made net worth/PnL jitter constantly — refresh the
  // displayed snapshot only once every 10s instead, same as market cap.
  const livePortfolioRef = useRef(live.portfolio);
  livePortfolioRef.current = live.portfolio;
  const [throttledPortfolio, setThrottledPortfolio] = useState(live.portfolio);
  useEffect(() => {
    const interval = setInterval(() => setThrottledPortfolio(livePortfolioRef.current), 10_000);
    return () => clearInterval(interval);
  }, []);

  const current = throttledPortfolio ?? portfolio;

  useEffect(() => {
    if (!current) return;
    api.getLeaderboard(current.league).then(board => {
      const me = board.entries.find(e => e.isPlayer);
      setLeaguePlace(me?.place ?? null);
    });
  }, [current?.league]);

  if (!current) return <div className="p-4 text-muted">Загрузка…</div>;

  const initials = current.username.replace('@', '').slice(0, 2).toUpperCase();

  // Portfolio rows (USDD cash + every coin holding) graded top-to-bottom by
  // value, largest first — USDD is just another balance for this ordering,
  // not pinned to the top.
  type Row = { kind: 'usdd' } | { kind: 'coin'; holding: PortfolioView['holdings'][number] };
  const rows: Row[] = [{ kind: 'usdd' }, ...current.holdings.map(holding => ({ kind: 'coin' as const, holding }))];
  const rowValue = (row: Row) => (row.kind === 'usdd' ? current.usddBalance : row.holding.value);
  rows.sort((a, b) => rowValue(b) - rowValue(a));

  return (
    <div className="px-4 pt-4">
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-gradient text-lg font-bold shadow-glow">
            {initials}
          </div>
          <span className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full border-2 border-bg bg-card-light text-sm">
            {rankEmoji(current.rank)}
          </span>
        </div>
        <div className="flex-1">
          <div className="font-semibold">{current.username}</div>
          <div className="text-sm text-muted">Ранг: {rankEmoji(current.rank)} {current.rank}</div>
        </div>
        <Link to="/leaderboard" className="text-right transition-opacity hover:opacity-80">
          <div className="inline-flex items-center gap-1 rounded-full border border-accent-to bg-card-light px-3 py-1 text-xs font-medium text-accent-to">
            {rankEmoji(current.league)} Лига {current.league}
            <ChevronIcon className="h-3 w-3" />
          </div>
          {leaguePlace != null && <div className="mt-1 text-xs text-muted">#{leaguePlace} в лиге</div>}
        </Link>
      </div>

      <div className="mt-6 flex flex-col items-center rounded-2xl border border-border bg-card-light py-4">
        <RankBadge rank={current.rank} size={120} />
        <div className="mt-1 text-sm font-medium text-muted">{current.rank}</div>
      </div>

      <h2 className="mb-2 mt-6 text-sm font-medium text-muted">Портфель</h2>
      <div className="rounded-2xl border border-border bg-card-light p-4">
        <div className="text-sm text-muted">Общий баланс</div>
        <div className="text-3xl font-bold">{formatUsdd(current.netWorth)}</div>
      </div>

      <div className="mt-2 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
        {rows.map(row =>
          row.kind === 'usdd' ? (
            <div key="usdd" className="flex items-center gap-3 p-3">
              <img src="/usdd-logo.svg" alt="USDD" className="h-10 w-10 shrink-0 rounded-full" />
              <div className="flex-1">
                <div className="font-semibold">USDD</div>
                <div className="text-xs text-muted">Свободные средства</div>
              </div>
              <div className="font-semibold">{formatUsdd(current.usddBalance)}</div>
            </div>
          ) : (
            <div key={row.holding.coinId} className="flex items-center gap-3 p-3">
              <CoinAvatar coinId={row.holding.coinId} symbol={row.holding.symbol} iconUrl={row.holding.iconUrl} size={40} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{row.holding.symbol}</div>
                <div className="truncate text-xs text-muted">
                  {formatQtyCompact(row.holding.amount, row.holding.currentPrice)} монет · {formatPctPlain(row.holding.pctEmission)} эмиссии
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-semibold">{formatUsdd(row.holding.value)}</div>
                <div className={`text-xs ${pctColorClass(row.holding.pnlPct)}`}>{formatPct(row.holding.pnlPct)}</div>
              </div>
            </div>
          )
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <div className="rounded-lg bg-card p-3">
          <div className="text-xs text-muted">Сделок</div>
          <div className="text-base font-medium text-white">{current.tradesCount}</div>
        </div>
        <div className="rounded-lg bg-card p-3">
          <div className="text-xs text-muted">Объём</div>
          <div className="text-base font-medium text-white">{formatUsdd(current.totalVolume)}</div>
        </div>
        <div className="rounded-lg bg-card p-3">
          <div className="text-xs text-muted">Реализ. P&L</div>
          <div className={`text-base font-medium ${pctColorClass(current.realizedPnl)}`}>{formatUsdd(current.realizedPnl)}</div>
        </div>
        <div className="rounded-lg bg-card p-3">
          <div className="text-xs text-muted">Оплаченная комиссия</div>
          <div className="text-base font-medium text-white">{formatUsdd(current.totalFeesPaid)}</div>
        </div>
      </div>

      <button className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-border bg-card py-3 text-sm text-muted hover:text-white">
        <ShareIcon className="h-5 w-5" />
        Пригласить друга
      </button>
    </div>
  );
}
