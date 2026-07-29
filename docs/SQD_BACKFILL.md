# SQD source-fetch notes

## Raw Portal request

Each platform/range uses a flat raw Portal selector:

```json
{
  "type": "solana",
  "fromBlock": 311000000,
  "toBlock": 311024999,
  "fields": {
    "block": { "number": true, "timestamp": true },
    "transaction": { "transactionIndex": true, "signatures": true, "err": true },
    "instruction": {
      "programId": true,
      "data": true,
      "transactionIndex": true,
      "instructionAddress": true,
      "isCommitted": true,
      "error": true
    }
  },
  "instructions": [{
    "programId": ["PROTOCOL_PROGRAM_ID"],
    "d8": ["0xe445a52e51cb9a1d"],
    "isCommitted": true,
    "transaction": true
  }]
}
```

`d8` is Anchor's event-CPI tag. Bytes 8-15 contain the protocol event discriminator, which is intentionally not filtered during source fetch.

## Commands

Fetch only:

```bash
node --env-file=.env dist/cli.js source-fetch \
  --platform JUPITER \
  --from 2025-01-01T00:00:00Z \
  --to 2025-02-01T00:00:00Z \
  --batch-slots 25000 \
  --resume
```

Build only:

```bash
node --env-file=.env dist/cli.js event-build \
  --platform JUPITER \
  --from 2025-01-01T00:00:00Z \
  --to 2025-02-01T00:00:00Z \
  --resume
```

Verify:

```bash
node --env-file=.env dist/cli.js source-verify --platform JUPITER
```

## Retry policy

Default:

```env
SQD_MAX_RETRIES=10
SQD_RETRY_BASE_MS=1000
SQD_RETRY_MAX_MS=30000
```

HTTP 429, 502, 503, and 504 are retried. `Retry-After` is honored. A worker-unavailable 503 waits at least five seconds.

## Resume policy

Source fetch does not depend on an SQLite cursor. Completed manifests define covered slot intervals. The service fetches only uncovered gaps and writes one immutable chunk per configured window.

Event build uses independent per-chunk cursors. Deleting the canonical database resets build progress without deleting or redownloading source chunks.
