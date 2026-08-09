import { useEffect, useState } from 'react';
import { api, ShopStatus, TradingBotStatus } from '../lib/api';
import { formatCompact, formatUsdd } from '../lib/format';

export function ShopScreen() {
  const [status, setStatus] = useState<ShopStatus | null>(null);
  const [botStatus, setBotStatus] = useState<TradingBotStatus | null>(null);
  const [stars, setStars] = useState(450);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    api.getShopStatus().then(setStatus);
    api.getBotStatus().then(setBotStatus);
  }
  useEffect(load, []);

  async function buyBot() {
    setBusy(true);
    setMessage(null);
    try {
      await api.purchaseBot();
      setMessage('Торговый бот разблокирован');
      load();
    } catch (e: any) {
      setMessage(e.message ?? 'Ошибка покупки');
    } finally {
      setBusy(false);
    }
  }

  async function buy(starsAmount: number, packageId?: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.purchaseShop(starsAmount, packageId);
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
        USDD за Звёзды Telegram · лимит {formatUsdd(status.dailyLimit)} в день · остаток сегодня $
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
            onClick={() => buy(pkg.stars, pkg.id)}
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

      {botStatus && (
        <>
          <h2 className="mb-2 mt-6 text-sm font-medium text-muted">Инвентарь</h2>
          <div className="flex gap-3">
            <button
              disabled={busy || botStatus.purchased}
              onClick={buyBot}
              title={botStatus.purchased ? 'Торговый бот — куплен' : `Торговый бот — ${botStatus.priceStars} звёзд`}
              className={`relative flex h-16 w-16 items-center justify-center rounded-xl border text-2xl transition-colors disabled:opacity-100 ${
                botStatus.purchased ? 'border-accent-to/50 bg-card-light' : 'border-border bg-card hover:border-accent-to'
              }`}
            >
              🤖
              {botStatus.purchased ? (
                <span className="absolute -bottom-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-positive text-[10px]">✓</span>
              ) : (
                <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-border bg-card-light px-1.5 py-0.5 text-[9px] text-muted">
                  ★{botStatus.priceStars}
                </span>
              )}
            </button>
          </div>
        </>
      )}

      {message && <div className="mt-4 text-center text-sm text-muted">{message}</div>}
    </div>
  );
}
