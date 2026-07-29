import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface AppConfig {
  httpHost: string;
  httpPort: number;
  databasePath: string;
  marketConfigPath: string;
  autoSyncMarkets: boolean;
  solanaRpcHttpUrl: string;
  solanaCommitment: 'processed' | 'confirmed' | 'finalized';
  solanaRequestRetries: number;
  sqdPortalUrl: string;
  sourceArchiveDir: string;
  eventBuildBatchSize: number;
  sqdSlotBatchSize: number;
  sqdRequestTimeoutMs: number;
  sqdMaxRetries: number;
  sqdRetryBaseMs: number;
  sqdRetryMaxMs: number;
  sqdRequestIntervalMs: number;
  parquetOutputDir: string;
  parquetPythonCommand: string;
  parquetBatchSize: number;
  parquetAutoExport: boolean;
}

let dotEnvLoaded = false;

function loadDotEnv(): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  const path = resolve(process.env.ENV_FILE ?? '.env');
  if (!existsSync(path)) return;
  const text = String(readFileSync(path, 'utf8'));
  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

function integer(names: string[], fallback: number): number {
  const value = env(...names);
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid integer in ${names.join(' or ')}`);
  return parsed;
}

function boolean(names: string[], fallback: boolean): boolean {
  const value = env(...names);
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function commitment(value: string | undefined): AppConfig['solanaCommitment'] {
  const selected = value ?? 'confirmed';
  if (!['processed', 'confirmed', 'finalized'].includes(selected)) {
    throw new Error(`Invalid SOLANA_COMMITMENT: ${selected}`);
  }
  return selected as AppConfig['solanaCommitment'];
}

export function loadConfig(): AppConfig {
  loadDotEnv();
  return {
    httpHost: env('HTTP_HOST') ?? '127.0.0.1',
    httpPort: integer(['HTTP_PORT', 'PORT'], 3100),
    databasePath: resolve(env('DATABASE_PATH') ?? './data/solana-perps.sqlite'),
    marketConfigPath: resolve(
      env('MARKET_CONFIG_PATH', 'MARKETS_PATH') ?? './config/markets.json',
    ),
    autoSyncMarkets: boolean(['AUTO_SYNC_MARKETS'], true),
    solanaRpcHttpUrl:
      env('SOLANA_RPC_HTTP_URL', 'SOLANA_RPC_URL')
      ?? 'https://api.mainnet-beta.solana.com',
    solanaCommitment: commitment(env('SOLANA_COMMITMENT')),
    solanaRequestRetries: integer(['SOLANA_REQUEST_RETRIES'], 3),
    sqdPortalUrl:
      env('SQD_PORTAL_URL')
      ?? 'https://portal.sqd.dev/datasets/solana-mainnet',
    sourceArchiveDir: resolve(env('SOURCE_ARCHIVE_DIR') ?? './data/source-archive'),
    eventBuildBatchSize: integer(['EVENT_BUILD_BATCH_SIZE'], 1_000),
    sqdSlotBatchSize: integer(['SQD_SLOT_BATCH_SIZE'], 25_000),
    sqdRequestTimeoutMs: integer(['SQD_REQUEST_TIMEOUT_MS'], 120_000),
    sqdMaxRetries: integer(['SQD_MAX_RETRIES'], 10),
    sqdRetryBaseMs: integer(['SQD_RETRY_BASE_MS'], 1_000),
    sqdRetryMaxMs: integer(['SQD_RETRY_MAX_MS'], 30_000),
    sqdRequestIntervalMs: integer(['SQD_REQUEST_INTERVAL_MS'], 650),
    parquetOutputDir: resolve(env('PARQUET_OUTPUT_DIR') ?? './data/parquet'),
    parquetPythonCommand: env('PARQUET_PYTHON_COMMAND') ?? 'python3',
    parquetBatchSize: integer(['PARQUET_BATCH_SIZE'], 100_000),
    parquetAutoExport: boolean(['PARQUET_AUTO_EXPORT'], false),
  };
}
