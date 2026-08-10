import { useEffect, useState } from 'react';
import { api, ShopStatus, TradingBotStatus } from '../lib/api';
import { formatUsdd } from '../lib/format';

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
      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="text-muted">Своя сумма</span>
          <span className="font-semibold">{stars}</span>
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
          Забрать
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
