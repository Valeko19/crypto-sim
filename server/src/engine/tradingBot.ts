import { EngineState } from './state.js';
import { executeTrade, StaleBotFiringError } from './trade.js';
import { MarketUnavailableError } from './marketRecovery.js';
import { getAllEnabledTradingBots, advanceBotNextRunIfDue, prunePriorBotTradeRequests } from '../db/queries.js';

// Fires enabled bots through the same executeTrade path as manual trades. The
// captured due timestamp is revalidated under the DB row lock before execution.
export async function runTradingBots(state: EngineState): Promise<void> {
  const bots = await getAllEnabledTradingBots();
  const now = Date.now();
  for (const bot of bots) {
    if (!bot.next_run_at || new Date(bot.next_run_at).getTime() > now) continue;
    const scheduledAt = new Date(bot.next_run_at).toISOString();
    const requestId = `bot:${scheduledAt}`;
    let replayed = false;
    try {
      const result = await executeTrade(state, bot.player_id, {
        coinId: bot.coin_id!,
        side: bot.side!,
        ...(bot.side === 'buy' ? { amountUsdd: bot.amount! } : { amountCoin: bot.amount! }),
        requestId,
        botFiring: { scheduledAt, intervalMs: bot.interval_ms! },
      });
      replayed = result.replayed;
    } catch (error) {
      if (error instanceof MarketUnavailableError) continue;
      if (error instanceof StaleBotFiringError) continue;
      // insufficient balance/holding, coin not found, below MIN_TRADE_USDD, etc.
      // — skip this firing, never let it propagate out of the loop.
      const rescheduled = await advanceBotNextRunIfDue(bot.player_id, bot.interval_ms!, scheduledAt).catch(() => false);
      if (rescheduled) await prunePriorBotTradeRequests(bot.player_id, requestId).catch(() => {});
      continue;
    }
    if (replayed) {
      const rescheduled = await advanceBotNextRunIfDue(bot.player_id, bot.interval_ms!, scheduledAt).catch(() => false);
      if (rescheduled) await prunePriorBotTradeRequests(bot.player_id, requestId).catch(() => {});
    } else {
      await prunePriorBotTradeRequests(bot.player_id, requestId).catch(() => {});
    }
  }
}
