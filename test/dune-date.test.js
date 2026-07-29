const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDuneDate,
  duneRowToInstruction,
} = require('../dist/backfill/dune-row');
const { Platform } = require('../dist/domain/enums');

test('parses Dune SQL-style UTC timestamps', () => {
  assert.equal(
    parseDuneDate('2025-01-01 00:00:01.000 UTC').toISOString(),
    '2025-01-01T00:00:01.000Z',
  );
  assert.equal(
    parseDuneDate('2025-01-01 00:00:01.123456 UTC').toISOString(),
    '2025-01-01T00:00:01.123Z',
  );
});

test('parses ISO, timezone offsets, and timezone-less Dune timestamps', () => {
  assert.equal(
    parseDuneDate('2025-01-01T00:00:01.000Z').toISOString(),
    '2025-01-01T00:00:01.000Z',
  );
  assert.equal(
    parseDuneDate('2025-01-01 01:30:01.000 +0130').toISOString(),
    '2025-01-01T00:00:01.000Z',
  );
  assert.equal(
    parseDuneDate('2025-01-01 00:00:01').toISOString(),
    '2025-01-01T00:00:01.000Z',
  );
});

test('converts a Dune row containing the production timestamp format', () => {
  const instruction = duneRowToInstruction(
    Platform.JUPITER,
    'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu',
    {
      signature: 'test-signature',
      slot: '312345678',
      block_time: '2025-01-01 00:00:01.000 UTC',
      outer_instruction_index: '1',
      inner_instruction_index: '2',
      data_hex: '00',
    },
  );

  assert.equal(instruction.blockTime.toISOString(), '2025-01-01T00:00:01.000Z');
  assert.equal(instruction.slot, 312345678);
  assert.equal(instruction.outerInstructionIndex, 1);
  assert.equal(instruction.innerInstructionIndex, 2);
});
