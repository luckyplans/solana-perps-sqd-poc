import { Platform } from '../domain/enums';
import { MarketDefinition, MarketRegistrySourceMetadata } from '../domain/models';
import { JUPITER_PROGRAM_ID } from '../platforms/jupiter/constants';

export const JUPITER_CUSTODY_SOURCE_URL =
  'https://github.com/jup-ag/docs/blob/main/perps/custody-account.mdx';

export interface JupiterCustodyDefinition {
  symbol: 'SOL' | 'ETH' | 'BTC' | 'USDC' | 'USDT' | 'JupUSD';
  address: string;
  decimals: number;
  isStable: boolean;
  canBeIndex: boolean;
}

/**
 * Mainnet custody addresses published by Jupiter's official documentation.
 * The event stream references these custody accounts, not token mint addresses.
 */
export const JUPITER_MAINNET_CUSTODIES: readonly JupiterCustodyDefinition[] = [
  {
    symbol: 'SOL',
    address: '7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz',
    decimals: 9,
    isStable: false,
    canBeIndex: true,
  },
  {
    symbol: 'ETH',
    address: 'AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn',
    decimals: 8,
    isStable: false,
    canBeIndex: true,
  },
  {
    symbol: 'BTC',
    address: '5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm',
    decimals: 8,
    isStable: false,
    canBeIndex: true,
  },
  {
    symbol: 'USDC',
    address: 'G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa',
    decimals: 6,
    isStable: true,
    canBeIndex: false,
  },
  {
    symbol: 'USDT',
    address: '4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk',
    decimals: 6,
    isStable: true,
    canBeIndex: false,
  },
  {
    symbol: 'JupUSD',
    address: 'DdwY1ELc9rRK7xNL3hTXabSFBmVrTPpfsUZSv2Y3LL1U',
    decimals: 6,
    isStable: true,
    canBeIndex: false,
  },
] as const;

/**
 * Jupiter events expose both position_custody and position_collateral_custody.
 * A row is generated for each index/collateral combination so collateral token
 * decimals are selected exactly instead of relying on a market-only fallback.
 */
export function buildJupiterMainnetMarketDefinitions(
  verifiedAt = new Date().toISOString(),
): MarketDefinition[] {
  const indexes = JUPITER_MAINNET_CUSTODIES.filter((custody) => custody.canBeIndex);
  const collaterals = [...JUPITER_MAINNET_CUSTODIES].sort((left, right) => {
    if (left.symbol === 'USDC') return -1;
    if (right.symbol === 'USDC') return 1;
    return left.symbol.localeCompare(right.symbol);
  });

  return indexes.flatMap((index) =>
    collaterals.map((collateral): MarketDefinition => ({
      platform: Platform.JUPITER,
      marketAddress: index.address,
      pair: `${index.symbol}/USD`,
      source: 'officialStatic',
      enabled: true,
      verifiedAt,
      indexTokenDecimals: index.decimals,
      collateralAddress: collateral.address,
      collateralTokenDecimals: collateral.decimals,
      collateralIsStable: collateral.isStable,
      collateralUsdPrice: collateral.isStable ? 1 : undefined,
      notes: `Jupiter ${index.symbol} position custody with ${collateral.symbol} collateral custody.`,
    })),
  );
}

export function jupiterMarketSourceMetadata(
  generatedAt = new Date().toISOString(),
): MarketRegistrySourceMetadata {
  return {
    type: 'officialStatic',
    programId: JUPITER_PROGRAM_ID,
    generatedAt,
    sourceUrl: JUPITER_CUSTODY_SOURCE_URL,
    marketCount: JUPITER_MAINNET_CUSTODIES.filter((item) => item.canBeIndex).length,
    notes: `${JUPITER_MAINNET_CUSTODIES.length} documented custodies expanded into exact index/collateral mappings.`,
  };
}
