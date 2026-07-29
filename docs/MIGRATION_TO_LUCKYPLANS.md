# Migration to the LuckyPlans backend

## Target architecture

```text
SQD collector worker
  → immutable Solana program-instruction chunks
  → MinIO/S3-compatible source archive

PerpTradingEventLog builder worker
  → reads source chunks
  → protocol decoder
  → LuckyPlans mapper
  → PostgreSQL canonical event logs
```

Do not decode directly inside the SQD collector.

## Source archive object

Persist the tuple payload and manifest fields demonstrated by this POC:

- platform/program ID
- inclusive slot range
- slot and block timestamp
- transaction signature and transaction index
- full instruction-address path
- raw instruction bytes
- record and block counts
- compression and SHA-256
- source query version

The archive stores every committed Anchor CPI event for the target program, not only current mapped events.

## Canonical mapping

The builder maps replayable source records through:

```text
ArchivedInstructionRecord
  → SourceInstruction
  → Jupiter/GMTrade decoded event
  → LuckyPlans PerpTradingEventLog mapper
  → PerpTradingEventLog
```

The mapper owns operation classification, PnL/fee signs, before/after state, liquidation reason, and partial-state handling.

## Versioning

Version these independently:

- source chunk format
- SQD query policy
- protocol decoder
- LuckyPlans mapper
- canonical schema

Changing decoder or mapper behavior should not alter immutable source chunks. Rebuild a new canonical version locally.

## Cursors

Source coverage is represented by completed object manifests, not the canonical database.

Build progress is keyed by:

```text
platform + build version + scope + source chunk ID
```

Only mark a source chunk built after all target records in that chunk have completed without failed/unsupported decoder results.

## Storage migration

Recommended production split:

```text
MinIO
  source/solana-mainnet/JUPITER/<slot-range>.ndjson.gz
  source/solana-mainnet/GMTRADE/<slot-range>.ndjson.gz

PostgreSQL
  PerpTradingEventLog
  position state
  leaderboard materializations
  build jobs/cursors
```

The current verbose SQLite `event_logs` table is compatibility-only. Once source replay is validated, replace it with the actual LuckyPlans model and remove redundant decoded JSON from the canonical row.

## Validation checklist

- compare source manifest record counts with SQD response counts
- verify SHA-256 before each build
- confirm source records remain ordered
- rebuild a fresh canonical DB without network access
- compare old/new canonical hashes after mapper changes
- inspect ignored events by discriminator and reason
- verify complete position lifecycles
- interrupt source fetch and build independently, then resume
- upload source chunks to MinIO and replay from downloaded objects
