import { resolve } from 'node:path';
import { createApp } from './app';
import { loadConfig } from './config';
import { PerpTradeHistoryOperation, Platform } from './domain/enums';
import { startHttpServer } from './http/server';

function parseArgs(values: string[]): {
  command: string;
  options: Record<string, string | boolean>;
} {
  const [command = 'help', ...rest] = values;
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index] ?? '';
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { command, options };
}

function platform(value: string | boolean | undefined): Platform {
  const upper = String(value ?? '').toUpperCase();
  if (upper === Platform.GMTRADE || upper === Platform.JUPITER) {
    return upper as Platform;
  }
  throw new Error('--platform must be GMTRADE or JUPITER');
}

function operation(
  value: string | boolean | undefined,
): PerpTradeHistoryOperation | undefined {
  if (value === undefined) return undefined;
  const selected = String(value);
  if (Object.values(PerpTradeHistoryOperation).includes(
    selected as PerpTradeHistoryOperation,
  )) {
    return selected as PerpTradeHistoryOperation;
  }
  throw new Error(
    `--operation must be one of ${Object.values(PerpTradeHistoryOperation).join(', ')}`,
  );
}

function selectedPlatforms(value: string | boolean | undefined): Platform[] {
  if (String(value ?? 'ALL').toUpperCase() === 'ALL') {
    return [Platform.JUPITER, Platform.GMTRADE];
  }
  return [platform(value)];
}

function date(value: string | boolean | undefined, name: string): Date {
  const parsed = new Date(String(value ?? ''));
  if (Number.isNaN(parsed.getTime())) throw new Error(`--${name} must be an ISO date/time`);
  return parsed;
}

function optionalDate(value: string | boolean | undefined, name: string): Date | undefined {
  return value === undefined ? undefined : date(value, name);
}

function integerOption(
  value: string | boolean | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`--${name} must be an integer`);
  return parsed;
}

function booleanOption(
  value: string | boolean | undefined,
  fallback = false,
): boolean {
  if (value === undefined) return fallback;
  if (value === true) return true;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function rangeOptions(options: Record<string, string | boolean>): {
  from?: Date;
  to?: Date;
  fromSlot?: number;
  toSlot?: number;
} {
  return {
    from: optionalDate(options.from, 'from'),
    to: optionalDate(options.to, 'to'),
    fromSlot: integerOption(options['from-slot'], 'from-slot'),
    toSlot: integerOption(options['to-slot'], 'to-slot'),
  };
}

function keepAlive(close: () => void): void {
  const stop = (): void => {
    close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function help(): void {
  console.log(`LuckyPlans Solana perps SQD source-archive POC

Commands:
  markets-sync [--platform ALL|GMTRADE|JUPITER] [--force] [--replace-manual]
  markets-show

  sqd-status [--from ISO --to ISO]

  source-fetch --platform GMTRADE|JUPITER
               (--from ISO --to ISO | --from-slot N --to-slot N)
               [--batch-slots N] [--resume]

  source-verify [--platform GMTRADE|JUPITER] [--from-slot N --to-slot N]
  source-stats [--platform GMTRADE|JUPITER]

  event-build --platform GMTRADE|JUPITER
              [--from ISO --to ISO | --from-slot N --to-slot N]
              [--resume] [--verify-chunks true|false] [--instruction-batch-size N]
              [--sync-markets true|false]

  backfill --platform GMTRADE|JUPITER
           (--from ISO --to ISO | --from-slot N --to-slot N)
           [--batch-slots N] [--resume] [--sync-markets true|false]
           [--parquet] [--overwrite-parquet]

  jsonl-import --platform GMTRADE|JUPITER --file path

  parquet-export [--platform GMTRADE|JUPITER] [--from ISO] [--to ISO]
                 [--out directory] [--overwrite]

  events [--platform GMTRADE|JUPITER] [--address PUBKEY] [--position-key PUBKEY]
         [--operation ACTION] [--from ISO] [--to ISO] [--limit N] [--offset N]
         [--order asc|desc]

  leaderboard [--platform ...] [--from ISO] [--to ISO] [--limit N]
              [--minActions N] [--sortBy netPnl|volume|winRate]
  leaderboard-rebuild [--platform GMTRADE|JUPITER]
  stats
  serve
`);
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const { command, options } = parseArgs(argv);
  if (command === 'help' || command === '--help' || command === '-h') {
    help();
    return;
  }

  const config = loadConfig();
  const app = createApp(config);
  let shouldClose = true;
  try {
    switch (command) {
      case 'serve': {
        const server = startHttpServer(app);
        shouldClose = false;
        keepAlive(() => {
          server.close();
          app.close();
        });
        break;
      }

      case 'markets-sync': {
        const result = await app.marketSync.sync(selectedPlatforms(options.platform), {
          force: booleanOption(options.force),
          preserveManual: !booleanOption(options['replace-manual']),
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'markets-show': {
        console.log(JSON.stringify(app.markets.document(), null, 2));
        break;
      }

      case 'sqd-status': {
        const output: Record<string, unknown> = {
          portalUrl: app.sqd.url,
          metadata: await app.sqd.metadata(),
        };
        if (options.from !== undefined || options.to !== undefined) {
          if (options.from === undefined || options.to === undefined) {
            throw new Error('--from and --to must be supplied together');
          }
          output.range = await app.sourceFetch.resolveRange({
            platform: Platform.JUPITER,
            from: date(options.from, 'from'),
            to: date(options.to, 'to'),
          });
        }
        console.log(JSON.stringify(output, null, 2));
        break;
      }

      case 'source-fetch': {
        const selected = platform(options.platform);
        const result = await app.sourceFetch.run({
          platform: selected,
          ...rangeOptions(options),
          batchSlots: integerOption(options['batch-slots'], 'batch-slots'),
          resume: booleanOption(options.resume),
        });
        console.log(JSON.stringify({ sourceFetch: result, archive: app.sourceChunks.stats(selected) }, null, 2));
        break;
      }

      case 'source-verify': {
        const selected = options.platform ? platform(options.platform) : undefined;
        const manifests = selected
          ? app.sourceChunks.listOverlapping(selected, {
              fromSlot: integerOption(options['from-slot'], 'from-slot'),
              toSlot: integerOption(options['to-slot'], 'to-slot'),
            })
          : app.sourceChunks.list();
        for (const manifest of manifests) app.sourceChunks.verifyManifest(manifest);
        console.log(JSON.stringify({ archiveRoot: config.sourceArchiveDir, verifiedChunks: manifests.length }, null, 2));
        break;
      }

      case 'source-stats': {
        console.log(JSON.stringify(app.sourceChunks.stats(options.platform ? platform(options.platform) : undefined), null, 2));
        break;
      }

      case 'event-build': {
        const selected = platform(options.platform);
        const syncMarkets = booleanOption(options['sync-markets'], config.autoSyncMarkets);
        await app.marketSync.ensureReady(selected, syncMarkets);
        const result = await app.eventBuild.run({
          platform: selected,
          ...rangeOptions(options),
          resume: booleanOption(options.resume),
          verifyChunks: booleanOption(options['verify-chunks'], true),
          instructionBatchSize: integerOption(options['instruction-batch-size'], 'instruction-batch-size')
            ?? config.eventBuildBatchSize,
        });
        console.log(JSON.stringify({ eventBuild: result, storage: { databasePath: config.databasePath, eventCount: app.eventLogs.stats().events } }, null, 2));
        break;
      }

      case 'backfill': {
        const selected = platform(options.platform);
        const syncMarkets = booleanOption(options['sync-markets'], config.autoSyncMarkets);
        await app.marketSync.ensureReady(selected, syncMarkets);
        const range = rangeOptions(options);
        const result = await app.sqdBackfill.run({
          platform: selected,
          ...range,
          batchSlots: integerOption(options['batch-slots'], 'batch-slots'),
          resume: booleanOption(options.resume),
        });
        const output: Record<string, unknown> = {
          backfill: result,
          archive: app.sourceChunks.stats(selected),
          storage: {
            databasePath: config.databasePath,
            eventCount: app.eventLogs.stats().events,
          },
        };
        if (booleanOption(options.parquet, config.parquetAutoExport)) {
          output.parquet = await app.parquet.run({
            platform: selected,
            from: range.from,
            to: range.to,
            overwrite: booleanOption(options['overwrite-parquet']),
          });
        }
        console.log(JSON.stringify(output, null, 2));
        break;
      }

      case 'jsonl-import': {
        const file = options.file;
        if (typeof file !== 'string') throw new Error('--file is required');
        const selected = platform(options.platform);
        await app.marketSync.ensureReady(selected, config.autoSyncMarkets);
        console.log(JSON.stringify(await app.jsonlImport.run(selected, resolve(file)), null, 2));
        break;
      }

      case 'events': {
        console.log(JSON.stringify(app.eventLogs.findAll({
          platform: options.platform ? platform(options.platform) : undefined,
          address: typeof options.address === 'string' ? options.address : undefined,
          positionKey: typeof options['position-key'] === 'string' ? options['position-key'] : undefined,
          operation: operation(options.operation),
          from: typeof options.from === 'string' ? options.from : undefined,
          to: typeof options.to === 'string' ? options.to : undefined,
          limit: integerOption(options.limit, 'limit'),
          offset: integerOption(options.offset, 'offset'),
          order: options.order === 'desc' ? 'desc' : 'asc',
        }), null, 2));
        break;
      }

      case 'leaderboard': {
        console.log(JSON.stringify(app.leaderboard.list({
          platform: options.platform ? platform(options.platform) : undefined,
          from: typeof options.from === 'string' ? options.from : undefined,
          to: typeof options.to === 'string' ? options.to : undefined,
          limit: integerOption(options.limit, 'limit'),
          minActions: integerOption(options.minActions, 'minActions'),
          sortBy: typeof options.sortBy === 'string'
            ? (options.sortBy as 'netPnl' | 'volume' | 'winRate')
            : undefined,
        }), null, 2));
        break;
      }

      case 'leaderboard-rebuild': {
        console.log(JSON.stringify({
          processed: app.leaderboard.rebuild(options.platform ? platform(options.platform) : undefined),
        }));
        break;
      }

      case 'parquet-export': {
        console.log(JSON.stringify(await app.parquet.run({
          platform: options.platform ? platform(options.platform) : undefined,
          from: optionalDate(options.from, 'from'),
          to: optionalDate(options.to, 'to'),
          outputDir: typeof options.out === 'string' ? options.out : undefined,
          overwrite: booleanOption(options.overwrite),
        }), null, 2));
        break;
      }

      case 'stats': {
        console.log(JSON.stringify({
          databasePath: config.databasePath,
          historicalProvider: 'sqd-portal-via-local-source-chunks',
          portalUrl: app.sqd.url,
          sourceArchive: app.sourceChunks.stats(),
          ...app.eventLogs.stats(),
          markets: app.markets.document(),
        }, null, 2));
        break;
      }

      default:
        help();
        process.exitCode = 1;
    }
  } finally {
    if (shouldClose) app.close();
  }
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
