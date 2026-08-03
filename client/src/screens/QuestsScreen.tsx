import { useEffect, useState } from 'react';
import { api, QuestsView } from '../lib/api';
import { GiftIcon } from '../components/icons';
import { formatUsdd } from '../lib/format';

export function QuestsScreen() {
  const [quests, setQuests] = useState<QuestsView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    api.getQuests().then(setQuests);
  }
  useEffect(load, []);

  async function claim(questId: string) {
    setBusyId(questId);
    try {
      await api.claimQuest(questId);
      load();
    } catch {
      // ignore — refresh will re-sync actual state
    } finally {
      setBusyId(null);
    }
  }

  if (!quests) return <div className="p-4 text-muted">Загрузка…</div>;

  const { dailyBonus, emissionCapture } = quests;

  return (
    <div className="px-4 pt-4">
      <h2 className="mb-2 text-sm font-medium text-muted">Ежедневные</h2>
      <div
        className={`mb-6 flex items-center gap-3 rounded-2xl border p-4 ${
          !dailyBonus.available ? 'border-positive/30 bg-positive/5' : 'border-border bg-card'
        }`}
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-gradient">
          <GiftIcon className="h-5 w-5 text-white" />
        </div>
        <div className="flex-1">
          <div className="font-semibold">Ежедневный бонус</div>
          {!dailyBonus.available && <div className="text-sm text-positive">Выполнено</div>}
        </div>
        <button
          disabled={!dailyBonus.available || busyId === 'daily_bonus'}
          onClick={() => claim('daily_bonus')}
          className="shrink-0 rounded-full bg-positive px-4 py-2 text-sm font-semibold text-black disabled:bg-card-light disabled:text-muted"
        >
          {!dailyBonus.available ? 'Выполнено' : `Забрать ${formatUsdd(dailyBonus.amount)}`}
        </button>
      </div>

      <h2 className="mb-1 text-sm font-medium text-muted">Захват эмиссии</h2>
      {!emissionCapture.leaderCoinId && (
        <p className="mb-3 text-sm text-muted">У вас пока нет позиций — купите монету, чтобы начать захват эмиссии.</p>
      )}

      <div className="space-y-2">
        {emissionCapture.ladder.map(step => {
          const questId = `emission_capture:${step.coinId}:${step.threshold}`;
          return (
            <div
              key={step.threshold}
              className={`flex items-center gap-3 rounded-2xl border p-3 ${
                step.claimed ? 'border-positive/30 bg-positive/5' : 'border-border bg-card'
              }`}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-card-light text-xs font-semibold">
                {step.threshold}%
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">Выкупить {step.threshold}% эмиссии монеты</div>
                <div className={`text-sm ${step.claimed ? 'text-positive' : step.met ? 'text-positive' : 'text-muted'}`}>
                  {step.claimed ? 'Взято' : step.met ? 'Готово' : 'Недостаточно'}
                </div>
              </div>
              <button
                disabled={!step.met || step.claimed || busyId === questId}
                onClick={() => claim(questId)}
                className="shrink-0 rounded-full bg-positive px-4 py-2 text-sm font-semibold text-black disabled:bg-card-light disabled:text-muted"
              >
                {step.claimed ? 'Взято' : `Забрать ${formatUsdd(step.reward)}`}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
