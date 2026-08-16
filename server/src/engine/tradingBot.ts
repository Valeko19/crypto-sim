import { EngineState } from './state.js';
import { executeTrade } from './trade.js';
import { getAllEnabledTradingBots, advanceBotNextRun, addBotRunTotals } from '../db/queries.js';

// Fires every enabled bot whose next_run_at has elapsed, via the exact same
// executeTrade used by the manual /trade route. Each bot's attempt is wrapped
// in its own try/catch INSIDE the loop (not a single .catch around the whole
// batch) so one player's insufficient balance/holding can never stop the job
// for the others — same isolation style as persistPoolSnapshots in index.ts.
export async function runTradingBots(state: EngineState): Promise<void> {
  const bots = await getAllEnabledTradingBots();
  const now = Date.now();
  for (const bot of bots) {
    if (!bot.next_run_at || new Date(bot.next_run_at).getTime() > now) continue;
    try {
      const result = bot.side === 'buy'
        ? await executeTrade(state, bot.player_id, { coinId: bot.coin_id!, side: 'buy', amountUsdd: bot.amount! })
        : await executeTrade(state, bot.player_id, { coinId: bot.coin_id!, side: 'sell', amountCoin: bot.amount! });
      // result.usddAmount is already the net-received amount for a sell, but
      // for a buy it's the pool-side net-of-fee amount — add the fee back so
      // both sides accumulate the same "total charged/received" volume
      // convention recordTradeVolume uses elsewhere.
      const usddDelta = bot.side === 'buy' ? result.usddAmount + result.fee : result.usddAmount;
      await addBotRunTotals(bot.player_id, usddDelta, result.coinAmount).catch(() => {});
    } catch {
      // insufficient balance/holding, coin not found, below MIN_TRADE_USDD, etc.
      // — skip this firing, never let it propagate out of the loop.
    }
    // Reschedule unconditionally (success, skip, or error) so a persistently
    // failing bot retries once per interval instead of hot-looping every poll.
    await advanceBotNextRun(bot.player_id, bot.interval_ms!).catch(() => {});
  }
}
