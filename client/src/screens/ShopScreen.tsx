import { useEffect, useState } from 'react';
import { api, ShopStatus } from '../lib/api';
import { formatCompact, formatUsdd } from '../lib/format';

export function ShopScreen() {
  const [status, setStatus] = useState<ShopStatus | null>(null);
  const [stars, setStars] = useState(450);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    api.getShopStatus().then(setStatus);
  }
  useEffect(load, []);

  async function buy(starsAmount: number) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.purchaseShop(starsAmount);
      setMessage(`Зачислено ${formatUsdd(res.usddCredited)}`);
      load();
    } catch (e: any) {
      setMessage(e.message ?? 'Ошибка покупки');
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <div className="p-4 text-muted">Загрузка…</div>;

  const willGet = stars * status.rate;

  return (
    <div className="px-4 pt-4">
      <h1 className="text-2xl font-bold">Магазин</h1>
      <p className="mb-4 text-sm text-muted">
        USDD за Звёзды Telegram · лимит {formatUsdd(1_000_000_000)} в день · остаток сегодня $
        {formatCompact(status.remainingToday)}
      </p>

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="text-muted">Своя сумма</span>
          <span className="font-semibold">★ {stars}</span>
        </div>
        <input
          type="range"
          min={10}
          max={10000}
          step={10}
          value={stars}
          onChange={e => setStars(Number(e.target.value))}
          className="w-full accent-accent-to"
        />
        <div className="mt-4 flex items-center justify-between">
          <span className="text-sm text-muted">Получите</span>
          <span className="text-2xl font-bold">{formatUsdd(willGet)}</span>
        </div>
        <button
          disabled={busy}
          onClick={() => buy(stars)}
          className="mt-4 w-full rounded-xl bg-accent-gradient py-3 font-semibold shadow-glow disabled:opacity-40"
        >
          Купить за {stars} звёзд
        </button>
      </div>

      <h2 className="mb-2 mt-6 text-sm font-medium text-muted">Пакеты — выгоднее за объём</h2>
      <div className="grid grid-cols-2 gap-3">
        {status.packages.map(pkg => (
          <button
            key={pkg.id}
            disabled={busy}
            onClick={() => buy(pkg.stars)}
            className={`relative rounded-2xl border p-4 text-left transition-colors ${
              pkg.popular ? 'border-accent-to/60 bg-card-light' : 'border-border bg-card'
            } disabled:opacity-40`}
          >
            {pkg.popular && (
              <span className="absolute -top-2.5 left-3 rounded-full bg-accent-gradient px-2 py-0.5 text-[10px] font-semibold">
                Популярный
              </span>
            )}
            <div className="text-lg font-bold">{formatUsdd(pkg.usddAmount)}</div>
            {pkg.bonusPct > 0 && <div className="text-xs text-positive">+{pkg.bonusPct}% бонус</div>}
            <div className="mt-1 text-sm text-muted">★ {pkg.stars.toLocaleString('ru-RU')}</div>
          </button>
        ))}
      </div>

      {message && <div className="mt-4 text-center text-sm text-muted">{message}</div>}
    </div>
  );
}
