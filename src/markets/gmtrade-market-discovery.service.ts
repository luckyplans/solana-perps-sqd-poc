import { base58Encode } from '../codec/base58';
import { Platform } from '../domain/enums';
import { MarketDefinition, MarketRegistrySourceMetadata } from '../domain/models';
import { GMTRADE_PROGRAM_ID } from '../platforms/gmtrade/constants';
import { decodeRpcAccountData, SolanaRpcClient } from '../solana/rpc-client';
import { Logger } from '../utils/logger';
import {
  decodeGmTradeMarketAccount,
  GMTRADE_MARKET_ACCOUNT_DISCRIMINATOR,
  GMTRADE_MARKET_ACCOUNT_PREFIX_LENGTH,
  normalizeGmTradePair,
  pairSymbol,
} from './gmtrade-market-account';
import { decodeSplMintDecimals } from './spl-mint';

const SYMBOL_DECIMAL_FALLBACKS: Readonly<Record<string, number>> = {
  SOL: 9,
  BTC: 8,
  ETH: 8,
  USDC: 6,
  USDT: 6,
  JUPUSD: 6,
};

export interface GmTradeMarketDiscoveryResult {
  definitions: MarketDefinition[];
  metadata: MarketRegistrySourceMetadata;
  warnings: string[];
}

export class GmTradeMarketDiscoveryService {
  constructor(
    private readonly rpc: SolanaRpcClient,
    private readonly logger: Logger,
  ) {}

  async discover(): Promise<GmTradeMarketDiscoveryResult> {
    const generatedAt = new Date().toISOString();
    const rows = await this.rpc.getProgramAccounts(GMTRADE_PROGRAM_ID, {
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: base58Encode(GMTRADE_MARKET_ACCOUNT_DISCRIMINATOR),
          },
        },
      ],
      dataSlice: { offset: 0, length: GMTRADE_MARKET_ACCOUNT_PREFIX_LENGTH },
    });

    const decoded = rows.map((row) =>
      decodeGmTradeMarketAccount(row.pubkey, decodeRpcAccountData(row.account)),
    );

    if (decoded.length === 0) {
      throw new Error(
        `GMTrade market discovery returned zero Market accounts from ${this.rpc.url}`,
      );
    }

    const mintAddresses = [...new Set(decoded.flatMap((market) => [
      market.indexTokenMint,
      market.longTokenMint,
      market.shortTokenMint,
    ]))];
    const mintAccounts = await this.rpc.getMultipleAccounts(mintAddresses, {
      dataSlice: { offset: 0, length: 82 },
    });
    const decimals = new Map<string, number>();
    const warnings: string[] = [];
    mintAddresses.forEach((address, index) => {
      const account = mintAccounts[index];
      if (!account) return;
      try {
        decimals.set(address, decodeSplMintDecimals(decodeRpcAccountData(account)));
      } catch (error) {
        warnings.push(
          `Could not decode mint decimals for ${address}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    const definitions = decoded.map((market): MarketDefinition => {
      const pair = normalizeGmTradePair(market.name, market.indexTokenMint);
      const symbol = pairSymbol(pair);
      const indexTokenDecimals = decimals.get(market.indexTokenMint)
        ?? (symbol ? SYMBOL_DECIMAL_FALLBACKS[symbol] : undefined);
      const longCollateralTokenDecimals = decimals.get(market.longTokenMint);
      const shortCollateralTokenDecimals = decimals.get(market.shortTokenMint);

      if (indexTokenDecimals === undefined) {
        warnings.push(
          `No decimals found for GMTrade index token ${market.indexTokenMint} (${market.name}); price will be marked partial.`,
        );
      }
      if (longCollateralTokenDecimals === undefined) {
        warnings.push(`No decimals found for GMTrade long collateral mint ${market.longTokenMint}.`);
      }
      if (shortCollateralTokenDecimals === undefined) {
        warnings.push(`No decimals found for GMTrade short collateral mint ${market.shortTokenMint}.`);
      }

      return {
        platform: Platform.GMTRADE,
        marketAddress: market.marketTokenMint,
        marketAccountAddress: market.marketAccountAddress,
        indexTokenAddress: market.indexTokenMint,
        pair,
        source: 'rpcDiscovery',
        enabled: market.enabled,
        verifiedAt: generatedAt,
        indexTokenDecimals,
        longCollateralAddress: market.longTokenMint,
        longCollateralTokenDecimals,
        shortCollateralAddress: market.shortTokenMint,
        shortCollateralTokenDecimals,
        notes: `GMTrade market name=${JSON.stringify(market.name)} store=${market.store} version=${market.version}`,
      };
    });

    this.logger.info('discovered GMTrade markets', {
      rpcUrl: this.rpc.url,
      accounts: rows.length,
      enabled: definitions.filter((item) => item.enabled !== false).length,
      disabled: definitions.filter((item) => item.enabled === false).length,
      warnings: warnings.length,
    });

    return {
      definitions,
      warnings,
      metadata: {
        type: 'rpcDiscovery',
        programId: GMTRADE_PROGRAM_ID,
        generatedAt,
        rpcUrl: this.rpc.url,
        marketCount: definitions.length,
        notes: warnings.length
          ? `${warnings.length} metadata warning(s); see markets sync output.`
          : 'Decoded all zero-copy Market accounts, including disabled historical markets, and SPL mint decimals.',
      },
    };
  }
}
