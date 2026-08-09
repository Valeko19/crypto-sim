import { EngineState } from './state.js';
import { buyWithUsdd, sellCoin, price } from './amm.js';
import { COIN_MAP, tradeFeePct, MIN_TRADE_USDD } from '../config/coins.js';
import { ensurePlayerExists, getPlayer, applyBuy, applySell, getHolding, reservedStakedAmount } from '../db/queries.js';

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
}

// Single implementation of a trade, shared by the manual POST /trade route
// and the trading-bot background job — the bot must inherit the exact same
// fee/slippage/reserve behavior, not a second copy of it.
export async function executeTrade(state: EngineState, playerId: string, params: TradeParams) {
  return withPlayerLock(playerId, () => executeTradeUnlocked(state, playerId, params));
}

async function executeTradeUnlocked(state: EngineState, playerId: string, params: TradeParams) {
  const { coinId, side, amountUsdd, amountCoin } = params;
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
    await applyBuy(playerId, coinId, result.coinAmount, usddIn, result.avgPrice);
    cs.playerOwnedCoins += result.coinAmount;
    return { ...result, fee };
  } else if (side === 'sell') {
    const holding = await getHolding(playerId, coinId);
    if (!holding || holding.amount <= 0) throw new TradeError('no holding to sell');
    let coinIn: number;
    if (amountCoin != null) coinIn = Number(amountCoin);
    else coinIn = Number(amountUsdd) / price(cs.pool);
    const reserved = await reservedStakedAmount(playerId, coinId);
    const sellable = holding.amount - reserved;
    if (coinIn > sellable) throw new TradeError('coins are staked and cannot be sold');
    coinIn = Math.min(coinIn, sellable);
    if (coinIn <= 0) throw new TradeError('invalid amount');
    const result = sellCoin(cs.pool, coinIn);
    const fee = result.usddAmount * tradeFeePct(coinId);
    const netOut = result.usddAmount - fee;
    await applySell(playerId, coinId, coinIn, netOut, result.avgPrice);
    cs.playerOwnedCoins = Math.max(0, cs.playerOwnedCoins - coinIn);
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
