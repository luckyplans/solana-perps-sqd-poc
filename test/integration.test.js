const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PlatformAdapterRegistry } = require('../dist/platforms/registry');
const { MarketRegistryService } = require('../dist/services/market-registry.service');
const { IngestionService } = require('../dist/services/ingestion.service');
const { EventLogService } = require('../dist/services/event-log.service');
const { LeaderboardService } = require('../dist/services/leaderboard.service');
const { SqliteStore } = require('../dist/storage/sqlite-store');
const { Platform, IngestionSource } = require('../dist/domain/enums');
const { consoleLogger } = require('../dist/utils/logger');
const { GMTRADE_PROGRAM_ID } = require('../dist/platforms/gmtrade/constants');
const { JUPITER_PROGRAM_ID } = require('../dist/platforms/jupiter/constants');
const { key, gmTradeEvent, jupiterIncrease, jupiterDecrease } = require('./helpers');

function harness(markets) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-solana-poc-'));
  const marketPath = path.join(dir, 'markets.json');
  fs.writeFileSync(marketPath, JSON.stringify(markets));
  const store = new SqliteStore(path.join(dir, 'test.sqlite'));
  const adapters = new PlatformAdapterRegistry();
  const ingestion = new IngestionService(adapters, new MarketRegistryService(marketPath), store, consoleLogger);
  return { dir, store, ingestion, events: new EventLogService(store), leaderboard: new LeaderboardService(store) };
}
function source(platform, programId, signature, slot, data, time) {
  return { platform,programId,ingestionSource: IngestionSource.JSONL,signature,slot,blockTime: new Date(time),outerInstructionIndex: 1,innerInstructionIndex: 1,data };
}

test('GMTrade binary CPI events map to canonical open and close actions', async (t) => {
  const market = key(1), user = key(2), position = key(3), authority = key(4), storeKey = key(5), order1 = key(6), order2 = key(7), finalOutput = key(8);
  const app = harness([{ platform: Platform.GMTRADE,marketAddress: market.address,pair: 'SOL/USD',indexTokenDecimals: 9,longCollateralTokenDecimals: 6,shortCollateralTokenDecimals: 6,collateralIsStable: true }]);
  t.after(() => app.store.close());
  const usd = 10n ** 20n, usdcUnitPrice = 10n ** 14n, solUnitPrice = 10n ** 13n;
  const common = { authority,store: storeKey,market,user,position,finalOutput,prices: { indexMin: solUnitPrice,indexMax: solUnitPrice,longMin: usdcUnitPrice,longMax: usdcUnitPrice,shortMin: usdcUnitPrice,shortMax: usdcUnitPrice },executionPrice: solUnitPrice };
  const open = gmTradeEvent({ ...common,order: order1,flags: 1|2|4,ts: 1_750_000_000n,slot: 100n,before: {},after: { sizeInUsd: 5_000n*usd,collateralAmount: 100_000_000n },fees: { orderPool: 100_000n } });
  const close = gmTradeEvent({ ...common,order: order2,flags: 1|2,ts: 1_750_000_100n,slot: 101n,before: { sizeInUsd: 5_000n*usd,collateralAmount: 100_000_000n },after: {},pnl: 100n*usd,fees: { orderPool: 1_000_000n } });
  assert.equal((await app.ingestion.processInstruction(source(Platform.GMTRADE, GMTRADE_PROGRAM_ID, 'gm-open', 100, open, '2025-06-15T00:00:00Z'))).status, 'inserted');
  assert.equal((await app.ingestion.processInstruction(source(Platform.GMTRADE, GMTRADE_PROGRAM_ID, 'gm-close', 101, close, '2025-06-15T00:01:40Z'))).status, 'inserted');
  assert.equal((await app.ingestion.processInstruction(source(Platform.GMTRADE, GMTRADE_PROGRAM_ID, 'gm-close', 101, close, '2025-06-15T00:01:40Z'))).status, 'duplicate');
  const events = app.events.findPosition(Platform.GMTRADE, position.address);
  assert.equal(events.length, 2); assert.equal(events[0].operation, 'open'); assert.equal(events[1].operation, 'close');
  assert.equal(events[0].sizeInUsd, 5000); assert.equal(events[0].leverage, 50); assert.equal(events[0].usdFee, -0.1);
  assert.equal(events[1].usdPnl, 99); assert.equal(events[1].price, 100);
});

test('Jupiter events reconstruct position state and produce a leaderboard', async (t) => {
  const market = key(20), collateral = key(21), owner = key(22), position = key(23), positionMint = key(24), request = key(25), requestMint = key(26), pool = key(27);
  const app = harness([{ platform: Platform.JUPITER,marketAddress: market.address,pair: 'SOL/USD',collateralAddress: collateral.address,collateralTokenDecimals: 6,collateralIsStable: true,indexTokenDecimals: 9 }]);
  t.after(() => app.store.close());
  const open = jupiterIncrease({ position,isLong: true,market,collateral,positionSizeUsd: 10_000_000_000n,positionMint,request,requestMint,owner,pool,sizeDeltaUsd: 10_000_000_000n,collateralDeltaUsd: 1_000_000_000n,price: 100_000_000n,feeUsd: 5_000_000n,openTime: 1_750_000_000n });
  const close = jupiterDecrease({ position,isLong: true,market,collateral,positionSizeUsd: 0n,positionMint,request,requestMint,owner,pool,hasProfit: true,pnlDelta: 200_000_000n,sizeDeltaUsd: 10_000_000_000n,price: 110_000_000n,feeUsd: 5_000_000n,openTime: 1_750_000_100n,originalCollateralUsd: 1_000_000_000n,positionCollateralUsd: 0n,positionOpenTime: 1_750_000_000n,positionPrice: 100_000_000n });
  await app.ingestion.processInstruction(source(Platform.JUPITER, JUPITER_PROGRAM_ID, 'jup-open', 200, open, '2025-06-15T00:00:00Z'));
  await app.ingestion.processInstruction(source(Platform.JUPITER, JUPITER_PROGRAM_ID, 'jup-close', 201, close, '2025-06-15T00:01:40Z'));
  const events = app.events.findPosition(Platform.JUPITER, position.address);
  assert.equal(events.length, 2); assert.equal(events[0].operation, 'open'); assert.equal(events[1].operation, 'close');
  assert.equal(events[0].leverage, 10); assert.equal(events[1].usdPnl, 195);
  assert.equal(app.leaderboard.rebuild(), 1);
  const board = app.leaderboard.list({ platform: Platform.JUPITER });
  assert.equal(board.length, 1); assert.equal(board[0].address, owner.address); assert.equal(board[0].grossPnlUsd, 200);
  assert.equal(board[0].feesPaidUsd, 10); assert.equal(board[0].netPnlUsd, 190); assert.equal(board[0].volumeUsd, 20000);
});
