export const FIXED_6_DECIMALS = 6;
export const FIXED_6_SCALE = 1_000_000n;

export function pow10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) throw new Error(`Invalid decimal count: ${decimals}`);
  return 10n ** BigInt(decimals);
}

export function rescale(value: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return value;
  return fromDecimals > toDecimals ? value / pow10(fromDecimals - toDecimals) : value * pow10(toDecimals - fromDecimals);
}

export function fixed6FromRaw(value: bigint, decimals: number): bigint {
  return rescale(value, decimals, FIXED_6_DECIMALS);
}

export function rawAmountTimesUnitPriceToE6(amount: bigint, unitPrice: bigint, priceDecimals: number): bigint {
  return rescale(amount * unitPrice, priceDecimals, FIXED_6_DECIMALS);
}

export function unitPriceToTokenPriceE6(unitPrice: bigint, tokenDecimals: number, priceDecimals: number): bigint {
  return rescale(unitPrice * pow10(tokenDecimals), priceDecimals, FIXED_6_DECIMALS);
}

export function ratioFixed6(numeratorE6: bigint, denominatorE6: bigint): bigint {
  return denominatorE6 > 0n ? (numeratorE6 * FIXED_6_SCALE) / denominatorE6 : 0n;
}

export function fixed6ToNumber(value: bigint): number {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const digits = absolute.toString().padStart(7, '0');
  const number = Number(`${negative ? '-' : ''}${digits.slice(0, -6) || '0'}.${digits.slice(-6)}`);
  if (!Number.isFinite(number)) throw new Error(`Fixed value is outside JavaScript numeric range: ${value}`);
  return number;
}

export function numberToFixed6(value: number): bigint {
  if (!Number.isFinite(value)) throw new Error(`Cannot convert non-finite value: ${value}`);
  return BigInt(Math.round(value * 1_000_000));
}

export function absBigInt(value: bigint): bigint { return value < 0n ? -value : value; }
