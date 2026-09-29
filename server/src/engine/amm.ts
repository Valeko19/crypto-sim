// Constant-product AMM pool (x * y = k), same formula used for both real player
// trades and simulated background "noise" trades so the market feels unified.
export interface Pool {
  coinReserve: number; // x: coins sitting in the pool, available to buy
  usddReserve: number; // y: USDD sitting in the pool
}

export function price(pool: Pool): number {
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

// Guard against a single trade eating too much of the reserve (numerical safety
// and to keep any single order from moving price to absurd extremes).
const MAX_RESERVE_FRACTION = 0.3;

export function buyWithUsdd(pool: Pool, usddIn: number): TradeResult {
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
  if (coinOut > maxCoinOut) {
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
  pool.coinReserve = nextCoinReserve;
  pool.usddReserve = nextUsddReserve;
  return {
    coinAmount: coinOut,
    usddAmount: usddSpent,
    avgPrice,
    priceBefore,
    priceAfter,
    slippagePct,
  };
}

// Unlike buyWithUsdd, this one caps its OWN input (cappedCoinIn) before ever
// deriving usddOut from it, and that same capped value is what both reserves
// get updated with below — so k stays exactly preserved on its own; there is
// no equivalent bug here to fix, just confirming it via the same audit.
export function sellCoin(pool: Pool, coinIn: number): TradeResult {
  if (!isFinitePositiveAmount(coinIn)) throw new RangeError('coin input must be a finite positive number');
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
  pool.coinReserve = nextCoinReserve;
  pool.usddReserve = nextUsddReserve;
  return {
    coinAmount: cappedCoinIn,
    usddAmount: usddOut,
    avgPrice,
    priceBefore,
    priceAfter,
    slippagePct,
  };
}

// Reprice the pool to hit a target price directly, preserving k when
// possible. Used for background "virtual crowd" drift (drift/noise/gravity/
// news/homing) so macro/local cycles can move price through the exact same
// mechanism as a real trade, without a real trade actually happening.
//
// `maxCoinReserve` is the coin's free float (emission * (1 - npcLockedPct)) —
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
  const kk = k(pool);
  let newCoinReserve = Math.sqrt(kk / targetPrice);
  let newUsddReserve = Math.sqrt(kk * targetPrice);
  if (newCoinReserve > maxCoinReserve) {
    newCoinReserve = maxCoinReserve;
    newUsddReserve = targetPrice * maxCoinReserve;
  }
  pool.coinReserve = newCoinReserve;
  pool.usddReserve = newUsddReserve;
}

// Floor on repriceTo's cap, as a fraction of the free float — without this,
// a coin whose already-sold holdings (alreadyHeld) reach or exceed the free
// float clamps straight to 0, and since repriceTo sets BOTH coinReserve and
// usddReserve to that same value when the cap binds, the pool permanently
// locks at coinReserve=0/usddReserve=0 -> price() = 0/0 = NaN forever (no
// later tick can ever recover it, since k=0 stays 0). JSON.stringify turns
// that NaN into null on the wire, which crashed the client's list rendering
// (formatPct/formatCompact calling .toFixed on a null price/changePct).
// Confirmed via a diagnostic script: a coin already inflated past its free
// float by the (now-fixed) unbounded-repriceTo bug hit this exact zero-lock
// on the very first tick after the fix was deployed.
const MIN_POOL_RESERVE_FRACTION = 0.0005;

// Shared by tick.ts (repriceTo's per-tick cap) and index.ts (the boot-time
// snapshot safety net) so both always agree on the same floor — they used to
// compute this independently and drifted out of sync (see MIN_POOL_RESERVE_FRACTION above).
export function maxTradeableReserve(freeFloat: number, alreadyHeld: number): number {
  return Math.max(freeFloat - alreadyHeld, freeFloat * MIN_POOL_RESERVE_FRACTION);
}

export function quoteBuy(pool: Pool, usddIn: number): { coinOut: number; avgPrice: number; priceImpactPct: number } {
  if (!isFinitePositiveAmount(usddIn)) throw new RangeError('USDD input must be a finite positive number');
  const { priceBefore, invariant: kk } = assertValidPool(pool);
  const newUsddReserve = pool.usddReserve + usddIn;
  const newCoinReserve = kk / newUsddReserve;
  const coinOut = pool.coinReserve - newCoinReserve;
  const avgPrice = usddIn / coinOut;
  assertFinitePositiveResult(coinOut, 'quoted coin output');
  assertFinitePositiveResult(avgPrice, 'quoted average price');
  const priceImpactPct = (avgPrice / priceBefore - 1) * 100;
  if (!Number.isFinite(priceImpactPct)) throw new RangeError('price impact must be finite');
  return { coinOut, avgPrice, priceImpactPct };
}

export function quoteSell(pool: Pool, coinIn: number): { usddOut: number; avgPrice: number; priceImpactPct: number } {
  if (!isFinitePositiveAmount(coinIn)) throw new RangeError('coin input must be a finite positive number');
  const { priceBefore, invariant: kk } = assertValidPool(pool);
  const newCoinReserve = pool.coinReserve + coinIn;
  const newUsddReserve = kk / newCoinReserve;
  const usddOut = pool.usddReserve - newUsddReserve;
  const avgPrice = usddOut / coinIn;
  if (!Number.isFinite(usddOut) || usddOut < 0) throw new RangeError('quoted USDD output must be finite and non-negative');
  if (!Number.isFinite(avgPrice)) throw new RangeError('quoted average price must be finite');
  const priceImpactPct = (avgPrice / priceBefore - 1) * 100;
  if (!Number.isFinite(priceImpactPct)) throw new RangeError('price impact must be finite');
  return { usddOut, avgPrice, priceImpactPct };
}
