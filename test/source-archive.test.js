const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SourceChunkStore } = require('../dist/archive/source-chunk-store');
const { EventBuildService } = require('../dist/backfill/event-build.service');
const { SqdSourceFetchService } = require('../dist/backfill/sqd-source-fetch.service');
const { base58Encode } = require('../dist/codec/base58');
const { Platform } = require('../dist/domain/enums');
const { PlatformAdapterRegistry } = require('../dist/platforms/registry');
const { SqliteStore } = require('../dist/storage/sqlite-store');
const { key, jupiterIncrease, prefix } = require('./helpers');

const silentLogger = { info() {}, warn() {}, error() {} };

function knownIncrease() {
  return jupiterIncrease({
    position: key(1),
    isLong: true,
    market: key(2),
    collateral: key(3),
    positionSizeUsd: 100_000_000n,
    positionMint: key(4),
    request: key(5),
    requestMint: key(6),
    collateralDeltaUsd: 20_000_000n,
    owner: key(7),
    pool: key(8),
    sizeDeltaUsd: 100_000_000n,
    price: 150_000_000n,
    feeUsd: 600_000n,
    openTime: 1735689600n,
  });
}

test('source chunk store writes immutable compressed chunks with checksum and ordered replay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-source-chunks-'));
  const chunks = new SourceChunkStore(dir);
  const records = [
    [100, 1735689600, 'sig-a', 2, [4, 0], ['account-a'], Buffer.from([1, 2, 3]).toString('base64')],
    [104, 1735689602, 'sig-b', 7, [5, 1], ['account-b'], Buffer.from([4, 5, 6]).toString('base64')],
  ];
  const manifest = chunks.writeChunk({
    platform: Platform.JUPITER,
    programId: 'Program1111111111111111111111111111111111',
    portalUrl: 'https://portal.example/datasets/solana-mainnet',
    fromSlot: 100,
    toSlot: 109,
    blockCount: 2,
    records,
  });

  assert.equal(manifest.recordCount, 2);
  assert.equal(manifest.compression, 'gzip');
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(chunks.readRecords(manifest), records);
  assert.deepEqual(chunks.uncoveredRanges(Platform.JUPITER, 100, 109), []);
  assert.deepEqual(chunks.uncoveredRanges(Platform.JUPITER, 90, 119), [
    { from: 90, to: 99 },
    { from: 110, to: 119 },
  ]);
});

test('SQD source fetch archives all target-program Anchor CPI events before event filtering', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-source-fetch-'));
  const store = new SqliteStore(path.join(dir, 'canonical.sqlite'));
  t.after(() => store.close());
  const chunks = new SourceChunkStore(path.join(dir, 'archive'));
  const registry = new PlatformAdapterRegistry();
  const adapter = registry.get(Platform.JUPITER);
  let streams = 0;
  const client = {
    url: 'https://portal.example/datasets/solana-mainnet',
    async resolveTimestamp() { throw new Error('not used'); },
    async *streamInstructions() {
      streams += 1;
      yield {
        header: { number: 100, timestamp: 1735689600 },
        transactions: [{ transactionIndex: 2, signatures: ['sig-source'], err: null }],
        instructions: [
          {
            programId: adapter.programId,
            data: base58Encode(knownIncrease()),
            transactionIndex: 2,
            instructionAddress: [4, 0],
            accounts: ['account-known'],
            isCommitted: true,
          },
          {
            programId: adapter.programId,
            data: base58Encode(prefix('CreatePositionRequestEvent', new Uint8Array([9]))),
            transactionIndex: 2,
            instructionAddress: [4, 1],
            accounts: ['account-other'],
            isCommitted: true,
          },
        ],
      };
    },
  };
  const service = new SqdSourceFetchService(
    1_000,
    client,
    registry,
    chunks,
    store,
    silentLogger,
  );

  const first = await service.run({
    platform: Platform.JUPITER,
    fromSlot: 100,
    toSlot: 109,
    resume: true,
  });
  assert.equal(first.archivedInstructions, 2);
  assert.equal(first.windows, 1);
  assert.equal(chunks.list(Platform.JUPITER)[0].recordCount, 2);

  const second = await service.run({
    platform: Platform.JUPITER,
    fromSlot: 100,
    toSlot: 109,
    resume: true,
  });
  assert.equal(second.windows, 0);
  assert.equal(streams, 1);
});

test('event build filters archive records locally and resumes by completed chunk', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-event-build-'));
  const store = new SqliteStore(path.join(dir, 'canonical.sqlite'));
  t.after(() => store.close());
  const chunks = new SourceChunkStore(path.join(dir, 'archive'));
  const registry = new PlatformAdapterRegistry();
  const adapter = registry.get(Platform.JUPITER);
  chunks.writeChunk({
    platform: Platform.JUPITER,
    programId: adapter.programId,
    portalUrl: 'https://portal.example/datasets/solana-mainnet',
    fromSlot: 100,
    toSlot: 109,
    blockCount: 1,
    records: [
      [100, 1735689600, 'sig-known', 2, [4, 0], ['account-known'], Buffer.from(knownIncrease()).toString('base64')],
      [100, 1735689600, 'sig-other', 2, [4, 1], ['account-other'], Buffer.from(prefix('CreatePositionRequestEvent', new Uint8Array([9]))).toString('base64')],
    ],
  });

  let processed = 0;
  const ingestion = {
    async processInstructions(instructions) {
      processed += instructions.length;
      return { inserted: instructions.length, duplicate: 0, unsupported: 0, ignored: 0, failed: 0 };
    },
  };
  const service = new EventBuildService(chunks, registry, ingestion, store, silentLogger);
  const first = await service.run({ platform: Platform.JUPITER, resume: true });
  assert.equal(first.archivedInstructions, 2);
  assert.equal(first.targetInstructions, 1);
  assert.equal(first.filteredEvents, 1);
  assert.equal(first.inserted, 1);

  const second = await service.run({ platform: Platform.JUPITER, resume: true });
  assert.equal(second.chunks, 0);
  assert.equal(second.skippedChunks, 1);
  assert.equal(processed, 1);
});
