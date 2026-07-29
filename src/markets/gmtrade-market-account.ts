import { anchorDiscriminator } from '../codec/anchor';
import { base58Encode } from '../codec/base58';

export const GMTRADE_MARKET_ACCOUNT_DISCRIMINATOR = anchorDiscriminator('account', 'Market');
export const GMTRADE_MARKET_ACCOUNT_PREFIX_LENGTH = 248;

export interface DecodedGmTradeMarketAccount {
  marketAccountAddress: string;
  version: number;
  enabled: boolean;
  name: string;
  marketTokenMint: string;
  indexTokenMint: string;
  longTokenMint: string;
  shortTokenMint: string;
  store: string;
}

function equalPrefix(value: Uint8Array, prefix: Uint8Array): boolean {
  if (value.length < prefix.length) return false;
  return prefix.every((byte, index) => value[index] === byte);
}

function pubkey(data: Uint8Array, offset: number): string {
  const bytes = data.slice(offset, offset + 32);
  if (bytes.length !== 32) throw new Error(`GMTrade market account is truncated at ${offset}`);
  return base58Encode(bytes);
}

function fixedString(data: Uint8Array, offset: number, length: number): string {
  const bytes = data.slice(offset, offset + length);
  const zero = bytes.indexOf(0);
  return Buffer.from(zero >= 0 ? bytes.slice(0, zero) : bytes).toString('utf8').trim();
}

/**
 * Decode only the stable prefix of GMTrade's zero-copy Market account.
 * Prefix layout after the 8-byte Anchor discriminator:
 * version/bump/flags/padding, timestamp, 64-byte name, MarketMeta, store.
 */
export function decodeGmTradeMarketAccount(
  marketAccountAddress: string,
  data: Uint8Array,
): DecodedGmTradeMarketAccount {
  if (data.length < GMTRADE_MARKET_ACCOUNT_PREFIX_LENGTH) {
    throw new Error(
      `GMTrade Market account ${marketAccountAddress} has ${data.length} bytes; expected at least ${GMTRADE_MARKET_ACCOUNT_PREFIX_LENGTH}`,
    );
  }
  if (!equalPrefix(data, GMTRADE_MARKET_ACCOUNT_DISCRIMINATOR)) {
    throw new Error(`Account ${marketAccountAddress} is not a GMTrade Market account`);
  }

  const flags = data[10] ?? 0;
  return {
    marketAccountAddress,
    version: data[8] ?? 0,
    enabled: (flags & 1) !== 0,
    name: fixedString(data, 24, 64),
    marketTokenMint: pubkey(data, 88),
    indexTokenMint: pubkey(data, 120),
    longTokenMint: pubkey(data, 152),
    shortTokenMint: pubkey(data, 184),
    store: pubkey(data, 216),
  };
}

export function normalizeGmTradePair(name: string, indexTokenMint: string): string {
  const cleaned = name
    .replace(/\0/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .trim()
    .toUpperCase();
  const first = cleaned.split(/\s+/)[0] ?? '';
  if (/^[A-Z0-9.]+\/(USD|USDC|USDT)$/.test(first)) {
    return `${first.split('/')[0]}/USD`;
  }
  if (/^[A-Z0-9.]+-(USD|USDC|USDT)$/.test(first)) {
    return `${first.split('-')[0]}/USD`;
  }
  const symbol = first.match(/^[A-Z][A-Z0-9.]{1,15}/)?.[0];
  return symbol ? `${symbol}/USD` : `unknown:${indexTokenMint}`;
}

export function pairSymbol(pair: string): string | null {
  const match = /^([A-Za-z0-9.]+)\/(?:USD|USDC|USDT)$/.exec(pair);
  return match?.[1]?.toUpperCase() ?? null;
}
