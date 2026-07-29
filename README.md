# LuckyPlans Solana Perps SQD Source Archive POC

A standalone TypeScript proof of concept for collecting **Jupiter Perps** and **GMTrade** Anchor CPI events from SQD, storing them as immutable local source chunks, and then building LuckyPlans-compatible `PerpTradingEventLog` rows from those files.

The architecture is intentionally two-stage:

```text
SQD Portal
   ↓
source-fetch
   ↓
immutable ordered .ndjson.gz chunks + manifests + SHA-256
   ↓
event-build
   ↓
Jupiter / GMTrade decoders
   ↓
LuckyPlans canonical event logs, position state, leaderboard
```

A decoder, mapper, or SQLite schema change no longer requires downloading the history from SQD again.

## Source archive policy

The archive uses the selected policy:

> Store every committed Anchor CPI event instruction emitted by the target program, not only event discriminators currently supported by the LuckyPlans mapper.

SQD filters remotely by:

```text
programId + Anchor CPI event tag + isCommitted
```

Current Jupiter/GMTrade event filtering occurs later during `event-build`. Historical or unknown event types therefore remain available for future decoder work.

## Chunk format

Default archive root:

```text
data/source-archive/solana-mainnet/JUPITER/
data/source-archive/solana-mainnet/GMTRADE/
```

A 25,000-slot window produces:

```text
000311081162-000311106161.v1.ndjson.gz
000311081162-000311106161.v1.manifest.json
```

Records are compact versioned tuples in exact slot/instruction order:

```json
[
  311081164,
  1735689600,
  "transaction-signature",
  1182,
  [4, 0],
  ["account-1", "account-2"],
  "base64-instruction-data"
]
```

Tuple schema:

```text
slot
blockTimestamp
signature
transactionIndex
instructionAddress
accounts
instructionDataBase64
```

The program ID, slot boundaries, query policy, compression, counts, timestamps, and SHA-256 are stored once in the manifest.

Files are first written with a `.partial` suffix and atomically renamed only after compression and manifest creation complete. Existing completed ranges are detected from manifests, so interrupted downloads resume without depending on the canonical SQLite database.

## Requirements

- Node.js 22.5+
- npm
- access to the configured SQD Portal
- Solana RPC only for GMTrade market metadata discovery
- Python/pyarrow only for optional Parquet export

## Installation

```bash
cp .env.example .env
npm ci
npm run typecheck
npm test
npm run build
```

## Configuration

```env
DATABASE_PATH=./data/solana-perps-poc.sqlite
SOURCE_ARCHIVE_DIR=./data/source-archive
EVENT_BUILD_BATCH_SIZE=1000

SQD_PORTAL_URL=https://portal.sqd.dev/datasets/solana-mainnet
SQD_SLOT_BATCH_SIZE=25000
SQD_REQUEST_TIMEOUT_MS=120000
SQD_MAX_RETRIES=10
SQD_RETRY_BASE_MS=1000
SQD_RETRY_MAX_MS=30000
SQD_REQUEST_INTERVAL_MS=650
```

`SQD_MAX_RETRIES` now defaults to **10**. HTTP 429, 502, 503, and 504 responses are retried with `Retry-After` support and bounded backoff. SQD worker-unavailable 503 responses have a minimum five-second wait.

## Stage 1: fetch source chunks

One-day Jupiter example:

```bash
node --env-file=.env \
  --no-warnings=ExperimentalWarning \
  dist/cli.js source-fetch \
  --platform JUPITER \
  --from 2025-01-01T00:00:00Z \
  --to 2025-01-02T00:00:00Z \
  --batch-slots 25000 \
  --resume
```

The command archives all target-program Anchor CPI instructions. It does not decode or insert canonical events.

Explicit inclusive slots are also supported:

```bash
node --env-file=.env dist/cli.js source-fetch \
  --platform JUPITER \
  --from-slot 311081162 \
  --to-slot 317661530 \
  --batch-slots 25000 \
  --resume
```

Inspect and verify the archive:

```bash
node --env-file=.env dist/cli.js source-stats --platform JUPITER
node --env-file=.env dist/cli.js source-verify --platform JUPITER
```

## Stage 2: build event logs locally

```bash
node --env-file=.env \
  --no-warnings=ExperimentalWarning \
  dist/cli.js event-build \
  --platform JUPITER \
  --from 2025-01-01T00:00:00Z \
  --to 2025-01-02T00:00:00Z \
  --resume
```

`event-build`:

1. verifies each compressed chunk checksum;
2. reads source records in order;
3. filters current protocol event discriminators locally;
4. decodes Jupiter or GMTrade payloads;
5. maps them into canonical LuckyPlans events;
6. updates position state and leaderboard data;
7. records a build cursor per chunk, scope, and `EVENT_BUILD_VERSION`.

Changing the decoder or mapper version can use a new build version and replay the same local archive into a fresh canonical database.

## Convenience command

`backfill` remains as a compatibility command, but it now performs the two explicit stages in order:

```bash
node --env-file=.env dist/cli.js backfill \
  --platform JUPITER \
  --from 2025-01-01T00:00:00Z \
  --to 2025-01-02T00:00:00Z \
  --batch-slots 25000 \
  --resume
```

It never passes SQD responses directly into the event-log mapper.

## GMTrade

Refresh dynamic market metadata before building GMTrade events:

```bash
node --env-file=.env dist/cli.js markets-sync --platform GMTRADE --force
```

Then fetch and build independently:

```bash
node --env-file=.env dist/cli.js source-fetch \
  --platform GMTRADE \
  --from-slot 319900000 \
  --to-slot 330000000 \
  --resume

node --env-file=.env dist/cli.js event-build \
  --platform GMTRADE \
  --resume
```

## Canonical storage

The current POC still uses the existing verbose `event_logs` schema so output remains comparable with earlier runs. The new local archive is the durable replay source. A later migration can safely replace the canonical table with a compact LuckyPlans `PerpTradingEventLog` schema without touching SQD.

Default canonical database:

```text
data/solana-perps-poc.sqlite
```

Useful commands:

```bash
node --env-file=.env dist/cli.js stats
node --env-file=.env dist/cli.js events --platform JUPITER --limit 20 --order desc
node --env-file=.env dist/cli.js leaderboard --platform JUPITER --limit 100
```

## Validation boundary

The automated suite covers chunk immutability, checksum verification, ordered replay, gap detection, local event filtering, per-chunk build resume, Jupiter legacy schemas, GMTrade normalization, and the 10-retry default. The packaging environment could not resolve `portal.sqd.dev`, so run `sqd-status` or a short `source-fetch` on a network-enabled machine for live verification.
