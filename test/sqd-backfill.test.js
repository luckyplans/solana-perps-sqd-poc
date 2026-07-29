const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SqdBackfillService,
  sqdBlockToInstructions,
  encodeInnerInstructionAddress,
  getTransactionSignature,
} = require('../dist/backfill/sqd-backfill.service');
const { base58Encode } = require('../dist/codec/base58');
const { PlatformAdapterRegistry } = require('../dist/platforms/registry');
const { SqliteStore } = require('../dist/storage/sqlite-store');
const { IngestionSource, Platform } = require('../dist/domain/enums');
const { key, jupiterIncrease, prefix } = require('./helpers');

const silentLogger = { info() {}, warn() {}, error() {} };

test('SQD converts CPI instruction addresses and transaction signatures to canonical source coordinates', () => {
  const registry = new PlatformAdapterRegistry();
  const adapter = registry.get(Platform.JUPITER);
  const position = key(1);
  const market = key(2);
  const collateral = key(3);
  const request = key(4);
  const requestMint = key(5);
  const positionMint = key(6);
  const owner = key(7);
  const pool = key(8);
  const data = jupiterIncrease({
    position,
    isLong: true,
    market,
    collateral,
    positionSizeUsd: 100_000_000n,
    positionMint,
    request,
    requestMint,
    collateralDeltaUsd: 20_000_000n,
    owner,
    pool,
    sizeDeltaUsd: 100_000_000n,
    price: 150_000_000n,
    feeUsd: 600_000n,
    openTime: 1735689600n,
  });

  const result = sqdBlockToInstructions(Platform.JUPITER, adapter, {
    header: { number: 311081184, timestamp: 1735689600 },
    transactions: [{ transactionIndex: 2, signatures: ['signature-1'], err: null }],
    instructions: [{
      programId: adapter.programId,
      data: base58Encode(data),
      transactionIndex: 2,
      instructionAddress: [4, 0],
      isCommitted: true,
      error: null,
    }],
  });

  assert.equal(result.portalInstructions, 1);
  assert.equal(result.filteredEvents, 0);
  assert.equal(result.instructions.length, 1);
  assert.equal(result.instructions[0].signature, 'signature-1');
  assert.equal(result.instructions[0].slot, 311081184);
  assert.equal(result.instructions[0].outerInstructionIndex, 5);
  assert.equal(result.instructions[0].innerInstructionIndex, 1);
  assert.equal(result.instructions[0].ingestionSource, IngestionSource.SQD);
  assert.equal(result.instructions[0].blockTime.toISOString(), '2025-01-01T00:00:00.000Z');
});

test('SQD filters non-trade Anchor CPI events before decoder ingestion', () => {
  const registry = new PlatformAdapterRegistry();
  const adapter = registry.get(Platform.JUPITER);
  const data = prefix('CreatePositionRequestEvent', new Uint8Array());
  const result = sqdBlockToInstructions(Platform.JUPITER, adapter, {
    header: { number: 311081184, timestamp: 1735689600 },
    transactions: [{ transactionIndex: 0, signatures: ['signature-2'], err: null }],
    instructions: [{
      programId: adapter.programId,
      data: base58Encode(data),
      transactionIndex: 0,
      instructionAddress: [1, 0],
      isCommitted: true,
    }],
  });
  assert.equal(result.filteredEvents, 1);
  assert.equal(result.instructions.length, 0);
});

test('SQD preserves direct CPI indexes and safely encodes deeper CPI paths', () => {
  assert.equal(encodeInnerInstructionAddress([]), 0);
  assert.equal(encodeInnerInstructionAddress([0]), 1);
  assert.equal(encodeInnerInstructionAddress([4]), 5);
  assert.equal(encodeInnerInstructionAddress([1, 3]), 20004);
});


test('SQD accepts both current signatures array and legacy singular signature transaction shapes', () => {
  assert.equal(getTransactionSignature({ signatures: ['array-signature'] }), 'array-signature');
  assert.equal(getTransactionSignature({ signature: 'singular-signature' }), 'singular-signature');
  assert.equal(getTransactionSignature({ signatures: 'string-signature' }), 'string-signature');
  assert.equal(getTransactionSignature({ signatures: [] }), undefined);
});

test('SQD maps high transaction indexes when the related transaction is included by the instruction selector', () => {
  const registry = new PlatformAdapterRegistry();
  const adapter = registry.get(Platform.JUPITER);
  const data = jupiterIncrease({
    position: key(21),
    isLong: true,
    market: key(22),
    collateral: key(23),
    positionSizeUsd: 100_000_000n,
    positionMint: key(24),
    request: key(25),
    requestMint: key(26),
    collateralDeltaUsd: 20_000_000n,
    owner: key(27),
    pool: key(28),
    sizeDeltaUsd: 100_000_000n,
    price: 150_000_000n,
    feeUsd: 600_000n,
    openTime: 1735689600n,
  });

  const result = sqdBlockToInstructions(Platform.JUPITER, adapter, {
    header: { number: 311081164, timestamp: 1735689600 },
    transactions: [{ transactionIndex: 1182, signatures: ['high-index-signature'], err: null }],
    instructions: [{
      programId: adapter.programId,
      data: base58Encode(data),
      transactionIndex: 1182,
      instructionAddress: [4, 0],
      isCommitted: true,
      error: null,
    }],
  });

  assert.equal(result.instructions.length, 1);
  assert.equal(result.instructions[0].signature, 'high-index-signature');
});


test('SQD maps a sole related transaction when Portal omits transactionIndex', () => {
  const registry = new PlatformAdapterRegistry();
  const adapter = registry.get(Platform.JUPITER);
  const data = jupiterIncrease({
    position: key(31),
    isLong: true,
    market: key(32),
    collateral: key(33),
    positionSizeUsd: 100_000_000n,
    positionMint: key(34),
    request: key(35),
    requestMint: key(36),
    collateralDeltaUsd: 20_000_000n,
    owner: key(37),
    pool: key(38),
    sizeDeltaUsd: 100_000_000n,
    price: 150_000_000n,
    feeUsd: 600_000n,
    openTime: 1735689600n,
  });

  const result = sqdBlockToInstructions(Platform.JUPITER, adapter, {
    header: { number: 311081164, timestamp: 1735689600 },
    transactions: [{ signatures: ['filtered-relation-signature'], err: null }],
    instructions: [{
      programId: adapter.programId,
      data: base58Encode(data),
      transactionIndex: 1182,
      instructionAddress: [4, 0],
      isCommitted: true,
      error: null,
    }],
  });

  assert.equal(result.instructions.length, 1);
  assert.equal(result.instructions[0].signature, 'filtered-relation-signature');
});

test('SQD resume at an already completed slot boundary is a no-op', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-sqd-resume-'));
  const store = new SqliteStore(path.join(dir, 'data.sqlite'));
  t.after(() => store.close());
  let streams = 0;
  const client = {
    url: 'https://portal.example/datasets/solana-mainnet',
    async resolveTimestamp() {
      throw new Error('Date resolution should not be used for explicit slots');
    },
    async *streamInstructions(input) {
      streams += 1;
      yield { header: { number: input.toSlot, timestamp: 1735689600 } };
    },
  };
  const ingestion = {
    async processInstructions() {
      throw new Error('No instructions should be processed');
    },
  };
  const service = new SqdBackfillService(
    10_000,
    client,
    new PlatformAdapterRegistry(),
    ingestion,
    store,
    silentLogger,
  );

  const first = await service.run({
    platform: Platform.JUPITER,
    fromSlot: 100,
    toSlot: 109,
  });
  assert.equal(first.windows, 1);
  assert.equal(streams, 1);

  const second = await service.run({
    platform: Platform.JUPITER,
    fromSlot: 100,
    toSlot: 109,
    resume: true,
  });
  assert.equal(second.windows, 0);
  assert.equal(second.effectiveFromSlot, 110);
  assert.equal(streams, 1);
});
