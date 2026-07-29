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
const { key, jupiterIncrease, jupiterDeposit, jupiterWithdraw, jupiterLiquidation } = require('./helpers');

function source(signature, slot, data) { return { platform: Platform.JUPITER,programId: JUPITER_PROGRAM_ID,ingestionSource: IngestionSource.JSONL,signature,slot,blockTime: new Date(1_750_000_000_000 + slot * 1000),outerInstructionIndex: 1,innerInstructionIndex: 1,data }; }

test('Jupiter collateral actions and liquidation preserve the general operation model', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-jup-actions-'));
  const market = key(80), collateral = key(81), owner = key(82), position = key(83), positionMint = key(84), request = key(85), requestMint = key(86), pool = key(87), userToken = key(88);
  const marketPath = path.join(dir, 'markets.json');
  fs.writeFileSync(marketPath, JSON.stringify([{ platform: Platform.JUPITER,marketAddress: market.address,pair: 'SOL/USD',collateralAddress: collateral.address,collateralTokenDecimals: 6,collateralIsStable: true,indexTokenDecimals: 9 }]));
  const store = new SqliteStore(path.join(dir, 'db.sqlite')); t.after(() => store.close());
  const ingestion = new IngestionService(new PlatformAdapterRegistry(), new MarketRegistryService(marketPath), store, consoleLogger);
  const events = new EventLogService(store);
  const open = jupiterIncrease({ position,isLong: true,market,collateral,positionSizeUsd: 10_000_000_000n,positionMint,request,requestMint,owner,pool,sizeDeltaUsd: 10_000_000_000n,collateralDeltaUsd: 1_000_000_000n,price: 100_000_000n,feeUsd: 1_000_000n,openTime: 1_750_000_000n });
  const deposit = jupiterDeposit({ owner,pool,position,positionMint,market,depositAmount: 100_000_000n,userTokenAccount: userToken,time: 1_750_000_010n });
  const withdraw = jupiterWithdraw({ owner,pool,position,positionMint,market,withdrawAmount: 200_000_000n,userTokenAccount: userToken,collateral,previousCollateralAmount: 1_100_000_000n,collateralAmount: 900_000_000n,collateralAmountUsd: 900_000_000n,time: 1_750_000_020n });
  const liquidate = jupiterLiquidation({ position,isLong: true,market,collateral,collateralMint: collateral,positionMint,positionSizeUsd: 10_000_000_000n,hasProfit: false,pnlDelta: 500_000_000n,owner,pool,price: 90_000_000n,feeUsd: 10_000_000n,liquidationFeeUsd: 20_000_000n,openTime: 1_750_000_030n,originalCollateralUsd: 900_000_000n,positionOpenTime: 1_750_000_000n,positionPrice: 100_000_000n });
  for (const [i, data] of [open,deposit,withdraw,liquidate].entries()) assert.equal((await ingestion.processInstruction(source(`sig-${i}`, 300+i, data))).status, 'inserted');
  const rows = events.findPosition(Platform.JUPITER, position.address);
  assert.deepEqual(rows.map((row) => row.operation), ['open','decreaseLeverage','increaseLeverage','close']);
  assert.equal(rows[1].collateralInUsd, 1100); assert.equal(rows[2].collateralInUsd, 900);
  assert.equal(rows[3].liquidation, true); assert.equal(rows[3].closeReason, 'liquidation'); assert.equal(rows[3].usdPnl, -530);
});

test('Jupiter collateral-only event without earlier position state never fabricates collateral or position state', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-jup-partial-'));
  const market = key(180), collateral = key(181), owner = key(182), position = key(183), positionMint = key(184), pool = key(185), userToken = key(186);
  const marketPath = path.join(dir, 'markets.json');
  fs.writeFileSync(marketPath, JSON.stringify([
    { platform: Platform.JUPITER,marketAddress: market.address,pair: 'SOL/USD',collateralAddress: collateral.address,collateralTokenDecimals: 6,collateralIsStable: true },
  ]));
  const store = new SqliteStore(path.join(dir, 'db.sqlite'));
  t.after(() => store.close());
  const ingestion = new IngestionService(new PlatformAdapterRegistry(), new MarketRegistryService(marketPath), store, consoleLogger);
  const events = new EventLogService(store);
  const deposit = jupiterDeposit({ owner,pool,position,positionMint,market,depositAmount: 999_000_000n,userTokenAccount: userToken,time: 1_750_000_010n });
  assert.equal((await ingestion.processInstruction(source('partial-deposit', 900, deposit))).status, 'inserted');
  const rows = events.findPosition(Platform.JUPITER, position.address);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation, 'decreaseLeverage');
  assert.equal(rows[0].dataQuality, 'partialState');
  assert.equal(rows[0].collateralInUsd, 0);
  assert.equal(rows[0].collateralDeltaUsd, 0);
  assert.equal(rows[0].collateralAddress, null);
  assert.equal(store.getPositionState(Platform.JUPITER, position.address), null);
});
