const test = require('node:test');
const assert = require('node:assert/strict');
const { base58Encode, base58Decode } = require('../dist/codec/base58');
const { anchorEventDiscriminatorHex } = require('../dist/codec/anchor');

test('base58 codec round trips bytes including leading zeroes', () => {
  const input = Uint8Array.from([0,0,1,2,3,250,255]);
  assert.deepEqual(base58Decode(base58Encode(input)), input);
});
test('known event discriminators match deployed interfaces', () => {
  assert.equal(anchorEventDiscriminatorHex('TradeEvent'), 'bddb7fd34ee661ee');
  assert.equal(anchorEventDiscriminatorHex('IncreasePositionEvent'), 'f5715534d6bb9984');
});
