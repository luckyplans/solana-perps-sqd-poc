import { Platform } from '../domain/enums';
import { MarketRegistrySourceMetadata } from '../domain/models';
import { GmTradeMarketDiscoveryService } from '../markets/gmtrade-market-discovery.service';
import {
  buildJupiterMainnetMarketDefinitions,
  jupiterMarketSourceMetadata,
} from '../markets/jupiter-mainnet';
import { Logger } from '../utils/logger';
import { MarketRegistryService } from './market-registry.service';

export interface MarketSyncResult {
  platform: Platform;
  changed: boolean;
  marketDefinitions: number;
  distinctMarkets: number;
  warnings: string[];
  source: MarketRegistrySourceMetadata | null;
}

export class MarketSyncService {
  constructor(
    private readonly registry: MarketRegistryService,
    private readonly gmtrade: GmTradeMarketDiscoveryService,
    private readonly logger: Logger,
  ) {}

  async sync(
    platforms: Platform[] = [Platform.JUPITER, Platform.GMTRADE],
    input: { force?: boolean; preserveManual?: boolean } = {},
  ): Promise<MarketSyncResult[]> {
    const results: MarketSyncResult[] = [];
    for (const platform of platforms) {
      if (!input.force && this.registry.hasPlatform(platform)) {
        const definitions = this.registry.listPlatform(platform);
        results.push({
          platform,
          changed: false,
          marketDefinitions: definitions.length,
          distinctMarkets: new Set(definitions.map((item) => item.marketAddress)).size,
          warnings: [],
          source: this.registry.source(platform) ?? null,
        });
        continue;
      }
      if (platform === Platform.JUPITER) {
        const generatedAt = new Date().toISOString();
        const definitions = buildJupiterMainnetMarketDefinitions(generatedAt);
        const source = jupiterMarketSourceMetadata(generatedAt);
        this.registry.replacePlatform(
          platform,
          definitions,
          source,
          input.preserveManual ?? true,
        );
        results.push({
          platform,
          changed: true,
          marketDefinitions: definitions.length,
          distinctMarkets: new Set(definitions.map((item) => item.marketAddress)).size,
          warnings: [],
          source,
        });
        continue;
      }
      const discovered = await this.gmtrade.discover();
      this.registry.replacePlatform(
        platform,
        discovered.definitions,
        discovered.metadata,
        input.preserveManual ?? true,
      );
      results.push({
        platform,
        changed: true,
        marketDefinitions: discovered.definitions.length,
        distinctMarkets: new Set(discovered.definitions.map((item) => item.marketAddress)).size,
        warnings: discovered.warnings,
        source: discovered.metadata,
      });
    }
    this.logger.info('market synchronization completed', {
      platforms: results.map((item) => ({
        platform: item.platform,
        changed: item.changed,
        distinctMarkets: item.distinctMarkets,
        warnings: item.warnings.length,
      })),
    });
    return results;
  }

  async ensureReady(platform: Platform, autoSync: boolean): Promise<void> {
    // Jupiter is a reviewed static registry. GMTrade is dynamic, so refresh it
    // before each backfill when AUTO_SYNC_MARKETS is enabled. Manual rows are
    // preserved by replacePlatform().
    if (autoSync && (platform === Platform.GMTRADE || !this.registry.hasPlatform(platform))) {
      await this.sync([platform], { force: true, preserveManual: true });
    }
    if (this.registry.hasPlatform(platform)) return;
    throw new Error(
      `No ${platform} markets are configured. Run "npm run cli -- markets-sync --platform ${platform}" or enable AUTO_SYNC_MARKETS.`,
    );
  }
}
