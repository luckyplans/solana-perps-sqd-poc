const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PlatformAdapterRegistry } = require('../dist/platforms/registry');
const { MarketRegistryService } = require('../dist/services/market-registry.service');
const { IngestionService } = require('../dist/services/ingestion.service');
const { SqliteStore } = require('../dist/storage/sqlite-store');
const { ParquetExportService } = require('../dist/export/parquet-export.service');
const { Platform, IngestionSource } = require('../dist/domain/enums');
const { JUPITER_PROGRAM_ID } = require('../dist/platforms/jupiter/constants');
const { key, jupiterIncrease } = require('./helpers');

const silentLogger = { info() {}, warn() {}, error() {} };

test('Parquet exporter writes compact canonical actions without raw decoded JSON', async (t) => {
  const pyarrow = spawnSync('python3', ['-c', 'import pyarrow'], { encoding: 'utf8' });
  if (pyarrow.status !== 0) {
    t.skip('pyarrow is not installed; run npm run parquet:install');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-parquet-'));
  const database = path.join(dir, 'data.sqlite');
  const marketFile = path.join(dir, 'markets.json');
  const output = path.join(dir, 'parquet');
  const market = key(120);
  const collateral = key(121);
  const owner = key(122);
  const position = key(123);
  const positionMint = key(124);
  const request = key(125);
  const requestMint = key(126);
  const pool = key(127);
  fs.writeFileSync(
    marketFile,
    JSON.stringify([
      {
        platform: Platform.JUPITER,
        marketAddress: market.address,
        pair: 'SOL/USD',
        collateralAddress: collateral.address,
        collateralTokenDecimals: 6,
        collateralIsStable: true,
      },
    ]),
  );
  const store = new SqliteStore(database);
  t.after(() => store.close());
  const ingestion = new IngestionService(
    new PlatformAdapterRegistry(),
    new MarketRegistryService(marketFile),
    store,
    silentLogger,
  );
  const data = jupiterIncrease({
    position,
    isLong: true,
    market,
    collateral,
    positionSizeUsd: 10_000_000n,
    positionMint,
    request,
    requestMint,
    owner,
    pool,
    sizeDeltaUsd: 10_000_000n,
    collateralDeltaUsd: 1_000_000n,
    price: 100_000_000n,
    feeUsd: 1_000n,
    openTime: 1_750_000_000n,
  });
  const result = await ingestion.processInstruction({
    platform: Platform.JUPITER,
    programId: JUPITER_PROGRAM_ID,
    ingestionSource: IngestionSource.JSONL,
    signature: 'parquet-test',
    slot: 1,
    blockTime: new Date('2025-06-15T00:00:00Z'),
    outerInstructionIndex: 1,
    innerInstructionIndex: 1,
    data,
  });
  assert.equal(result.status, 'inserted');

  const exporter = new ParquetExportService(database, output, 'python3', 1000);
  const summary = await exporter.run({ overwrite: true });
  assert.equal(summary.rows, 1);
  assert.equal(summary.files.length, 1);
  const file = summary.files[0].path;
  assert.equal(fs.existsSync(file), true);

  const inspect = spawnSync(
    'python3',
    [
      '-c',
      [
        'import json,pyarrow.parquet as pq,sys',
        't=pq.read_table(sys.argv[1])',
        'print(json.dumps({"rows":t.num_rows,"columns":t.column_names}))',
      ].join(';'),
      file,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(inspect.status, 0, inspect.stderr);
  const metadata = JSON.parse(inspect.stdout);
  assert.equal(metadata.rows, 1);
  assert.equal(metadata.columns.includes('decoded_event_json'), false);
  assert.equal(metadata.columns.includes('operation'), true);
  assert.equal(metadata.columns.includes('usd_pnl'), true);
});
