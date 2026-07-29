# LuckyPlans Solana Perps SQD Backfill POC

A standalone, backfill-only TypeScript proof of concept for indexing **Jupiter Perps** and **GMTrade** into a LuckyPlans-compatible canonical event-log and leaderboard model.

The direct historical source is now **SQD Portal**, not Dune:

```text
SQD Solana finalized instruction stream
                 ↓
       Anchor CPI envelope filter
                 ↓
       Jupiter / GMTrade decoder
                 ↓
   canonical LuckyPlans trade actions
                 ↓
 SQLite event log + position reducer
                 ↓
       daily trader leaderboard
                 ↓
       optional Parquet archive
```

The protocol decoders, canonical model, market registry, event-log service, leaderboard service, and SQLite schema remain independent from the historical provider so they can be moved into the LuckyPlans main repository.

## Why SQD

- It streams filtered Solana instructions directly by program ID and 8-byte discriminator.
- It returns newline-delimited JSON and is processed in constant memory.
- The backfill uses `/finalized-stream`, so no live-chain rollback handling is required.
- Date ranges are resolved to exact Solana slots through the Portal timestamp endpoint.
- The public Solana Portal can be tested without a Dune API key.
- A private or self-hosted Portal can later replace the public URL without changing the protocol adapters.

## Included functionality

### Historical ingestion

- SQD `/finalized-stream` client using Node's built-in `fetch`
- program-level filtering for Jupiter and GMTrade
- Anchor event-CPI discriminator filtering at the Portal
- local filtering by supported Jupiter/GMTrade event discriminator
- NDJSON streaming without loading a complete response into memory
- automatic continuation when Portal ends a response before `toBlock`
- date-to-slot resolution
- explicit slot-range backfills
- bounded retries, `Retry-After` support, and request pacing
- resumable slot cursors
- exact transaction and instruction source coordinates

### Jupiter Perps

- increase and instant-increase events
- decrease and instant-decrease events
- collateral deposit and withdrawal
- partial and full liquidation
- legacy, intermediate, and current historical event layouts
- documented mainnet custody registry for SOL, ETH, BTC, USDC, USDT, and JupUSD

### GMTrade

- executed `TradeEvent` CPI decoder
- before/after position state
- open, increase, decrease, close, and collateral-only transition classification
- realized PnL and fee buckets
- liquidation detection
- dynamic market discovery from zero-copy on-chain `Market` accounts
- retention of disabled markets for historical resolution

### Storage and APIs

- immutable canonical `event_logs`
- reduced `position_states`
- materialized `leaderboard_daily`
- `backfill_jobs` and `ingestion_cursors`
- CLI and REST event-log queries
- optional Zstandard-compressed Parquet partitions
- legacy JSONL import for Dune files already downloaded before this migration

## Requirements

- Node.js 22.5 or later
- npm
- internet access to the configured SQD Portal
- a Solana RPC only when synchronizing GMTrade market metadata
- Python and `pyarrow` only for optional Parquet export

## Installation

```bash
cp .env.example .env
npm ci
npm run typecheck
npm test
npm run build
```

No SQD API key is required by the default public development endpoint.

## Configuration

```env
SQD_PORTAL_URL=https://portal.sqd.dev/datasets/solana-mainnet
SQD_SLOT_BATCH_SIZE=25000
SQD_REQUEST_TIMEOUT_MS=120000
SQD_MAX_RETRIES=8
SQD_RETRY_BASE_MS=1000
SQD_RETRY_MAX_MS=30000
SQD_REQUEST_INTERVAL_MS=650
```

Start with 25,000 slots per application window. Smaller batches make failures cheaper to retry; larger batches reduce request overhead.

`SQD_SLOT_BATCH_SIZE` is the POC's durable cursor window. Portal can internally stop a single stream response before that boundary; the client automatically continues from the last returned slot plus one.

## Verify SQD connectivity

```bash
node --env-file=.env \
  --no-warnings=ExperimentalWarning \
  dist/cli.js sqd-status \
  --from 2025-01-01T00:00:00Z \
  --to 2025-01-02T00:00:00Z
```

Expected output includes:

```json
{
  "portalUrl": "https://portal.sqd.dev/datasets/solana-mainnet",
  "metadata": {},
  "range": {
    "requestedFrom": "2025-01-01T00:00:00.000Z",
    "requestedTo": "2025-01-02T00:00:00.000Z",
    "fromSlot": 0,
    "toSlot": 0
  }
}
```

The slot numbers above are illustrative; the command prints Portal-resolved values.

## First Jupiter benchmark

Use one day first:

```bash
node --env-file=.env \
  --no-warnings=ExperimentalWarning \
  dist/cli.js backfill \
  --platform JUPITER \
  --from 2025-01-01T00:00:00Z \
  --to 2025-01-02T00:00:00Z \
  --batch-slots 25000 \
  --resume
```

The result includes:

```text
windows             completed durable slot windows
blocks              SQD block objects received
portalInstructions  Anchor CPI event instructions returned by SQD
targetInstructions  supported protocol events passed to the decoder
filteredEvents      non-target Anchor events discarded locally
inserted             canonical rows newly stored
duplicate            source-coordinate duplicates
ignored              valid events that intentionally produce no canonical action
unsupported          recognized target events without decoder support
failed               decode or ingestion failures
```

A successful window advances:

```text
ingestion_cursors.key = sqd:JUPITER:next-slot
```

## Full Jupiter backfill

```bash
node --env-file=.env \
  --no-warnings=ExperimentalWarning \
  dist/cli.js backfill \
  --platform JUPITER \
  --from 2025-01-01T00:00:00Z \
  --to 2025-02-01T00:00:00Z \
  --batch-slots 25000 \
  --resume
```

Date ranges are closed-open: `[from, to)`. They are resolved to an inclusive slot range before ingestion.

You may bypass timestamp lookup with explicit inclusive slots:

```bash
node --env-file=.env dist/cli.js backfill \
  --platform JUPITER \
  --from-slot 311000000 \
  --to-slot 311100000 \
  --batch-slots 25000 \
  --resume
```

## GMTrade backfill

GMTrade events reference market-token mints. Refresh market metadata before the first run:

```bash
node --env-file=.env dist/cli.js markets-sync \
  --platform GMTRADE \
  --force
```

Then backfill:

```bash
node --env-file=.env \
  --no-warnings=ExperimentalWarning \
  dist/cli.js backfill \
  --platform GMTRADE \
  --from 2025-01-01T00:00:00Z \
  --to 2025-02-01T00:00:00Z \
  --batch-slots 25000 \
  --resume
```

With `AUTO_SYNC_MARKETS=true`, a GMTrade backfill refreshes market metadata automatically. Manual registry entries are preserved unless `--replace-manual` is explicitly used in `markets-sync`.

## Event logs

Default database:

```text
data/solana-perps-poc.sqlite
```

Primary table:

```text
event_logs
```

View counts:

```bash
node --env-file=.env dist/cli.js stats
```

View recent Jupiter actions:

```bash
node --env-file=.env dist/cli.js events \
  --platform JUPITER \
  --limit 20 \
  --order desc
```

Filter closes:

```bash
node --env-file=.env dist/cli.js events \
  --platform JUPITER \
  --operation close \
  --limit 100 \
  --order desc
```

Canonical operations:

```text
open
close
increaseSize
decreaseSize
increaseLeverage
decreaseLeverage
pnlWithdraw
```

## Leaderboard

Rebuild from canonical history:

```bash
node --env-file=.env dist/cli.js leaderboard-rebuild \
  --platform JUPITER
```

Query:

```bash
node --env-file=.env dist/cli.js leaderboard \
  --platform JUPITER \
  --sortBy netPnl \
  --minActions 10 \
  --limit 100
```

Metrics include gross realized PnL, fees, net realized PnL, volume, actions, winning/losing closes, win rate, liquidation count, and realized-PnL drawdown.

## HTTP server

```bash
node --env-file=.env dist/cli.js serve
```

Default URL:

```text
http://127.0.0.1:3100
```

Important endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | process and provider status |
| GET | `/sqd/status?from=...&to=...` | Portal metadata and resolved slots |
| GET | `/event-logs` | canonical events |
| GET | `/leaderboard` | trader ranking |
| GET | `/markets` | active market registry |
| GET | `/unknown-markets` | unresolved source market addresses |
| GET | `/backfills` | backfill jobs |
| POST | `/admin/backfill` | run an SQD backfill |
| POST | `/admin/markets/sync` | refresh market metadata |
| POST | `/admin/leaderboard/rebuild` | rebuild daily aggregates |
| POST | `/admin/parquet-export` | export canonical partitions |

Example REST backfill:

```bash
curl -X POST http://127.0.0.1:3100/admin/backfill \
  -H 'content-type: application/json' \
  -d '{
    "platform": "JUPITER",
    "from": "2025-01-01T00:00:00Z",
    "to": "2025-01-02T00:00:00Z",
    "batchSlots": 25000,
    "resume": true
  }'
```

## Idempotency and failure behavior

Every canonical source row is identified by:

```text
platform
+ transaction signature
+ outer instruction index
+ inner instruction path encoding
+ event discriminator
```

The cursor advances only after the complete application slot window succeeds. Re-running a failed window is safe: previously committed actions are reported as duplicates.

A supported discriminator that cannot be decoded is fatal for that window. A different Anchor CPI event emitted by the same program is counted as `filteredEvents` and does not stop ingestion.

## SQD source-coordinate mapping

SQD reports an instruction call-tree address such as:

```text
[3, 0]
```

The POC maps this to the existing LuckyPlans-style coordinates:

```text
outerInstructionIndex = 4
innerInstructionIndex = 1
```

Deeper paths are deterministically encoded in base 10,000 so they remain unique inside the current integer schema. The recommended production model is to persist the complete instruction-address array as well as conventional outer/inner fields.

## Parquet export

```bash
npm run parquet:install
node --env-file=.env dist/cli.js parquet-export \
  --platform JUPITER \
  --from 2025-01-01 \
  --to 2025-02-01 \
  --overwrite
```

Output layout:

```text
data/parquet/
  platform=JUPITER/year=2025/month=01/canonical-actions.parquet
```

Raw Solana transactions and raw instruction bytes are never exported.

## Legacy Dune JSONL import

Direct Dune API execution has been removed. The old row converter remains only to import files already downloaded:

```bash
node --env-file=.env dist/cli.js jsonl-import \
  --platform JUPITER \
  --file examples/dune-row.jsonl
```

This path does not consume Dune credits.

## Repository structure

```text
src/
  backfill/
    sqd-client.ts
    sqd-backfill.service.ts
    dune-row.ts                 legacy JSONL converter only
    jsonl-import.service.ts
  codec/                        Base58, Borsh, Anchor CPI helpers
  domain/                       canonical provider-neutral model
  platforms/
    jupiter/                    version-aware event decoders and adapter
    gmtrade/                    TradeEvent decoder and adapter
  markets/                      Jupiter static and GMTrade dynamic metadata
  services/                     ingestion, events, leaderboard, market registry
  storage/                      SQLite persistence
  export/                       optional Parquet bridge
  http/                         standalone POC API

docs/
  ARCHITECTURE.md
  MIGRATION_TO_LUCKYPLANS.md
  PROTOCOL_INTERFACES.md
  DATA_QUALITY.md
  VALIDATION.md
```

## Production boundary

The default SQD endpoint is a public development endpoint. Before using it as a permanent production dependency, measure throughput and provider limits and choose one of:

- an SQD production Portal plan
- an SQD-managed indexer
- a self-hosted Portal

The provider-neutral `SqdClient` boundary means that transition requires a URL/configuration change rather than a rewrite of Jupiter, GMTrade, storage, or leaderboard logic.
