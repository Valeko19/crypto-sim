import { EngineState } from './state.js';
import { executeTrade, StaleBotFiringError } from './trade.js';
import { MarketUnavailableError } from './marketRecovery.js';
import { COIN_MAP } from '../config/coins.js';
import { MIN_BOT_INTERVAL_MS } from '../config/tradingBot.js';
import { getAllEnabledTradingBots, advanceBotNextRunIfDue, prunePriorBotTradeRequests } from '../db/queries.js';

// Fires enabled bots through the same executeTrade path as manual trades. The
// captured due timestamp is revalidated under the DB row lock before execution.
export async function runTradingBots(state: EngineState): Promise<void> {
  const bots = await getAllEnabledTradingBots();
  const now = Date.now();
  for (const bot of bots) {
    // Older API versions could persist malformed config. Leave it replaceable
    // through /bot/config, but never execute or reschedule invalid rows.
    // Legacy finite intervals need not match the new UI-only input whitelist.
    if (typeof bot.coin_id !== 'string' || !Object.prototype.hasOwnProperty.call(COIN_MAP, bot.coin_id)
      || (bot.side !== 'buy' && bot.side !== 'sell')
      || typeof bot.amount !== 'number' || !Number.isFinite(bot.amount) || bot.amount <= 0
      || typeof bot.interval_ms !== 'number' || !Number.isSafeInteger(bot.interval_ms)
      || bot.interval_ms < MIN_BOT_INTERVAL_MS || !Number.isFinite(new Date(now + bot.interval_ms).getTime())
      || !Number.isFinite(new Date(bot.next_run_at!).getTime())) continue;
    if (!bot.next_run_at || new Date(bot.next_run_at).getTime() > now) continue;
    const scheduledAt = new Date(bot.next_run_at).toISOString();
    // Keep time first for the existing chronological request pruning; UUID
    // separates different runs even when their scheduled timestamps coincide.
    const requestId = `bot:${scheduledAt}:${bot.run_id}`;
    let replayed = false;
    try {
      const result = await executeTrade(state, bot.player_id, {
        coinId: bot.coin_id!,
        side: bot.side!,
        ...(bot.side === 'buy' ? { amountUsdd: bot.amount! } : { amountCoin: bot.amount! }),
        requestId,
        botFiring: { runId: bot.run_id, scheduledAt, intervalMs: bot.interval_ms! },
      });
      replayed = result.replayed;
    } catch (error) {
      if (error instanceof MarketUnavailableError) continue;
      if (error instanceof StaleBotFiringError) continue;
      // insufficient balance/holding, coin not found, below MIN_TRADE_USDD, etc.
      // — skip this firing, never let it propagate out of the loop.
      const rescheduled = await advanceBotNextRunIfDue(bot.player_id, bot.interval_ms!, scheduledAt, bot.run_id).catch(() => false);
      if (rescheduled) await prunePriorBotTradeRequests(bot.player_id, requestId).catch(() => {});
      continue;
    }
    if (replayed) {
      const rescheduled = await advanceBotNextRunIfDue(bot.player_id, bot.interval_ms!, scheduledAt, bot.run_id).catch(() => false);
      if (rescheduled) await prunePriorBotTradeRequests(bot.player_id, requestId).catch(() => {});
    } else {
      await prunePriorBotTradeRequests(bot.player_id, requestId).catch(() => {});
    }
  }
}
