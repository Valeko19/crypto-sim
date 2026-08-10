import { useEffect, useState } from 'react';
import { api, ShopStatus, TradingBotStatus } from '../lib/api';
import { formatUsdd } from '../lib/format';

const DAILY_CLAIM_USDD = 100_000;

export function ShopScreen() {
  const [status, setStatus] = useState<ShopStatus | null>(null);
  const [botStatus, setBotStatus] = useState<TradingBotStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    api.getShopStatus().then(setStatus);
    api.getBotStatus().then(setBotStatus);
  }
  useEffect(load, []);

  async function claim() {
    if (!status) return;
    setBusy(true);
    setMessage(null);
    try {
      // Underlying API is still stars-priced (see config/shop.ts) — this
      // just always requests exactly enough stars to hit the fixed daily
      // claim amount at the server's current rate, rather than a slider.
      const starsAmount = DAILY_CLAIM_USDD / status.rate;
      const res = await api.purchaseShop(starsAmount);
      setMessage(`Зачислено ${formatUsdd(res.usddCredited)}`);
      load();
    } catch (e: any) {
      setMessage(e.message ?? 'Ошибка получения');
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <div className="p-4 text-muted">Загрузка…</div>;

  const alreadyClaimed = status.remainingToday < DAILY_CLAIM_USDD;

  return (
    <div className="px-4 pt-4">
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm text-muted">Раз в день</span>
          <span className="text-2xl font-bold">{formatUsdd(DAILY_CLAIM_USDD)}</span>
        </div>
        <button
          disabled={busy || alreadyClaimed}
          onClick={claim}
          className="w-full rounded-xl bg-accent-gradient py-3 font-semibold shadow-glow disabled:opacity-40"
        >
          {alreadyClaimed ? 'Заберите завтра' : 'Забрать'}
        </button>
      </div>

      {botStatus && (
        <>
          <h2 className="mb-2 mt-6 text-sm font-medium text-muted">Инвентарь</h2>
          <div className="flex gap-3">
            <div
              title="Торговый бот"
              className="flex h-24 w-24 items-center justify-center rounded-xl border border-accent-to/50 bg-card-light text-4xl"
            >
              🤖
            </div>
          </div>
        </>
      )}

      {message && <div className="mt-4 text-center text-sm text-muted">{message}</div>}
    </div>
  );
}
