const test = require('node:test');
const assert = require('node:assert/strict');
const { SqdClient } = require('../dist/backfill/sqd-client');

test('SQD resolves timestamps through the Portal timestamp endpoint', async () => {
  const requests = [];
  const client = new SqdClient({
    portalUrl: 'https://portal.example/datasets/solana-mainnet',
    requestIntervalMs: 0,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), method: init?.method });
      return new Response(JSON.stringify({ block_number: 311081000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(
    await client.resolveTimestamp(new Date('2025-01-01T00:00:00Z')),
    311081000,
  );
  assert.match(requests[0].url, /\/timestamps\/1735689600\/block$/);
  assert.equal(requests[0].method, 'GET');
});

test('SQD follows stream continuation boundaries until the requested slot is complete', async () => {
  const bodies = [];
  const client = new SqdClient({
    portalUrl: 'https://portal.example/datasets/solana-mainnet',
    requestIntervalMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const lines = body.fromBlock === 100
        ? [
            { header: { number: 100, timestamp: 1735689600 } },
            { header: { number: 104, timestamp: 1735689602 } },
          ]
        : [
            { header: { number: 105, timestamp: 1735689603 } },
            { header: { number: 109, timestamp: 1735689605 } },
          ];
      return new Response(lines.map(JSON.stringify).join('\n'), {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    },
  });

  const blocks = [];
  for await (const block of client.streamInstructions({
    fromSlot: 100,
    toSlot: 109,
    programId: 'Program1111111111111111111111111111111111',
    cpiDiscriminatorHex: 'e445a52e51cb9a1d',
  })) {
    blocks.push(block.header.number);
  }

  assert.deepEqual(blocks, [100, 104, 105, 109]);
  assert.deepEqual(bodies.map((body) => body.fromBlock), [100, 105]);
  assert.equal(bodies[0].toBlock, 109);
  assert.equal(bodies[0].instructions[0].d8[0], '0xe445a52e51cb9a1d');
  assert.equal(bodies[0].instructions[0].isCommitted, true);
  assert.equal(bodies[0].instructions[0].transaction, true);
  assert.equal('where' in bodies[0].instructions[0], false);
  assert.equal('include' in bodies[0].instructions[0], false);
  assert.equal(bodies[0].fields.instruction.instructionAddress, true);
  assert.equal(bodies[0].fields.instruction.accounts, true);
  assert.equal(bodies[0].fields.transaction.transactionIndex, true);
  assert.equal(bodies[0].fields.transaction.signatures, true);
});

test('SQD retries HTTP 429 and honors retry-after', async () => {
  let calls = 0;
  const waits = [];
  const retries = [];
  const client = new SqdClient({
    portalUrl: 'https://portal.example/datasets/solana-mainnet',
    requestIntervalMs: 0,
    maxRetries: 2,
    sleepImpl: async (milliseconds) => waits.push(milliseconds),
    onRetry: (details) => retries.push(details),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '1' },
        });
      }
      return new Response(JSON.stringify({ dataset: 'solana-mainnet' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal((await client.metadata()).dataset, 'solana-mainnet');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
  assert.equal(retries[0].status, 429);
  assert.equal(retries[0].path, '/metadata');
});


test('SQD accepts a 204 empty finalized range without retrying', async () => {
  let calls = 0;
  const client = new SqdClient({
    portalUrl: 'https://portal.example/datasets/solana-mainnet',
    requestIntervalMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    },
  });

  const blocks = [];
  for await (const block of client.streamInstructions({
    fromSlot: 200,
    toSlot: 299,
    programId: 'Program1111111111111111111111111111111111',
    cpiDiscriminatorHex: 'e445a52e51cb9a1d',
  })) {
    blocks.push(block);
  }

  assert.equal(calls, 1);
  assert.deepEqual(blocks, []);
});


test('SQD accepts a successful empty 200 response as the end of a bounded filtered remainder', async () => {
  const bodies = [];
  const client = new SqdClient({
    portalUrl: 'https://portal.example/datasets/solana-mainnet',
    requestIntervalMs: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.fromBlock === 100) {
        return new Response(JSON.stringify({
          header: { number: 104, timestamp: 1735689600 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }
      return new Response('', {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    },
  });

  const blocks = [];
  for await (const block of client.streamInstructions({
    fromSlot: 100,
    toSlot: 109,
    programId: 'Program1111111111111111111111111111111111',
    cpiDiscriminatorHex: 'e445a52e51cb9a1d',
  })) {
    blocks.push(block.header.number);
  }

  assert.deepEqual(blocks, [104]);
  assert.deepEqual(bodies.map((body) => body.fromBlock), [100, 105]);
  assert.deepEqual(bodies.map((body) => body.toBlock), [109, 109]);
});

test('SQD gives worker-unavailable 503 responses at least five seconds before retrying', async () => {
  let calls = 0;
  const waits = [];
  const retries = [];
  const client = new SqdClient({
    portalUrl: 'https://portal.example/datasets/solana-mainnet',
    requestIntervalMs: 0,
    maxRetries: 1,
    retryBaseDelayMs: 1000,
    sleepImpl: async (milliseconds) => waits.push(milliseconds),
    onRetry: (details) => retries.push(details),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('No available workers to serve the request', {
          status: 503,
        });
      }
      return new Response(JSON.stringify({ dataset: 'solana-mainnet' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal((await client.metadata()).dataset, 'solana-mainnet');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [5000]);
  assert.equal(retries[0].status, 503);
  assert.equal(retries[0].waitMs, 5000);
});

test('SQD defaults to ten retries before failing a temporary service error', async () => {
  let calls = 0;
  const retries = [];
  const client = new SqdClient({
    portalUrl: 'https://portal.example/datasets/solana-mainnet',
    requestIntervalMs: 0,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 1,
    sleepImpl: async () => {},
    onRetry: (details) => retries.push(details),
    fetchImpl: async () => {
      calls += 1;
      return new Response('No available workers to serve the request', { status: 503 });
    },
  });
  await assert.rejects(() => client.metadata(), /HTTP 503/);
  assert.equal(calls, 11);
  assert.equal(retries.length, 10);
  assert.equal(retries.at(-1).maxRetries, 10);
});
