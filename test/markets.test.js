const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Platform } = require('../dist/domain/enums');
const { MarketRegistryService } = require('../dist/services/market-registry.service');
const {
  buildJupiterMainnetMarketDefinitions,
  JUPITER_MAINNET_CUSTODIES,
} = require('../dist/markets/jupiter-mainnet');
const {
  decodeGmTradeMarketAccount,
  GMTRADE_MARKET_ACCOUNT_DISCRIMINATOR,
  GMTRADE_MARKET_ACCOUNT_PREFIX_LENGTH,
} = require('../dist/markets/gmtrade-market-account');
const { GmTradeMarketDiscoveryService } = require('../dist/markets/gmtrade-market-discovery.service');
const { key } = require('./helpers');

function makeGmMarket(input) {
  const data = new Uint8Array(GMTRADE_MARKET_ACCOUNT_PREFIX_LENGTH);
  data.set(GMTRADE_MARKET_ACCOUNT_DISCRIMINATOR, 0);
  data[8] = input.version ?? 1;
  data[10] = input.enabled === false ? 0 : 1;
  data.set(Buffer.from(input.name, 'utf8').subarray(0, 64), 24);
  data.set(input.marketToken.bytes, 88);
  data.set(input.indexToken.bytes, 120);
  data.set(input.longToken.bytes, 152);
  data.set(input.shortToken.bytes, 184);
  data.set(input.store.bytes, 216);
  return data;
}

function rpcAccount(data) {
  return {
    data: [Buffer.from(data).toString('base64'), 'base64'],
    executable: false,
    lamports: 1,
    owner: 'TokenProgram1111111111111111111111111111111',
    rentEpoch: 0,
  };
}

function mint(decimals) {
  const data = new Uint8Array(82);
  data[44] = decimals;
  return rpcAccount(data);
}

const silentLogger = { info() {}, warn() {}, error() {} };

test('Jupiter mainnet registry has exact index/collateral mappings and no placeholders', () => {
  const definitions = buildJupiterMainnetMarketDefinitions('2026-07-14T00:00:00.000Z');
  assert.equal(JUPITER_MAINNET_CUSTODIES.length, 6);
  assert.equal(definitions.length, 18);
  assert.deepEqual(
    [...new Set(definitions.map((item) => item.pair))].sort(),
    ['BTC/USD', 'ETH/USD', 'SOL/USD'],
  );
  assert.equal(definitions.some((item) => item.marketAddress.includes('REPLACE')), false);
  assert.equal(definitions.some((item) => item.collateralAddress.includes('REPLACE')), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-market-registry-'));
  const registryPath = path.join(dir, 'markets.json');
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-07-14T00:00:00.000Z',
      sources: {},
      markets: definitions,
    }),
  );
  const registry = new MarketRegistryService(registryPath);
  const sol = JUPITER_MAINNET_CUSTODIES.find((item) => item.symbol === 'SOL');
  const usdc = JUPITER_MAINNET_CUSTODIES.find((item) => item.symbol === 'USDC');
  const resolution = registry.resolve(Platform.JUPITER, sol.address, usdc.address);
  assert.equal(resolution.known, true);
  assert.equal(resolution.pair, 'SOL/USD');
  assert.equal(resolution.collateralTokenDecimals, 6);
  assert.equal(resolution.collateralUsdPriceE6, 1_000_000n);
});

test('GMTrade zero-copy market prefix decoder follows the production account layout', () => {
  const input = {
    name: 'SOL/USD [SOL-USDC]',
    marketToken: key(101),
    indexToken: key(102),
    longToken: key(103),
    shortToken: key(104),
    store: key(105),
  };
  const address = key(100).address;
  const decoded = decodeGmTradeMarketAccount(address, makeGmMarket(input));
  assert.equal(decoded.marketAccountAddress, address);
  assert.equal(decoded.enabled, true);
  assert.equal(decoded.name, input.name);
  assert.equal(decoded.marketTokenMint, input.marketToken.address);
  assert.equal(decoded.indexTokenMint, input.indexToken.address);
  assert.equal(decoded.longTokenMint, input.longToken.address);
  assert.equal(decoded.shortTokenMint, input.shortToken.address);
  assert.equal(decoded.store, input.store.address);
});

test('GMTrade market discovery builds production config from RPC accounts and mint decimals', async () => {
  const marketAccount = key(110);
  const marketToken = key(111);
  const indexToken = key(112);
  const longToken = key(113);
  const shortToken = key(114);
  const store = key(115);
  const marketData = makeGmMarket({
    name: 'SOL/USD [SOL-USDC]',
    marketToken,
    indexToken,
    longToken,
    shortToken,
    store,
  });
  const mintMap = new Map([
    [indexToken.address, mint(9)],
    [longToken.address, mint(9)],
    [shortToken.address, mint(6)],
  ]);
  const fakeRpc = {
    url: 'https://rpc.example.invalid',
    async getProgramAccounts() {
      return [{ pubkey: marketAccount.address, account: rpcAccount(marketData) }];
    },
    async getMultipleAccounts(addresses) {
      return addresses.map((address) => mintMap.get(address) ?? null);
    },
  };
  const service = new GmTradeMarketDiscoveryService(fakeRpc, silentLogger);
  const result = await service.discover();
  assert.equal(result.definitions.length, 1);
  const definition = result.definitions[0];
  assert.equal(definition.platform, Platform.GMTRADE);
  assert.equal(definition.marketAddress, marketToken.address);
  assert.equal(definition.marketAccountAddress, marketAccount.address);
  assert.equal(definition.pair, 'SOL/USD');
  assert.equal(definition.indexTokenDecimals, 9);
  assert.equal(definition.longCollateralTokenDecimals, 9);
  assert.equal(definition.shortCollateralTokenDecimals, 6);
  assert.equal(definition.source, 'rpcDiscovery');
  assert.equal(result.metadata.marketCount, 1);
  assert.deepEqual(result.warnings, []);
});

test('GMTrade discovery retains disabled markets for complete historical backfill', async () => {
  const active = {
    account: key(210), marketToken: key(211), indexToken: key(212), longToken: key(213), shortToken: key(214), store: key(215),
  };
  const disabled = {
    account: key(220), marketToken: key(221), indexToken: key(222), longToken: key(223), shortToken: key(224), store: key(225),
  };
  const accounts = [
    { pubkey: active.account.address, account: rpcAccount(makeGmMarket({ name: 'SOL/USD', marketToken: active.marketToken, indexToken: active.indexToken, longToken: active.longToken, shortToken: active.shortToken, store: active.store })) },
    { pubkey: disabled.account.address, account: rpcAccount(makeGmMarket({ name: 'OLD/USD', marketToken: disabled.marketToken, indexToken: disabled.indexToken, longToken: disabled.longToken, shortToken: disabled.shortToken, store: disabled.store, enabled: false })) },
  ];
  const mintMap = new Map();
  for (const address of [active.indexToken.address, active.longToken.address, disabled.indexToken.address, disabled.longToken.address]) mintMap.set(address, mint(9));
  for (const address of [active.shortToken.address, disabled.shortToken.address]) mintMap.set(address, mint(6));
  const fakeRpc = {
    url: 'https://rpc.example.invalid',
    async getProgramAccounts() { return accounts; },
    async getMultipleAccounts(addresses) { return addresses.map((address) => mintMap.get(address) ?? null); },
  };
  const result = await new GmTradeMarketDiscoveryService(fakeRpc, silentLogger).discover();
  assert.equal(result.definitions.length, 2);
  assert.equal(result.definitions.find((item) => item.marketAddress === active.marketToken.address).enabled, true);
  assert.equal(result.definitions.find((item) => item.marketAddress === disabled.marketToken.address).enabled, false);
  assert.equal(result.metadata.marketCount, 2);
});
