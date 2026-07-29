const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PlatformAdapterRegistry } = require('../dist/platforms/registry');
const { MarketRegistryService } = require('../dist/services/market-registry.service');
const { IngestionService } = require('../dist/services/ingestion.service');
const { EventLogService } = require('../dist/services/event-log.service');
const { SqliteStore } = require('../dist/storage/sqlite-store');
const { Platform, IngestionSource } = require('../dist/domain/enums');
const { consoleLogger } = require('../dist/utils/logger');
const { JUPITER_PROGRAM_ID } = require('../dist/platforms/jupiter/constants');
const { decodeJupiterInstruction } = require('../dist/platforms/jupiter/decoder');
const { key, jupiterIncrease, jupiterDecrease, jupiterLiquidation } = require('./helpers');

function source(signature, slot, data) {
  return {
    platform: Platform.JUPITER,
    programId: JUPITER_PROGRAM_ID,
    ingestionSource: IngestionSource.DUNE,
    signature,
    slot,
    blockTime: new Date(1_735_689_600_000 + slot * 1000),
    outerInstructionIndex: 1,
    innerInstructionIndex: 1,
    data,
  };
}

function harness(market, collateral) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-jup-legacy-'));
  const marketPath = path.join(dir, 'markets.json');
  fs.writeFileSync(marketPath, JSON.stringify([{
    platform: Platform.JUPITER,
    marketAddress: market.address,
    pair: 'SOL/USD',
    collateralAddress: collateral.address,
    collateralTokenDecimals: 6,
    collateralIsStable: true,
    indexTokenDecimals: 9,
  }]));
  const store = new SqliteStore(path.join(dir, 'db.sqlite'));
  const ingestion = new IngestionService(
    new PlatformAdapterRegistry(),
    new MarketRegistryService(marketPath),
    store,
    consoleLogger,
  );
  return { store, ingestion, events: new EventLogService(store) };
}

test('legacy Jupiter increase and decrease schemas decode after the old payload boundary', async (t) => {
  const market = key(210), collateral = key(211), owner = key(212), position = key(213);
  const positionMint = key(214), request = key(215), requestMint = key(216), pool = key(217);
  const app = harness(market, collateral);
  t.after(() => app.store.close());

  const open = jupiterIncrease({
    legacy: true,
    position, isLong: true, market, collateral,
    positionSizeUsd: 10_000_000_000n, positionMint, request, requestMint, owner, pool,
    sizeDeltaUsd: 10_000_000_000n, collateralDeltaUsd: 1_000_000_000n,
    collateralTokenDelta: 1_000_000_000n, price: 100_000_000n,
    priceSlippage: 1_000n, feeUsd: 5_000_000n, openTime: 1_735_689_601n,
  });
  // 16-byte CPI/event prefix + 341-byte legacy payload. This is the exact
  // boundary reported by the production Dune rows in January 2025.
  assert.equal(open.length, 357);
  const decodedOpen = decodeJupiterInstruction(open);
  assert.equal(decodedOpen.value.schemaVersion, 'legacy');
  assert.equal(decodedOpen.value.hasExtendedFeeBreakdown, false);

  const decrease = jupiterDecrease({
    legacy: true,
    position, isLong: true, market, collateral,
    positionSizeUsd: 5_000_000_000n, positionMint, request, requestMint, owner, pool,
    hasProfit: true, pnlDelta: 100_000_000n, sizeDeltaUsd: 5_000_000_000n,
    transferAmountUsd: 600_000_000n, transferToken: 500_000_000n,
    price: 105_000_000n, priceSlippage: 1_000n, feeUsd: 2_000_000n,
    openTime: 1_735_689_602n,
  });
  assert.equal(decrease.length, 351);
  const decodedDecrease = decodeJupiterInstruction(decrease);
  assert.equal(decodedDecrease.value.schemaVersion, 'legacy');
  assert.equal(decodedDecrease.value.hasPositionCollateralState, false);

  assert.equal((await app.ingestion.processInstruction(source('legacy-open', 1, open))).status, 'inserted');
  assert.equal((await app.ingestion.processInstruction(source('legacy-decrease', 2, decrease))).status, 'inserted');

  const rows = app.events.findPosition(Platform.JUPITER, position.address);
  assert.deepEqual(rows.map((row) => row.operation), ['open', 'decreaseSize']);
  assert.equal(rows[0].dataQuality, 'complete');
  assert.equal(rows[1].dataQuality, 'partialState');
  assert.equal(rows[1].sizeInUsd, 5000);
  // Old events do not contain the newer remaining-collateral fields. Preserve
  // the last known collateral rather than falsely replacing it with zero.
  assert.equal(rows[1].collateralInUsd, 1000);
  assert.equal(rows[1].usdPnl, 98);
});

test('legacy Jupiter full-liquidation schema decodes without the later 64-byte extension', async (t) => {
  const market = key(220), collateral = key(221), owner = key(222), position = key(223);
  const positionMint = key(224), collateralMint = key(225), pool = key(226);
  const app = harness(market, collateral);
  t.after(() => app.store.close());

  const liquidation = jupiterLiquidation({
    legacy: true,
    position, isLong: false, market, collateral, collateralMint, positionMint,
    positionSizeUsd: 2_000_000_000n, hasProfit: false, pnlDelta: 300_000_000n,
    owner, pool, transferAmountUsd: 0n, transferToken: 0n, price: 90_000_000n,
    feeUsd: 4_000_000n, liquidationFeeUsd: 10_000_000n,
  });
  const decoded = decodeJupiterInstruction(liquidation);
  assert.equal(decoded.value.schemaVersion, 'legacy');
  assert.equal(decoded.value.liquidationFeeUsd, 10_000_000n);
  assert.equal((await app.ingestion.processInstruction(source('legacy-liquidation', 3, liquidation))).status, 'inserted');
  const rows = app.events.findPosition(Platform.JUPITER, position.address);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation, 'close');
  assert.equal(rows[0].liquidation, true);
  assert.equal(rows[0].usdPnl, -314);
  assert.equal(rows[0].dataQuality, 'partialState');
});


test('intermediate Jupiter full-liquidation schema decodes its 8-byte open-time tail', async (t) => {
  const market = key(230), collateral = key(231), owner = key(232), position = key(233);
  const positionMint = key(234), collateralMint = key(235), pool = key(236);
  const app = harness(market, collateral);
  t.after(() => app.store.close());

  const liquidation = jupiterLiquidation({
    legacyOpenTimeOnly: true,
    position, isLong: true, market, collateral, collateralMint, positionMint,
    positionSizeUsd: 3_000_000_000n, hasProfit: false, pnlDelta: 400_000_000n,
    owner, pool, transferAmountUsd: 0n, transferToken: 0n, price: 85_000_000n,
    feeUsd: 5_000_000n, liquidationFeeUsd: 12_000_000n,
    openTime: 1_735_689_500n,
  });

  // 16-byte CPI/event prefix + 282-byte fixed payload + 8-byte open_time.
  // This matches the dataLength=306 rows reported by the production Dune run.
  assert.equal(liquidation.length, 306);
  const decoded = decodeJupiterInstruction(liquidation);
  assert.equal(decoded.value.schemaVersion, 'legacy');
  assert.equal(decoded.value.hasOpenTime, true);
  assert.equal(decoded.value.openTime, 1_735_689_500n);
  assert.equal(decoded.value.hasExtendedFeeBreakdown, false);
  assert.equal(decoded.value.hasPositionCollateralState, false);

  assert.equal((await app.ingestion.processInstruction(source('legacy-open-time-liquidation', 4, liquidation))).status, 'inserted');
  const rows = app.events.findPosition(Platform.JUPITER, position.address);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation, 'close');
  assert.equal(rows[0].liquidation, true);
  assert.equal(rows[0].usdPnl, -417);
  assert.equal(rows[0].dataQuality, 'partialState');
});
