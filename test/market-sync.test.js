const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Platform } = require('../dist/domain/enums');
const { MarketRegistryService } = require('../dist/services/market-registry.service');
const { MarketSyncService } = require('../dist/services/market-sync.service');
const { GMTRADE_PROGRAM_ID } = require('../dist/platforms/gmtrade/constants');

const silentLogger = { info() {}, warn() {}, error() {} };

test('AUTO_SYNC_MARKETS refreshes dynamic GMTrade metadata and preserves manual overrides', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-market-sync-'));
  const file = path.join(dir, 'markets.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2025-01-01T00:00:00Z',
    sources: {},
    markets: [
      { platform: Platform.GMTRADE,marketAddress: 'manual-market',pair: 'MANUAL/USD',source: 'manual' },
      { platform: Platform.GMTRADE,marketAddress: 'stale-market',pair: 'STALE/USD',source: 'rpcDiscovery' },
    ],
  }));
  const registry = new MarketRegistryService(file);
  let calls = 0;
  const discovery = {
    async discover() {
      calls += 1;
      return {
        definitions: [
          { platform: Platform.GMTRADE,marketAddress: 'fresh-market',pair: 'FRESH/USD',source: 'rpcDiscovery',enabled: true },
        ],
        warnings: [],
        metadata: {
          type: 'rpcDiscovery',programId: GMTRADE_PROGRAM_ID,generatedAt: '2026-07-14T00:00:00Z',rpcUrl: 'https://rpc.invalid',marketCount: 1,
        },
      };
    },
  };
  const service = new MarketSyncService(registry, discovery, silentLogger);
  await service.ensureReady(Platform.GMTRADE, true);
  assert.equal(calls, 1);
  assert.deepEqual(
    registry.listPlatform(Platform.GMTRADE).map((item) => item.marketAddress).sort(),
    ['fresh-market', 'manual-market'],
  );
});
