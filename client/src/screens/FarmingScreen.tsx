import { useEffect, useState } from 'react';
import { api, StakingCoinView } from '../lib/api';
import { CoinAvatar } from '../components/CoinAvatar';
import { ChevronIcon } from '../components/icons';
import { formatUsdd, formatQtyCompact, formatDurationLong, parseAmountInput, formatAmountInput } from '../lib/format';

interface FormState { amount: string; }
interface StakingConfig { flexibleAprPct: number; flexibleCooldownMs: number; }

export function FarmingScreen() {
  const [coins, setCoins] = useState<StakingCoinView[] | null>(null);
  const [config, setConfig] = useState<StakingConfig | null>(null);
  const [forms, setForms] = useState<Record<string, FormState>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Accordion: one card open at a time — collapsed by default so the list
  // reads as a compact rate table, not a wall of forms.
  const [expandedCoinId, setExpandedCoinId] = useState<string | null>(null);

  function load() {
    api.getStaking().then(res => {
      setCoins(res.coins);
      setConfig(res.config);
    });
  }

  // Positions carry real-time countdowns (lock/cooldown), not tick-driven —
  // a plain periodic refetch is enough, no WebSocket needed for this screen.
  useEffect(() => {
    load();
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, []);

  function formFor(coinId: string): FormState {
    return forms[coinId] ?? { amount: '' };
  }
  function updateForm(coinId: string, patch: Partial<FormState>) {
    setForms(prev => ({ ...prev, [coinId]: { ...formFor(coinId), ...patch } }));
  }

  async function withBusy(key: string, fn: () => Promise<unknown>) {
    setBusyKey(key);
    setMessage(null);
    try {
      await fn();
      load();
    } catch (e: any) {
      setMessage(e.message ?? 'Ошибка');
    } finally {
      setBusyKey(null);
    }
  }

  function doStake(coinId: string) {
    const form = formFor(coinId);
    const amount = Number(form.amount);
    if (!amount || amount <= 0) return;
    withBusy(`stake:${coinId}`, async () => {
      await api.stake(coinId, amount);
      updateForm(coinId, { amount: '' });
    });
  }

  if (!coins || !config) return <div className="p-4 text-muted">Загрузка…</div>;

  return (
    <div className="px-4 pt-4 pb-4">
      <h1 className="mb-4 text-lg font-bold">Фарминг</h1>
      {message && <div className="mb-3 rounded-xl bg-card-light p-3 text-xs text-muted">{message}</div>}

      <div className="space-y-2">
        {coins.map(c => {
          const form = formFor(c.coinId);
          const expanded = expandedCoinId === c.coinId;
          return (
            <div key={c.coinId} className="overflow-hidden rounded-2xl border border-border bg-card">
              <button
                type="button"
                onClick={() => setExpandedCoinId(expanded ? null : c.coinId)}
                className="flex w-full items-center gap-3 p-3 text-left"
              >
                <CoinAvatar coinId={c.coinId} symbol={c.symbol} iconUrl={c.iconUrl} size={36} />
                <span className="min-w-0 flex-1 truncate font-semibold">{c.symbol}</span>
                <span className="shrink-0 text-xs font-medium text-accent-to">{config.flexibleAprPct}%</span>
                <ChevronIcon className={`h-4 w-4 shrink-0 text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} />
              </button>

              {expanded && (
                <div className="px-3 pb-3">
                  <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted">
                    <span>Доступно: {formatQtyCompact(c.sellableAmount, c.currentPrice)} {c.symbol}</span>
                    <span className="shrink-0 rounded-md bg-card-light px-2 py-1 text-xs text-accent-to">
                      {config.flexibleAprPct}% · бессрочно
                    </span>
                  </div>

                  {c.pendingRewards > 0 && (
                    <button
                      disabled={busyKey === `claim:${c.coinId}`}
                      onClick={() => withBusy(`claim:${c.coinId}`, () => api.claimStakingRewards(c.coinId))}
                      className="mb-2 w-full rounded-full border border-positive/30 bg-positive/10 px-3 py-2 text-xs font-semibold text-positive disabled:opacity-50"
                    >
                      Забрать {formatUsdd(c.pendingRewards)}
                    </button>
                  )}

                  {c.positions.length > 0 && (
                    <div className="mb-3 space-y-2">
                      {c.positions.map(p => {
                        const now = Date.now();
                        let statusLabel: string;
                        let action: { label: string; onClick: () => void } | null = null;
                        let canBreakLock = false;
                        if (!p.reserved) {
                          statusLabel = 'Готово к выводу';
                          action = { label: 'Снять', onClick: () => withBusy(`withdraw:${p.id}`, () => api.withdrawStaking(p.id)) };
                        } else if (p.mode === 'locked') {
                          const remainingSec = p.lockUntil ? Math.max(0, (new Date(p.lockUntil).getTime() - now) / 1000) : 0;
                          statusLabel = `Лок ещё ${formatDurationLong(remainingSec)}`;
                          canBreakLock = true;
                        } else if (p.unstakeRequestedAt) {
                          const remainingSec = p.unstakeAvailableAt ? Math.max(0, (new Date(p.unstakeAvailableAt).getTime() - now) / 1000) : 0;
                          statusLabel = `Анстейк через ${formatDurationLong(remainingSec)}`;
                        } else {
                          statusLabel = 'Гибкий стейк';
                          action = { label: 'Запросить анстейк', onClick: () => withBusy(`unstake:${p.id}`, () => api.requestUnstake(p.id)) };
                        }
                        return (
                          <div key={p.id} className="rounded-xl bg-card-light px-3 py-2 text-xs">
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="font-medium text-white">{formatQtyCompact(p.amount, c.currentPrice)} {c.symbol}</div>
                                <div className="text-muted">
                                  {p.mode === 'locked' ? 'Фиксированный лок' : 'Бессрочный'} · {p.aprPct}% годовых · {statusLabel}
                                </div>
                                {p.pendingRewards > 0 && (
                                  <div className="text-muted">Накоплено: {formatUsdd(p.pendingRewards)}</div>
                                )}
                              </div>
                              {action && (
                                <button
                                  disabled={busyKey === `unstake:${p.id}` || busyKey === `withdraw:${p.id}`}
                                  onClick={action.onClick}
                                  className="shrink-0 rounded-full border border-border px-3 py-1.5 font-semibold text-white disabled:opacity-50"
                                >
                                  {action.label}
                                </button>
                              )}
                            </div>
                            {canBreakLock && (
                              <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                                <span className="text-muted">Досрочно: доход сгорит, вернётся только тело</span>
                                <button
                                  disabled={busyKey === `break:${p.id}`}
                                  onClick={() => withBusy(`break:${p.id}`, () => api.breakLock(p.id))}
                                  className="shrink-0 rounded-full border border-negative/30 px-3 py-1.5 font-semibold text-negative disabled:opacity-50"
                                >
                                  Прервать
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={formatAmountInput(form.amount)}
                      onChange={e => updateForm(c.coinId, { amount: parseAmountInput(e.target.value) })}
                      placeholder={`Количество ${c.symbol}`}
                      className="min-w-0 flex-1 rounded-xl border border-border bg-bg px-3 py-2 text-sm text-white outline-none placeholder:text-muted focus:border-accent-to"
                    />
                    <button
                      type="button"
                      onClick={() => updateForm(c.coinId, { amount: c.sellableAmount > 0 ? String(c.sellableAmount) : '' })}
                      className="shrink-0 rounded-xl border border-border px-3 py-2 text-xs text-muted hover:text-white"
                    >
                      MAX
                    </button>
                  </div>
                  <button
                    disabled={busyKey === `stake:${c.coinId}` || !form.amount || c.sellableAmount <= 0}
                    onClick={() => doStake(c.coinId)}
                    className="mt-2 w-full rounded-xl bg-accent-gradient py-2.5 text-sm font-semibold shadow-glow disabled:opacity-40"
                  >
                    Застейкать
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
