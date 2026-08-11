import { useEffect, useState } from 'react';
import { api, QuestsView } from '../lib/api';
import { GiftIcon, CheckIcon } from '../components/icons';
import { formatUsdd } from '../lib/format';
import { rankEmoji } from '../lib/rankVisuals';

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

  const { dailyBonus, emissionCapture, rankRewards } = quests;

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
          const questId = step.coinId ? `emission_capture:${step.coinId}:${step.threshold}` : null;
          const ready = step.met && !step.claimed;
          return (
            <div
              key={step.threshold}
              className={`flex items-center gap-3 rounded-2xl border p-3 ${
                ready ? 'border-positive/30 bg-positive/5' : 'border-border bg-card'
              }`}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-card-light text-xs font-semibold">
                {step.threshold}%
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">Выкупить {step.threshold}% эмиссии монеты</div>
                {!step.claimed && (
                  <div className={`text-sm ${ready ? 'text-positive' : 'text-muted'}`}>
                    {ready ? 'Готово' : 'Недостаточно'}
                  </div>
                )}
              </div>
              {step.claimed ? (
                <CheckIcon className="h-5 w-5 shrink-0 text-muted" />
              ) : (
                <button
                  disabled={!ready || !questId || busyId === questId}
                  onClick={() => questId && claim(questId)}
                  className="shrink-0 rounded-full bg-positive px-4 py-2 text-sm font-semibold text-black disabled:bg-card-light disabled:text-muted"
                >
                  {formatUsdd(step.reward)}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <h2 className="mb-1 mt-6 text-sm font-medium text-muted">Награды за ранги</h2>
      <p className="mb-3 text-sm text-muted">Начисляется автоматически один раз при первом достижении ранга.</p>
      <div className="space-y-2">
        {rankRewards.ladder.map(step => (
          <div
            key={step.name}
            className={`flex items-center gap-3 rounded-2xl border p-3 ${
              step.achieved ? 'border-positive/30 bg-positive/5' : 'border-border bg-card'
            }`}
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-card-light text-lg">
              {rankEmoji(step.name)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{step.name}</div>
              <div className={`text-sm ${step.achieved ? 'text-positive' : 'text-muted'}`}>
                {step.achieved ? `Начислено ${formatUsdd(step.reward)}` : `Награда ${formatUsdd(step.reward)}`}
              </div>
            </div>
            {step.achieved && <CheckIcon className="h-5 w-5 shrink-0 text-positive" />}
          </div>
        ))}
      </div>
    </div>
  );
}
