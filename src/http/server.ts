import { createServer } from 'node:http';
import { URL } from 'node:url';
import { AppContext } from '../app';
import { PerpTradeHistoryOperation, Platform } from '../domain/enums';
import {
  MarketDefinition,
  MarketRegistryDocument,
  MarketRegistrySourceMetadata,
} from '../domain/models';
import { jsonStringify } from '../utils/json';

function parsePlatform(value: string | null | undefined): Platform | undefined {
  if (!value) return undefined;
  const upper = value.toUpperCase();
  if (upper === Platform.GMTRADE || upper === Platform.JUPITER) {
    return upper as Platform;
  }
  throw new Error(`Unsupported platform: ${value}`);
}

function parsePlatforms(value: unknown): Platform[] {
  if (value === undefined || String(value).toUpperCase() === 'ALL') {
    return [Platform.JUPITER, Platform.GMTRADE];
  }
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    const selected = parsePlatform(String(item));
    if (!selected) throw new Error('Platform is required');
    return selected;
  });
}

function parseNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseDate(value: unknown, name: string): Date {
  const parsed = new Date(String(value ?? ''));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be a valid ISO date/time`);
  }
  return parsed;
}

function parseOptionalDate(value: unknown, name: string): Date | undefined {
  return value === undefined ? undefined : parseDate(value, name);
}

async function readBody(request: any): Promise<unknown> {
  let text = '';
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > 2_000_000) throw new Error('Request body is too large');
  }
  return text ? JSON.parse(text) : {};
}

function send(response: any, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  });
  response.end(status === 204 ? '' : jsonStringify(value));
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

export function startHttpServer(app: AppContext): any {
  const server = createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      send(response, 204, null);
      return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, {
          ok: true,
          mode: 'backfill-only',
          historicalProvider: 'sqd-portal',
          portalUrl: app.sqd.url,
          now: new Date().toISOString(),
          platforms: app.adapters.list().map((adapter) => ({
            platform: adapter.platform,
            programId: adapter.programId,
          })),
          configuredMarkets: app.markets.list().length,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/sqd/status') {
        const output: Record<string, unknown> = {
          portalUrl: app.sqd.url,
          metadata: await app.sqd.metadata(),
        };
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        if (from || to) {
          if (!from || !to) throw new Error('from and to must be supplied together');
          output.range = await app.sqdBackfill.resolveRange({
            platform: Platform.JUPITER,
            from: parseDate(from, 'from'),
            to: parseDate(to, 'to'),
          });
        }
        send(response, 200, output);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/stats') {
        send(response, 200, {
          ...app.eventLogs.stats(),
          historicalProvider: 'sqd-portal',
          portalUrl: app.sqd.url,
          marketRegistry: app.markets.document(),
        });
        return;
      }

      if (
        request.method === 'GET'
        && (url.pathname === '/events' || url.pathname === '/event-logs')
      ) {
        const operationValue = url.searchParams.get('operation');
        send(
          response,
          200,
          app.eventLogs.findAll({
            platform: parsePlatform(url.searchParams.get('platform')),
            address: url.searchParams.get('address') ?? undefined,
            positionKey: url.searchParams.get('positionKey') ?? undefined,
            operation: operationValue
              ? (operationValue as PerpTradeHistoryOperation)
              : undefined,
            from: url.searchParams.get('from') ?? undefined,
            to: url.searchParams.get('to') ?? undefined,
            limit: parseNumber(url.searchParams.get('limit')),
            offset: parseNumber(url.searchParams.get('offset')),
            order: url.searchParams.get('order') === 'desc' ? 'desc' : 'asc',
          }),
        );
        return;
      }

      if (request.method === 'GET' && url.pathname === '/leaderboard') {
        send(
          response,
          200,
          app.leaderboard.list({
            platform: parsePlatform(url.searchParams.get('platform')),
            from: url.searchParams.get('from') ?? undefined,
            to: url.searchParams.get('to') ?? undefined,
            limit: parseNumber(url.searchParams.get('limit')),
            offset: parseNumber(url.searchParams.get('offset')),
            minActions: parseNumber(url.searchParams.get('minActions')),
            sortBy: (url.searchParams.get('sortBy') ?? undefined) as
              | 'netPnl'
              | 'volume'
              | 'winRate'
              | undefined,
          }),
        );
        return;
      }

      if (request.method === 'GET' && url.pathname === '/markets') {
        send(response, 200, app.markets.document());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/unknown-markets') {
        send(response, 200, app.eventLogs.unknownMarkets());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/backfills') {
        send(
          response,
          200,
          app.store.listBackfillJobs(parseNumber(url.searchParams.get('limit')) ?? 50),
        );
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/backfills/')) {
        const result = app.store.getBackfillJob(
          url.pathname.slice('/backfills/'.length),
        );
        send(response, result ? 200 : 404, result ?? { error: 'Not found' });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/admin/backfill') {
        const input = objectBody(await readBody(request));
        const selected = parsePlatform(String(input.platform ?? ''));
        if (!selected) throw new Error('platform is required');
        await app.marketSync.ensureReady(
          selected,
          parseBoolean(input.syncMarkets, app.config.autoSyncMarkets),
        );
        const from = parseOptionalDate(input.from, 'from');
        const to = parseOptionalDate(input.to, 'to');
        const backfill = await app.sqdBackfill.run({
          platform: selected,
          from,
          to,
          fromSlot: parseOptionalInteger(input.fromSlot, 'fromSlot'),
          toSlot: parseOptionalInteger(input.toSlot, 'toSlot'),
          batchSlots: parseOptionalInteger(input.batchSlots, 'batchSlots'),
          resume: parseBoolean(input.resume),
        });
        const result: Record<string, unknown> = { backfill };
        if (parseBoolean(input.parquet, app.config.parquetAutoExport)) {
          result.parquet = await app.parquet.run({
            platform: selected,
            from,
            to,
            overwrite: parseBoolean(input.overwriteParquet),
          });
        }
        send(response, 200, result);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/admin/jsonl-import') {
        const input = objectBody(await readBody(request));
        const selected = parsePlatform(String(input.platform ?? ''));
        if (!selected || typeof input.file !== 'string') {
          throw new Error('platform and file are required');
        }
        await app.marketSync.ensureReady(selected, app.config.autoSyncMarkets);
        send(response, 200, await app.jsonlImport.run(selected, input.file));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/admin/markets/sync') {
        const input = objectBody(await readBody(request));
        send(
          response,
          200,
          await app.marketSync.sync(parsePlatforms(input.platforms ?? input.platform), {
            force: parseBoolean(input.force),
            preserveManual: !parseBoolean(input.replaceManual),
          }),
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/admin/parquet-export') {
        const input = objectBody(await readBody(request));
        send(
          response,
          200,
          await app.parquet.run({
            platform: parsePlatform(
              input.platform === undefined ? undefined : String(input.platform),
            ),
            from: input.from === undefined ? undefined : parseDate(input.from, 'from'),
            to: input.to === undefined ? undefined : parseDate(input.to, 'to'),
            outputDir:
              typeof input.outputDir === 'string' ? input.outputDir : undefined,
            overwrite: parseBoolean(input.overwrite),
          }),
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/admin/leaderboard/rebuild') {
        const input = objectBody(await readBody(request));
        send(response, 200, {
          processedDays: app.leaderboard.rebuild(
            input.platform
              ? parsePlatform(String(input.platform))
              : undefined,
          ),
        });
        return;
      }

      if (request.method === 'PUT' && url.pathname === '/admin/markets') {
        const input = await readBody(request);
        if (Array.isArray(input)) {
          app.markets.replace(input as MarketDefinition[]);
        } else {
          const document = objectBody(input) as Partial<MarketRegistryDocument>;
          if (!Array.isArray(document.markets)) {
            throw new Error(
              'Body must be a market array or { markets: [...], sources?: {...} }',
            );
          }
          app.markets.replace(
            document.markets,
            (document.sources ?? {}) as Partial<
              Record<Platform, MarketRegistrySourceMetadata>
            >,
          );
        }
        send(response, 200, app.markets.document());
        return;
      }

      send(response, 404, { error: 'Not found' });
    } catch (error) {
      send(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.listen(app.config.httpPort, app.config.httpHost, () =>
    app.logger.info('HTTP server listening', {
      host: app.config.httpHost,
      port: app.config.httpPort,
      mode: 'backfill-only',
      historicalProvider: 'sqd-portal',
    }),
  );
  return server;
}
