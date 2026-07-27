import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, CoinListItem, MarketStatus } from '../lib/api';
import { useMarketSocket } from '../hooks/useMarketSocket';
import { CoinAvatar } from '../components/CoinAvatar';
import { FearGreedBar } from '../components/FearGreedBar';
import { formatCompact, formatPrice, formatPct, pctColorClass, formatDurationShort } from '../lib/format';
import { SHOW_DEBUG_PHASE } from '../config';

const DEBUG_PHASES: { label: string; phase: string }[] = [
  { label: 'Бычий', phase: 'bull' },
  { label: 'Распределение', phase: 'euphoria' },
  { label: 'Медвежий', phase: 'bear' },
  { label: 'Зима', phase: 'accumulation' },
  { label: 'Восстановление', phase: 'early_bull' },
];

const SECTION_LABEL: Record<string, string> = { top1: 'Топ 1', alt: 'Альткоины', meme: 'Мемкоины' };
const SECTION_ORDER = ['top1', 'alt', 'meme'];

export function MarketScreen() {
  const [coins, setCoins] = useState<CoinListItem[] | null>(null);
  const [marketStatus, setMarketStatus] = useState<MarketStatus | null>(null);
  const live = useMarketSocket();
  const navigate = useNavigate();

  useEffect(() => {
    api.getCoins().then(res => {
      setCoins(res.coins);
      setMarketStatus(res.marketStatus);
    });
  }, []);

  const status = live.marketStatus ?? marketStatus;

  const bySection = useMemo(() => {
    if (!coins) return null;
    const groups: Record<string, CoinListItem[]> = { top1: [], alt: [], meme: [] };
    for (const c of coins) groups[c.section].push(c);
    // Rank by live market cap within each section — a coin's section (top1 /
    // alt / meme) is fixed, but its position inside that section tracks its
    // current cap so the list stays a real leaderboard, not a static order.
    for (const list of Object.values(groups)) {
      list.sort((a, b) => {
        const capA = (live.prices[a.id]?.price ?? a.price) * a.supply;
        const capB = (live.prices[b.id]?.price ?? b.price) * b.supply;
        return capB - capA;
      });
    }
    return groups;
  }, [coins, live.prices]);

  if (!coins || !bySection) {
    return <div className="p-4 text-muted">Загрузка рынка…</div>;
  }

  return (
    <div className="px-4 pt-4">
      <div className="mb-4 flex items-start justify-between">
        <h1 className="text-2xl font-bold">Рынок</h1>
        {status && (
          <div className="flex flex-col items-end gap-1.5">
            <span className="rounded-full bg-accent-gradient px-3 py-1 text-xs font-semibold">
              {status.phaseLabel}
            </span>
            <div className="h-1 w-28 overflow-hidden rounded-full bg-card-light">
              <div
                className="h-full bg-accent-gradient transition-[width] duration-1000 ease-linear"
                style={{ width: `${status.progressPct}%` }}
              />
            </div>
            <span className="text-[10px] text-muted">
              смена фазы через {formatDurationShort(status.remainingSec)}
            </span>
          </div>
        )}
      </div>

      {status && <FearGreedBar index={status.fearGreedIndex} label={status.fearGreedLabel} />}

      {SHOW_DEBUG_PHASE && (
        <div className="mt-4 flex flex-wrap gap-2">
          {DEBUG_PHASES.map(d => (
            <button
              key={d.phase}
              onClick={() => api.forceDebugPhase(d.phase)}
              className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                status?.phase === d.phase
                  ? 'border-transparent bg-accent-gradient text-white'
                  : 'border-border text-muted hover:text-white'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      )}

      <div className="mt-6 space-y-6">
        {SECTION_ORDER.map(section => (
          <div key={section}>
            <h2 className="mb-2 text-sm font-medium text-muted">{SECTION_LABEL[section]}</h2>
            <div className="space-y-2">
              {bySection[section].map(coin => {
                const l = live.prices[coin.id];
                const price = l?.price ?? coin.price;
                const change = l?.change24hPct ?? coin.change24hPct;
                return (
                  <button
                    key={coin.id}
                    onClick={() => navigate(`/market/${coin.id}`)}
                    className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:bg-card-light"
                  >
                    <CoinAvatar coinId={coin.id} symbol={coin.symbol} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="font-semibold">{coin.symbol}</span>
                        <span className="truncate text-sm text-muted">{coin.name}</span>
                      </div>
                      <div className="text-xs text-muted">
                        MCap ${formatCompact(price * coin.supply)} · Supply {formatCompact(coin.supply)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-semibold">${formatPrice(price)}</div>
                      <div className={`text-sm ${pctColorClass(change)}`}>{formatPct(change)}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
