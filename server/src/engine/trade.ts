import { createHash } from 'node:crypto';
import { EngineState } from './state.js';
import { Pool, TradeResult, buyWithUsdd, sellCoin, quoteSellExecution, price, isFinitePositiveAmount, limitPoolSupply } from './amm.js';
import { COIN_MAP, tradeFeePct, MIN_TRADE_USDD } from '../config/coins.js';
import {
  ensurePlayerExists, getPlayer, applyBuy, applySell, getHolding, reservedStakedAmount,
  reserveTradeRequest, getTradeRequest, saveTradeRequestResponse, savePoolSnapshotWithClient,
  isCurrentDueBotFiring, settleBotFiring,
  getTotalHeldForCoin,
} from '../db/queries.js';
import { recordTradeVolume, utcDay } from './dailyVolume.js';
import { marketTransaction, withMarketState } from './marketRecovery.js';
import { saveValuationPrices, recordRankPeaks } from '../db/rankValuation.js';
import { calculateBuyCharge } from './buyBudget.js';

export class TradeError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export class StaleBotFiringError extends Error {
  constructor() {
    super('bot firing is no longer current');
  }
}

export interface BotFiring {
  scheduledAt: string;
  intervalMs: number;
}

export interface TradeParams {
  coinId: string;
  side: 'buy' | 'sell';
  requestId?: string;
  botFiring?: BotFiring;
  amountUsdd?: number;
  amountCoin?: number;
  // BUY: use the current server-side USDD balance as the inclusive budget.
  // SELL: the client's sell slider was at exactly 100% (regardless of
  // which unit it's displaying). Tells the server to use ITS OWN current
  // sellable balance directly instead of reconstructing an amount from
  // amountUsdd/amountCoin — for amountUsdd specifically, that reconstruction
  // divides by the live pool price, so if price ticks between when the
  // player dragged the slider and when this request lands, the recovered
  // coin amount drifts from their real holding (under-sells and leaves dust,
  // or tries to over-sell and gets clamped). useMax sidesteps that entirely.
  useMax?: boolean;
}

type TradeResponse = TradeResult & { fee: number; totalCharged?: number };
export type ExecutedTradeResult = TradeResponse & { replayed: boolean };

// Single implementation of a trade, shared by the manual POST /trade route
// and the trading-bot background job — the bot must inherit the exact same
// fee/slippage/reserve behavior, not a second copy of it.
export async function executeTrade(state: EngineState, playerId: string, params: TradeParams): Promise<ExecutedTradeResult> {
  return withPlayerLock(playerId, () => withMarketState(state, () => executeTradeUnlocked(state, playerId, params)));
}

async function executeTradeUnlocked(state: EngineState, playerId: string, params: TradeParams) {
  const { coinId, side, amountUsdd, amountCoin, useMax, requestId, botFiring } = params;
  const cs = state.coins[coinId];
  const cfg = COIN_MAP[coinId];
  if (!cs || !cfg) throw new TradeError('coin not found', 404);
  if (side !== 'buy' && side !== 'sell') throw new TradeError('side must be buy or sell');
  if (useMax !== undefined && typeof useMax !== 'boolean') throw new TradeError('invalid amount');
  if (amountUsdd !== undefined && !isFinitePositiveAmount(amountUsdd)) throw new TradeError('invalid amount');
  if (amountCoin !== undefined && !isFinitePositiveAmount(amountCoin)) throw new TradeError('invalid amount');
  if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 128)) {
    throw new TradeError('invalid request id');
  }

  let buyAmount: number | undefined;
  let sellCoinAmount: number | undefined;
  let sellUsddAmount: number | undefined;
  if (side === 'buy') {
    if (!useMax) {
      if (!isFinitePositiveAmount(amountUsdd)) throw new TradeError('invalid amount');
      if (amountUsdd < MIN_TRADE_USDD) throw new TradeError(`minimum trade is ${MIN_TRADE_USDD} USDD`);
      buyAmount = amountUsdd;
    }
  } else if (useMax) {
    // Explicit amounts are still validated above even though max sell uses the
    // server's own current sellable balance instead of either client amount.
  } else if (amountCoin !== undefined) {
    sellCoinAmount = amountCoin;
  } else {
    if (amountUsdd === undefined) throw new TradeError('invalid amount');
    sellUsddAmount = amountUsdd;
  }

  // Runs both from the /trade route (already ensured by the auth middleware)
  // and the trading-bot background job (outside any request/handshake, where
  // the real username isn't known) — must self-ensure without ever touching
  // username, so it can't clobber a real Telegram name with a placeholder.
  await ensurePlayerExists(playerId);
  const requestHash = requestId === undefined ? undefined : hashTradeParams({ coinId, side, amountUsdd, amountCoin, useMax });
  const outcome = await marketTransaction(state, async tx => {
    if (botFiring && !await isCurrentDueBotFiring(tx, playerId, botFiring.scheduledAt)) {
      throw new StaleBotFiringError();
    }
    if (requestId !== undefined) {
      const ownsRequest = await reserveTradeRequest(tx, playerId, requestId, requestHash!);
      if (!ownsRequest) {
        const previous = await getTradeRequest(tx, playerId, requestId);
        if (!previous) throw new Error('trade request reservation disappeared');
        if (previous.request_hash !== requestHash) throw new TradeError('request id already used with different parameters', 409);
        if (!previous.response) throw new Error('trade request has no committed response');
        return { replayed: true as const, response: previous.response as TradeResponse };
      }
    }

    if (side === 'buy' && useMax) {
      await tx.query('SELECT id FROM players WHERE id = $1 FOR UPDATE', [playerId]);
    }
    const player = await getPlayer(playerId, tx);
    // Capture once in execution, after lock/replay checks. Publication,
    // recovery and HTTP response timing must never select a different day.
    const executionDay = utcDay();
    const nextPool: Pool = { ...cs.pool };
    const freeFloat = cfg.emission * (1 - cfg.npcLockedPct);
    const ownedBefore = await getTotalHeldForCoin(coinId, tx);
    limitPoolSupply(nextPool, freeFloat, ownedBefore, cfg.startPrice);
    const holdingBefore = await getHolding(playerId, coinId, tx);
    let response: TradeResponse;
    let coinDelta: number;
    let volumeDelta: number;

    if (side === 'buy') {
      const usddIn = useMax ? player.usdd_balance : buyAmount!;
      if (!Number.isFinite(player.usdd_balance)) throw new TradeError('invalid balance');
      if (usddIn < MIN_TRADE_USDD) throw new TradeError(`minimum trade is ${MIN_TRADE_USDD} USDD`);
      if (usddIn > player.usdd_balance) throw new TradeError('insufficient balance');
      const fee = usddIn * tradeFeePct(coinId);
      const netIn = usddIn - fee;
      const result = buyWithUsdd(nextPool, netIn);
      const { fee: actualFee, totalCharged } = calculateBuyCharge(usddIn, tradeFeePct(coinId), result.usddAmount);
      response = { ...result, fee: actualFee, totalCharged };
      coinDelta = result.coinAmount;
      volumeDelta = totalCharged;
      await applyBuy(tx, playerId, coinId, result.coinAmount, totalCharged, result.avgPrice, actualFee);
    } else {
      const holding = await getHolding(playerId, coinId, tx);
      if (!holding || !isFinitePositiveAmount(holding.amount)) throw new TradeError('no holding to sell');
      const reserved = await reservedStakedAmount(playerId, coinId, tx);
      if (!Number.isFinite(reserved) || reserved < 0) throw new TradeError('invalid holding');
      const sellable = holding.amount - reserved;
      let coinIn: number;
      if (useMax) {
        coinIn = sellable;
      } else if (sellCoinAmount !== undefined) {
        coinIn = sellCoinAmount;
      } else {
        const currentPrice = price(nextPool);
        if (!isFinitePositiveAmount(currentPrice)) throw new TradeError('invalid market price');
        coinIn = sellUsddAmount! / currentPrice;
      }
      if (!isFinitePositiveAmount(coinIn) || !isFinitePositiveAmount(sellable)) throw new TradeError('invalid amount');
      if (coinIn > sellable) throw new TradeError('coins are staked and cannot be sold');
      coinIn = Math.min(coinIn, sellable);
      const grossUsddOut = quoteSellExecution(nextPool, coinIn).usddAmount;
      if (grossUsddOut < MIN_TRADE_USDD) {
        throw new TradeError(`minimum trade size is ${MIN_TRADE_USDD} USDD`);
      }
      const result = sellCoin(nextPool, coinIn);
      const fee = result.usddAmount * tradeFeePct(coinId);
      const netOut = result.usddAmount - fee;
      response = { ...result, usddAmount: netOut, fee };
      coinDelta = -result.coinAmount;
      volumeDelta = netOut;
      await applySell(tx, playerId, coinId, result.coinAmount, netOut, result.avgPrice, fee);
    }

    const nextOwned = await getTotalHeldForCoin(coinId, tx);
    const holdingAfter = await getHolding(playerId, coinId, tx);
    if ((holdingAfter?.amount ?? 0) === (holdingBefore?.amount ?? 0)) {
      throw new TradeError('trade below holding precision');
    }
    // The 30% cap always leaves coins in the pool. If the holdings addition
    // rounds up to the entire supply, reject and roll back instead of selling
    // inventory below representable precision or publishing an empty pool.
    if (side === 'buy' && nextOwned >= freeFloat) throw new TradeError('insufficient tradeable supply');
    limitPoolSupply(nextPool, freeFloat, nextOwned, cfg.startPrice);
    response.priceAfter = price(nextPool);
    await recordTradeVolume(tx, playerId, executionDay, volumeDelta);
    await savePoolSnapshotWithClient(tx, coinId, nextPool.coinReserve, nextPool.usddReserve, nextPool.referencePrice);
    await saveValuationPrices(tx, state, { coinId, pool: nextPool });
    await recordRankPeaks(tx);
    if (requestId !== undefined) await saveTradeRequestResponse(tx, playerId, requestId, response);
    if (botFiring) {
      await settleBotFiring(
        tx,
        playerId,
        botFiring.scheduledAt,
        volumeDelta,
        Math.abs(coinDelta),
        new Date(Date.now() + botFiring.intervalMs).toISOString()
      );
    }
    return { replayed: false as const, response, nextPool, nextOwned, coinDelta, volumeDelta };
  }, outcome => {
    if (outcome.replayed) return;
    cs.pool.coinReserve = outcome.nextPool.coinReserve;
    cs.pool.usddReserve = outcome.nextPool.usddReserve;
    if (outcome.nextPool.referencePrice !== undefined) cs.pool.referencePrice = outcome.nextPool.referencePrice;
    else delete cs.pool.referencePrice;
    cs.playerOwnedCoins = outcome.nextOwned;
  });
  return { ...outcome.response, replayed: outcome.replayed };
}

function hashTradeParams(params: Omit<TradeParams, 'requestId'>): string {
  const canonical = JSON.stringify({
    coinId: params.coinId,
    side: params.side,
    amountUsdd: params.amountUsdd ?? null,
    amountCoin: params.amountCoin ?? null,
    useMax: params.useMax ?? false,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// Serializes requests from the same player; withMarketLock separately protects
// the shared pool, tick and persistence lifecycle for all players.
const playerLocks = new Map<string, Promise<unknown>>();

function withPlayerLock<T>(playerId: string, fn: () => Promise<T>): Promise<T> {
  const prior = playerLocks.get(playerId) ?? Promise.resolve();
  const result = prior.then(fn, fn);
  playerLocks.set(playerId, result.catch(() => {}));
  return result;
}
