# Backfill architecture

## Data flow

```text
SQD Portal /finalized-stream
              ↓
       SourceInstruction
              ↓
     PlatformAdapterRegistry
        ↙              ↘
 GMTradeAdapter     JupiterAdapter
        ↘              ↙
     CanonicalPerpTradeHistory
              ↓
       transactional ingest
        ↙       ↓        ↘
 event_logs  position  leaderboard_daily
              ↓
    optional Parquet exporter
```

`SourceInstruction` is provider-neutral. The SQD transport, legacy JSONL importer, protocol adapters, and persistence layer do not import each other directly.

## Why finalized slots

Historical ingestion uses SQD `/finalized-stream` rather than the real-time `/stream` endpoint. Finalized data does not require reorg rollback state, which keeps this POC append-only and aligned with the existing LuckyPlans historical event-log flow.

A date range is converted to slots by the Portal timestamp endpoint:

```text
[fromDate, toDate)
       ↓
[fromSlot, firstSlotAtOrAfterToDate - 1]
```

Explicit inclusive slot ranges are also accepted.

## Two continuation layers

There are two different range boundaries:

1. **Application window** — durable cursor unit, normally 25,000 slots.
2. **Portal response boundary** — SQD may end an NDJSON response before the requested `toBlock`.

The client continues a Portal response from `lastBlock + 1`. The persistent cursor advances only after the complete application window succeeds.

## Portal filter

Both protocols use Anchor self-CPI events:

```text
8-byte Anchor event-CPI tag
8-byte event discriminator
Borsh event payload
```

SQD can filter the first eight bytes, so the request selects:

```text
programId = Jupiter or GMTrade
AND d8 = Anchor event-CPI tag
```

The service then filters the second discriminator locally against the adapter's supported event set. This avoids downloading normal protocol instructions while still handling every supported event type in one stream.

## Transaction and instruction identity

A Solana transaction may contain several outer instructions and nested CPI calls. SQD supplies:

- `transactionIndex`
- transaction signatures
- `instructionAddress` call-tree path

The POC's immutable source key remains:

```text
platform + signature + outer index + encoded inner path + event discriminator
```

For a direct CPI path `[outer, inner]`, each zero-based component is converted to the existing one-based LuckyPlans convention. Deeper paths are deterministically encoded in base 10,000. Production migration should additionally retain the complete call-tree path.

## Ingestion transaction

For every target instruction, ingestion:

1. validates the platform and program ID
2. decodes the Anchor CPI envelope
3. selects a version-aware protocol event decoder
4. resolves market metadata
5. loads prior reduced position state
6. classifies the canonical transition
7. atomically writes event log, next position state, and daily leaderboard delta
8. treats a source-key conflict as an idempotent duplicate

A target event that fails decoding prevents cursor advancement. A different Anchor event from the same program is counted as filtered and does not fail the window.

## Market registry

### Jupiter

Jupiter emits custody accounts. The repository ships a reviewed mainnet custody registry and expands index/collateral combinations into exact market mappings.

### GMTrade

GMTrade emits a market-token mint. Before backfill, the POC can discover zero-copy `Market` accounts through a low-volume Solana RPC call, resolve SPL mint decimals, and atomically update the market registry. Disabled markets are retained because old events still need historical resolution.

## State reduction

```text
0 → positive size       open
larger size             increaseSize
smaller nonzero size    decreaseSize
positive → 0            close
same size, less margin  increaseLeverage
same size, more margin  decreaseLeverage
```

Unknown fields from old protocol layouts produce `partialState`; they are never fabricated as zero.

## Persistence

SQLite tables:

- `event_logs`
- `position_states`
- `leaderboard_daily`
- `ingestion_cursors`
- `backfill_jobs`

The database does not store raw Solana transactions or instruction payloads. The canonical row stores source metadata and decoded accounting values.

## Parquet layout

```text
platform=<PLATFORM>/year=<YYYY>/month=<MM>/canonical-actions.parquet
```

Canonical numeric values use `decimal128(38,6)`. Raw source payloads and debug JSON are excluded.

## Migration boundary

Move nearly unchanged:

- `src/codec`
- `src/domain`
- `src/platforms`
- `src/markets`
- `src/backfill/sqd-client.ts`
- `src/backfill/sqd-backfill.service.ts`

Replace in LuckyPlans:

- SQLite with Prisma/PostgreSQL or ClickHouse
- direct CLI with a NestJS worker/queue
- JSON market registry with reviewed config or database records
- local Parquet output with MinIO/object storage
