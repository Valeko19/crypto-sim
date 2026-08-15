import { EngineState } from './state.js';
import { buyWithUsdd, sellCoin, price } from './amm.js';
import { COIN_MAP, tradeFeePct, MIN_TRADE_USDD } from '../config/coins.js';
import { ensurePlayerExists, getPlayer, applyBuy, applySell, getHolding, reservedStakedAmount } from '../db/queries.js';
import { recordTradeVolume } from './dailyVolume.js';

export class TradeError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface TradeParams {
  coinId: string;
  side: 'buy' | 'sell';
  amountUsdd?: number;
  amountCoin?: number;
  // Sell only: the client's sell slider was at exactly 100% (regardless of
  // which unit it's displaying). Tells the server to use ITS OWN current
  // sellable balance directly instead of reconstructing an amount from
  // amountUsdd/amountCoin — for amountUsdd specifically, that reconstruction
  // divides by the live pool price, so if price ticks between when the
  // player dragged the slider and when this request lands, the recovered
  // coin amount drifts from their real holding (under-sells and leaves dust,
  // or tries to over-sell and gets clamped). useMax sidesteps that entirely.
  useMax?: boolean;
}

// Single implementation of a trade, shared by the manual POST /trade route
// and the trading-bot background job — the bot must inherit the exact same
// fee/slippage/reserve behavior, not a second copy of it.
export async function executeTrade(state: EngineState, playerId: string, params: TradeParams) {
  return withPlayerLock(playerId, () => executeTradeUnlocked(state, playerId, params));
}

async function executeTradeUnlocked(state: EngineState, playerId: string, params: TradeParams) {
  const { coinId, side, amountUsdd, amountCoin, useMax } = params;
  const cs = state.coins[coinId];
  const cfg = COIN_MAP[coinId];
  if (!cs || !cfg) throw new TradeError('coin not found', 404);

  // Runs both from the /trade route (already ensured by the auth middleware)
  // and the trading-bot background job (outside any request/handshake, where
  // the real username isn't known) — must self-ensure without ever touching
  // username, so it can't clobber a real Telegram name with a placeholder.
  await ensurePlayerExists(playerId);
  const player = await getPlayer(playerId);

  if (side === 'buy') {
    const usddIn = Number(amountUsdd);
    if (!usddIn || usddIn < MIN_TRADE_USDD) throw new TradeError(`minimum trade is ${MIN_TRADE_USDD} USDD`);
    if (usddIn > player.usdd_balance) throw new TradeError('insufficient balance');
    const fee = usddIn * tradeFeePct(coinId);
    const netIn = usddIn - fee;
    const result = buyWithUsdd(cs.pool, netIn);
    // buyWithUsdd's own MAX_RESERVE_FRACTION cap can execute LESS than the
    // requested netIn (result.usddAmount < netIn on a very large trade against
    // a thin pool) — scale the fee down by the same executed fraction and
    // charge the player only for what actually happened, never for the
    // untouched leftover of their original request.
    const executedFraction = netIn > 0 ? result.usddAmount / netIn : 1;
    const actualFee = fee * executedFraction;
    const totalCharged = result.usddAmount + actualFee;
    await applyBuy(playerId, coinId, result.coinAmount, totalCharged, result.avgPrice);
    cs.playerOwnedCoins += result.coinAmount;
    recordTradeVolume(playerId, totalCharged);
    return { ...result, fee: actualFee };
  } else if (side === 'sell') {
    const holding = await getHolding(playerId, coinId);
    if (!holding || holding.amount <= 0) throw new TradeError('no holding to sell');
    const reserved = await reservedStakedAmount(playerId, coinId);
    const sellable = holding.amount - reserved;
    let coinIn: number;
    if (useMax) {
      coinIn = sellable;
    } else if (amountCoin != null) {
      coinIn = Number(amountCoin);
    } else {
      coinIn = Number(amountUsdd) / price(cs.pool);
    }
    if (coinIn > sellable) throw new TradeError('coins are staked and cannot be sold');
    coinIn = Math.min(coinIn, sellable);
    if (coinIn <= 0) throw new TradeError('invalid amount');
    const result = sellCoin(cs.pool, coinIn);
    const fee = result.usddAmount * tradeFeePct(coinId);
    const netOut = result.usddAmount - fee;
    // sellCoin can itself cap coinIn via MAX_RESERVE_FRACTION — result.coinAmount
    // is what actually entered the pool, which can be less than the requested
    // coinIn. Must remove exactly that much from the holding, not the
    // originally-requested coinIn, or the player loses coins that were never
    // actually sold.
    await applySell(playerId, coinId, result.coinAmount, netOut, result.avgPrice);
    cs.playerOwnedCoins = Math.max(0, cs.playerOwnedCoins - result.coinAmount);
    recordTradeVolume(playerId, netOut);
    return { ...result, usddAmount: netOut, fee };
  }
  throw new TradeError('side must be buy or sell');
}

// Serializes trades per player so a manual /trade request and a bot-fired
// trade for the same player can't interleave their read-then-write DB calls
// (applyBuy/applySell) — there are no SQL transactions in this project, so
// this promise-chaining mutex is the cheap way to close that window.
const playerLocks = new Map<string, Promise<unknown>>();

function withPlayerLock<T>(playerId: string, fn: () => Promise<T>): Promise<T> {
  const prior = playerLocks.get(playerId) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  playerLocks.set(playerId, result.catch(() => {}));
  return result;
}
