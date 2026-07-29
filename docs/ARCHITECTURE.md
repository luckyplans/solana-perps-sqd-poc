# Source archive architecture

## Data flow

```text
SQD Portal /finalized-stream
              ↓
       SqdSourceFetchService
              ↓
  immutable ordered source chunks
      (.ndjson.gz + manifest)
              ↓
        EventBuildService
              ↓
     PlatformAdapterRegistry
        ↙              ↘
 GMTradeAdapter     JupiterAdapter
        ↘              ↙
     CanonicalPerpTradeHistory
              ↓
 event_logs + position_states + leaderboard_daily
```

The network stage and model-building stage are independent. SQD transport failures cannot leave a half-decoded chunk, and decoder/schema changes do not require another SQD download.

## Source archive boundary

SQD filters by:

```text
programId = target protocol
AND d8 = Anchor event-CPI tag
AND isCommitted = true
```

The archive retains every matching target-program instruction, including event discriminators not currently recognized by the platform adapter. Supported-event filtering happens only in `EventBuildService`.

The minimal replay record contains:

- slot
- block timestamp
- transaction signature
- transaction index
- full raw instruction-address path
- raw instruction bytes encoded as base64

The program ID and query policy are stored once in the chunk manifest.

## Chunk durability

Each logical slot window is written as:

```text
<from>-<to>.v1.ndjson.gz.partial
<from>-<to>.v1.manifest.json.partial
```

After compression and SHA-256 calculation, both files are atomically renamed to their final names. A completed manifest is the durable source-fetch cursor. Gap detection subtracts completed manifest ranges from a requested range, so source resume is independent from SQLite.

## Build cursor

Canonical build progress remains in SQLite but is independent of source coverage. A cursor is stored per:

```text
platform + EVENT_BUILD_VERSION + requested scope + chunk ID
```

A failed chunk is replayed. Existing canonical source-coordinate uniqueness makes partial retries idempotent.

Changing mapping semantics should increment `EVENT_BUILD_VERSION` and build into a fresh canonical database or dedicated versioned tables.

## Why finalized slots

Historical collection uses `/finalized-stream`. Finalized data avoids reorg rollback handling. Date ranges are resolved to slots as:

```text
[fromDate, toDate)
       ↓
[fromSlot, firstSlotAtOrAfterToDate - 1]
```

## Portal continuation

SQD can finish one HTTP response before the requested `toBlock`. The client resumes from `lastBlock + 1`. A successful empty bounded response is accepted because filtered blocks may all be omitted.

## Canonical database

The current POC deliberately preserves the old verbose `event_logs` schema for result comparison. It is derived data and can be replaced later with a compact LuckyPlans `PerpTradingEventLog` model. The source archive is the durable replay layer.

## Production migration

Reusable modules:

- `src/archive/source-chunk-store.ts`
- `src/backfill/sqd-client.ts`
- `src/backfill/sqd-source-fetch.service.ts`
- `src/backfill/event-build.service.ts`
- `src/codec`
- `src/platforms`
- `src/domain`

Production replacements:

- local archive directory → MinIO/S3-compatible object storage
- SQLite canonical store → PostgreSQL/ClickHouse
- CLI loops → worker queue
- local manifest discovery → object catalog or metadata table
