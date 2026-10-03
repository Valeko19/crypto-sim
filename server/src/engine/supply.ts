// Exact arithmetic over the binary64 amounts actually persisted in holdings.
// One unit is the smallest positive double (2^-1074). No supply epsilon.
function units(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('invalid supply amount');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  return exponent === 0 ? fraction : ((1n << 52n) + fraction) << BigInt(exponent - 1);
}

function fromUnits(value: bigint, roundUp: boolean): number {
  if (value === 0n) return 0;
  const shift = Math.max(0, value.toString(2).length - 53);
  const divisor = 1n << BigInt(shift);
  const significand = (value + (roundUp ? divisor - 1n : 0n)) / divisor;
  const result = Number(significand) * 2 ** (shift - 1074);
  if (!Number.isFinite(result)) throw new RangeError('supply overflow');
  return result;
}

export function holdingsUpperBound(amounts: number[]): number {
  return fromUnits(amounts.reduce((sum, amount) => sum + units(amount), 0n), true);
}

export function remainingSupply(freeFloat: number, ownedUpperBound: number): number {
  const remaining = units(freeFloat) - units(ownedUpperBound);
  return remaining <= 0n ? 0 : fromUnits(remaining, false);
}
