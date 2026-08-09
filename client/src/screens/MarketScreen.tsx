import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, CoinListItem, MarketStatus } from '../lib/api';
import { useMarketSocket } from '../hooks/useMarketSocket';
import { LivePriceInfo } from '../lib/wsStore';
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

  // Price/% change still tick live (every ~1s via WS), but market cap — and the
  // section ordering derived from it — only needs to feel current, not jump
  // every second; refreshing it that often just re-sorts the list underneath
  // the reader. Throttle the snapshot used for cap/sort to once every 10s.
  const livePricesRef = useRef<Record<string, LivePriceInfo>>(live.prices);
  livePricesRef.current = live.prices;
  const [capPrices, setCapPrices] = useState<Record<string, LivePriceInfo>>(live.prices);
  useEffect(() => {
    const interval = setInterval(() => setCapPrices(livePricesRef.current), 10_000);
    return () => clearInterval(interval);
  }, []);

  const status = live.marketStatus ?? marketStatus;

  const bySection = useMemo(() => {
    if (!coins) return null;
    const groups: Record<string, CoinListItem[]> = { top1: [], alt: [], meme: [] };
    for (const c of coins) groups[c.section].push(c);
    // Rank by market cap (refreshed every 10s, see capPrices above) within each
    // section — a coin's section (top1 / alt / meme) is fixed, but its position
    // inside that section tracks its cap so the list stays a real leaderboard,
    // not a static order.
    for (const list of Object.values(groups)) {
      list.sort((a, b) => {
        const capA = (capPrices[a.id]?.price ?? a.price) * a.supply;
        const capB = (capPrices[b.id]?.price ?? b.price) * b.supply;
        return capB - capA;
      });
    }
    return groups;
  }, [coins, capPrices]);

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
            // Read-only phase indicator — NOT a control. Must never call
            // anything that mutates market state (see server/src/api/routes.ts
            // /debug/phase, which is itself gated off in production regardless).
            <span
              key={d.phase}
              className={`cursor-default select-none rounded-full border px-3 py-1.5 text-xs ${
                status?.phase === d.phase
                  ? 'border-transparent bg-accent-gradient text-white'
                  : 'border-border text-muted'
              }`}
            >
              {d.label}
            </span>
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
                const change = l?.changePct ?? coin.changePct;
                const capPrice = capPrices[coin.id]?.price ?? coin.price;
                return (
                  <button
                    key={coin.id}
                    onClick={() => navigate(`/market/${coin.id}`)}
                    className="flex w-full items-center gap-3 rounded-2xl border border-border bg-card p-3 text-left transition-colors hover:bg-card-light"
                  >
                    <CoinAvatar coinId={coin.id} symbol={coin.symbol} iconUrl={coin.iconUrl} size={56} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="font-semibold">{coin.symbol}</span>
                        <span className="truncate text-sm text-muted">{coin.name}</span>
                      </div>
                      <div className="text-xs text-muted">
                        MCap ${formatCompact(capPrice * coin.supply)} · Supply {formatCompact(coin.supply)}
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
