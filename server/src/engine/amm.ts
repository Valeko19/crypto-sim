// Constant-product AMM pool (x * y = k), same formula used for both real player
// trades and simulated background "noise" trades so the market feels unified.
import { remainingSupply } from './supply.js';

export interface Pool {
  coinReserve: number; // x: coins sitting in the pool, available to buy
  usddReserve: number; // y: USDD sitting in the pool
  // Quote reference for exhausted liquidity, never tradeable inventory.
  referencePrice?: number;
}

export function price(pool: Pool): number {
  if (pool.coinReserve === 0) return pool.referencePrice ?? 0;
  return pool.usddReserve / pool.coinReserve;
}

export function k(pool: Pool): number {
  return pool.coinReserve * pool.usddReserve;
}

export function isFinitePositiveAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function assertValidPool(pool: Pool): { priceBefore: number; invariant: number } {
  if (!isFinitePositiveAmount(pool.coinReserve) || !isFinitePositiveAmount(pool.usddReserve)) {
    throw new RangeError('AMM reserves must be finite positive numbers');
  }
  const priceBefore = price(pool);
  const invariant = k(pool);
  if (!isFinitePositiveAmount(priceBefore) || !isFinitePositiveAmount(invariant)) {
    throw new RangeError('AMM price and invariant must be finite positive numbers');
  }
  return { priceBefore, invariant };
}

function assertFinitePositiveResult(value: number, label: string): void {
  if (!isFinitePositiveAmount(value)) throw new RangeError(`${label} must be finite and positive`);
}

export interface TradeResult {
  coinAmount: number;
  usddAmount: number;
  avgPrice: number;
  priceBefore: number;
  priceAfter: number;
  slippagePct: number;
}

export interface CappedTradeQuote extends TradeResult {
  requestedInput: number;
  executedInput: number;
  liquidityCapApplied: boolean;
}

interface TradeCalculation {
  result: TradeResult;
  nextCoinReserve: number;
  nextUsddReserve: number;
  executedInput: number;
  liquidityCapApplied: boolean;
}

// Guard against a single trade eating too much of the reserve (numerical safety
// and to keep any single order from moving price to absurd extremes).
const MAX_RESERVE_FRACTION = 0.3;

function calculateBuy(pool: Pool, usddIn: number): TradeCalculation {
  if (!isFinitePositiveAmount(usddIn)) throw new RangeError('USDD input must be a finite positive number');
  const { priceBefore, invariant: kk } = assertValidPool(pool);
  const newUsddReserve = pool.usddReserve + usddIn;
  const newCoinReserve = kk / newUsddReserve;
  let coinOut = pool.coinReserve - newCoinReserve;
  // usddSpent tracks how much of usddIn actually enters the reserve. Normally
  // that's all of it, but when the MAX_RESERVE_FRACTION cap below kicks in,
  // only the fraction of usddIn that corresponds to the capped coinOut (by
  // the SAME constant-product formula, solved in reverse) may enter — adding
  // the full usddIn while only removing the capped coinOut would grow k for
  // free, silently inflating the post-trade price beyond the honest
  // constant-product curve. Whatever's left of usddIn past that point must
  // simply not be spent; callers see the smaller coinOut/usddSpent and charge
  // the player only for what actually executed.
  let usddSpent = usddIn;
  const maxCoinOut = pool.coinReserve * MAX_RESERVE_FRACTION;
  const liquidityCapApplied = coinOut > maxCoinOut;
  if (liquidityCapApplied) {
    coinOut = maxCoinOut;
    const cappedNewCoinReserve = pool.coinReserve - coinOut;
    const cappedNewUsddReserve = kk / cappedNewCoinReserve;
    usddSpent = cappedNewUsddReserve - pool.usddReserve;
  }
  const nextCoinReserve = pool.coinReserve - coinOut;
  const nextUsddReserve = pool.usddReserve + usddSpent;
  assertFinitePositiveResult(nextCoinReserve, 'coin reserve');
  assertFinitePositiveResult(nextUsddReserve, 'USDD reserve');
  const priceAfter = nextUsddReserve / nextCoinReserve;
  assertFinitePositiveResult(priceAfter, 'price');
  const avgPrice = usddSpent / coinOut;
  assertFinitePositiveResult(avgPrice, 'average price');
  const slippagePct = (avgPrice / priceBefore - 1) * 100;
  if (!Number.isFinite(slippagePct)) throw new RangeError('slippage must be finite');
  return {
    result: {
      coinAmount: coinOut,
      usddAmount: usddSpent,
      avgPrice,
      priceBefore,
      priceAfter,
      slippagePct,
    },
    nextCoinReserve,
    nextUsddReserve,
    executedInput: usddSpent,
    liquidityCapApplied,
  };
}

function applyCalculation(pool: Pool, calculation: Pick<TradeCalculation, 'nextCoinReserve' | 'nextUsddReserve'>): void {
  pool.coinReserve = calculation.nextCoinReserve;
  pool.usddReserve = calculation.nextUsddReserve;
}

export function buyWithUsdd(pool: Pool, usddIn: number): TradeResult {
  const calculation = calculateBuy(pool, usddIn);
  applyCalculation(pool, calculation);
  return calculation.result;
}

export function quoteBuyExecution(pool: Pool, usddIn: number): CappedTradeQuote {
  const calculation = calculateBuy(pool, usddIn);
  return {
    ...calculation.result,
    requestedInput: usddIn,
    executedInput: calculation.executedInput,
    liquidityCapApplied: calculation.liquidityCapApplied,
  };
}

// Calculate the capped sell result without mutating the pool. Both execution
// and the minimum-trade guard use this calculation so the guard sees the same
// gross output that will actually enter the pool.
function calculateSell(pool: Pool, coinIn: number): {
  result: TradeResult;
  nextCoinReserve: number;
  nextUsddReserve: number;
  liquidityCapApplied: boolean;
} {
  if (!isFinitePositiveAmount(coinIn)) throw new RangeError('coin input must be a finite positive number');
  if (pool.coinReserve === 0 && pool.usddReserve === 0) {
    const reference = price(pool);
    assertFinitePositiveResult(reference, 'exhausted market price');
    const gross = coinIn * reference;
    assertFinitePositiveResult(gross, 'exhausted SELL output');
    // Exhausted-market transition: the virtual market maker buys real coins
    // at its reference price and seeds matching USDD liquidity. This is the
    // explicit USDD source, like ordinary background repricing; no coins are
    // seeded. A cap relative to the old zero coin inventory cannot apply.
    return {
      result: { coinAmount: coinIn, usddAmount: gross, avgPrice: reference,
        priceBefore: reference, priceAfter: reference, slippagePct: 0 },
      nextCoinReserve: coinIn, nextUsddReserve: gross, liquidityCapApplied: false,
    };
  }
  const { priceBefore, invariant: kk } = assertValidPool(pool);
  const cappedCoinIn = Math.min(coinIn, pool.coinReserve * MAX_RESERVE_FRACTION);
  assertFinitePositiveResult(cappedCoinIn, 'executed coin amount');
  const newCoinReserve = pool.coinReserve + cappedCoinIn;
  const newUsddReserve = kk / newCoinReserve;
  const usddOut = pool.usddReserve - newUsddReserve;
  if (!Number.isFinite(usddOut) || usddOut < 0) throw new RangeError('USDD output must be finite and non-negative');
  const nextCoinReserve = pool.coinReserve + cappedCoinIn;
  const nextUsddReserve = pool.usddReserve - usddOut;
  assertFinitePositiveResult(nextCoinReserve, 'coin reserve');
  assertFinitePositiveResult(nextUsddReserve, 'USDD reserve');
  const priceAfter = nextUsddReserve / nextCoinReserve;
  assertFinitePositiveResult(priceAfter, 'price');
  const avgPrice = usddOut / cappedCoinIn;
  if (!Number.isFinite(avgPrice)) throw new RangeError('average price must be finite');
  const slippagePct = (avgPrice / priceBefore - 1) * 100;
  if (!Number.isFinite(slippagePct)) throw new RangeError('slippage must be finite');
  return {
    result: {
      coinAmount: cappedCoinIn,
      usddAmount: usddOut,
      avgPrice,
      priceBefore,
      priceAfter,
      slippagePct,
    },
    nextCoinReserve,
    nextUsddReserve,
    liquidityCapApplied: cappedCoinIn < coinIn,
  };
}

export function quoteSellExecution(pool: Pool, coinIn: number): CappedTradeQuote {
  const calculation = calculateSell(pool, coinIn);
  return {
    ...calculation.result,
    requestedInput: coinIn,
    executedInput: calculation.result.coinAmount,
    liquidityCapApplied: calculation.liquidityCapApplied,
  };
}

// Unlike buyWithUsdd, this one caps its OWN input before deriving usddOut;
// that exact capped value updates both reserves, preserving x*y=k.
export function sellCoin(pool: Pool, coinIn: number): TradeResult {
  const calculation = calculateSell(pool, coinIn);
  applyCalculation(pool, calculation);
  return calculation.result;
}

// Reprice the pool to hit a target price directly, preserving k when
// possible. Used for background "virtual crowd" drift (drift/noise/gravity/
// news/homing) so macro/local cycles can move price through the exact same
// mechanism as a real trade, without a real trade actually happening.
//
// `maxCoinReserve` is free float minus coins already held by players —
// the pool must never claim to hold more of the tradeable supply than
// actually exists. A FALLING price's constant-product solution
// (sqrt(k/targetPrice)) grows coinReserve without bound, which let it exceed
// the free float on its own with no real trade involved — confirmed in
// practice: a player captured 84.6% of HMFL's emission against a 84.0%
// theoretical ceiling. When the unconstrained solution would exceed the cap,
// clamp coinReserve to it directly and solve usddReserve from targetPrice
// instead of from k — there's no real trade here whose k needs preserving,
// so it's fine to break that invariant only in this clamped case.
export function repriceTo(pool: Pool, targetPrice: number, maxCoinReserve: number): void {
  if (!isFinitePositiveAmount(targetPrice)) throw new RangeError('invalid target price');
  if (!Number.isFinite(maxCoinReserve) || maxCoinReserve < 0) throw new RangeError('invalid supply limit');
  if (maxCoinReserve === 0 || pool.coinReserve === 0 || pool.usddReserve === 0) {
    pool.coinReserve = 0;
    pool.usddReserve = 0;
    pool.referencePrice = targetPrice;
    return;
  }
  const kk = k(pool);
  let newCoinReserve = Math.sqrt(kk / targetPrice);
  let newUsddReserve = Math.sqrt(kk * targetPrice);
  // Preserve ordinary-market rounding, but avoid intermediate k underflow.
  if (!isFinitePositiveAmount(newCoinReserve) || !isFinitePositiveAmount(newUsddReserve)) {
    const rootK = Math.sqrt(pool.coinReserve) * Math.sqrt(pool.usddReserve);
    newCoinReserve = rootK / Math.sqrt(targetPrice);
    newUsddReserve = rootK * Math.sqrt(targetPrice);
  }
  if (newCoinReserve > maxCoinReserve) {
    newCoinReserve = maxCoinReserve;
    newUsddReserve = targetPrice * maxCoinReserve;
  }
  if (!isFinitePositiveAmount(newCoinReserve) || !isFinitePositiveAmount(newUsddReserve)) {
    // Liquidity below representable precision cannot be traded or fabricated.
    pool.coinReserve = 0;
    pool.usddReserve = 0;
    pool.referencePrice = targetPrice;
    return;
  }
  pool.coinReserve = newCoinReserve;
  pool.usddReserve = newUsddReserve;
}

// Shared by ticks and boot recovery. Price references cannot re-issue owned coins.
export function maxTradeableReserve(freeFloat: number, alreadyHeld: number): number {
  return remainingSupply(freeFloat, alreadyHeld);
}

// Also reconcile roundoff after transfers and persisted pools at boot.
export function limitPoolSupply(pool: Pool, freeFloat: number, alreadyHeld: number, fallbackPrice: number): void {
  const available = maxTradeableReserve(freeFloat, alreadyHeld);
  if (pool.coinReserve > available || pool.coinReserve === 0) {
    const currentPrice = price(pool) || fallbackPrice;
    pool.coinReserve = Math.min(pool.coinReserve, available);
    pool.usddReserve = pool.coinReserve * currentPrice;
    if (pool.coinReserve === 0) pool.referencePrice = currentPrice;
  }
}

export function quoteBuy(pool: Pool, usddIn: number): { coinOut: number; avgPrice: number; priceImpactPct: number } {
  const result = quoteBuyExecution(pool, usddIn);
  return { coinOut: result.coinAmount, avgPrice: result.avgPrice, priceImpactPct: result.slippagePct };
}

export function quoteSell(pool: Pool, coinIn: number): { usddOut: number; avgPrice: number; priceImpactPct: number } {
  const result = quoteSellExecution(pool, coinIn);
  return { usddOut: result.usddAmount, avgPrice: result.avgPrice, priceImpactPct: result.slippagePct };
}
