import { SourceChunkStore } from './archive/source-chunk-store';
import { EventBuildService } from './backfill/event-build.service';
import { JsonlImportService } from './backfill/jsonl-import.service';
import { SqdBackfillService } from './backfill/sqd-backfill.service';
import { SqdClient } from './backfill/sqd-client';
import { SqdSourceFetchService } from './backfill/sqd-source-fetch.service';
import { AppConfig } from './config';
import { ParquetExportService } from './export/parquet-export.service';
import { GmTradeMarketDiscoveryService } from './markets/gmtrade-market-discovery.service';
import { PlatformAdapterRegistry } from './platforms/registry';
import { EventLogService } from './services/event-log.service';
import { IngestionService } from './services/ingestion.service';
import { LeaderboardService } from './services/leaderboard.service';
import { MarketRegistryService } from './services/market-registry.service';
import { MarketSyncService } from './services/market-sync.service';
import { SolanaRpcClient } from './solana/rpc-client';
import { SqliteStore } from './storage/sqlite-store';
import { consoleLogger, Logger } from './utils/logger';

export interface AppContext {
  config: AppConfig;
  logger: Logger;
  store: SqliteStore;
  adapters: PlatformAdapterRegistry;
  markets: MarketRegistryService;
  marketSync: MarketSyncService;
  ingestion: IngestionService;
  eventLogs: EventLogService;
  leaderboard: LeaderboardService;
  rpc: SolanaRpcClient;
  sqd: SqdClient;
  sourceChunks: SourceChunkStore;
  sourceFetch: SqdSourceFetchService;
  eventBuild: EventBuildService;
  sqdBackfill: SqdBackfillService;
  parquet: ParquetExportService;
  jsonlImport: JsonlImportService;
  close(): void;
}

export function createApp(
  config: AppConfig,
  logger: Logger = consoleLogger,
): AppContext {
  const store = new SqliteStore(config.databasePath);
  const adapters = new PlatformAdapterRegistry();
  const markets = new MarketRegistryService(config.marketConfigPath);
  const ingestion = new IngestionService(adapters, markets, store, logger);
  const eventLogs = new EventLogService(store);
  const leaderboard = new LeaderboardService(store);
  const rpc = new SolanaRpcClient({
    url: config.solanaRpcHttpUrl,
    commitment: config.solanaCommitment,
    requestRetries: config.solanaRequestRetries,
  });
  const marketSync = new MarketSyncService(
    markets,
    new GmTradeMarketDiscoveryService(rpc, logger),
    logger,
  );
  const jsonlImport = new JsonlImportService(adapters, ingestion);
  const parquet = new ParquetExportService(
    config.databasePath,
    config.parquetOutputDir,
    config.parquetPythonCommand,
    config.parquetBatchSize,
  );
  const sqd = new SqdClient({
    portalUrl: config.sqdPortalUrl,
    requestTimeoutMs: config.sqdRequestTimeoutMs,
    maxRetries: config.sqdMaxRetries,
    retryBaseDelayMs: config.sqdRetryBaseMs,
    retryMaxDelayMs: config.sqdRetryMaxMs,
    requestIntervalMs: config.sqdRequestIntervalMs,
    onRetry: ({ method, path, status, attempt, maxRetries, waitMs, reason }) => {
      logger.warn('SQD Portal request was rate-limited or temporarily unavailable; retrying', {
        method,
        path,
        status,
        attempt,
        maxRetries,
        waitMs,
        reason,
      });
    },
  });
  const sourceChunks = new SourceChunkStore(config.sourceArchiveDir);
  const sourceFetch = new SqdSourceFetchService(
    config.sqdSlotBatchSize,
    sqd,
    adapters,
    sourceChunks,
    store,
    logger,
  );
  const eventBuild = new EventBuildService(
    sourceChunks,
    adapters,
    ingestion,
    store,
    logger,
  );
  const sqdBackfill = new SqdBackfillService(sourceFetch, eventBuild);

  return {
    config,
    logger,
    store,
    adapters,
    markets,
    marketSync,
    ingestion,
    eventLogs,
    leaderboard,
    rpc,
    sqd,
    sourceChunks,
    sourceFetch,
    eventBuild,
    sqdBackfill,
    parquet,
    jsonlImport,
    close() {
      store.close();
    },
  };
}
