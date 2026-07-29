# Migration from the Dune POC

## Removed

- Dune API key and performance-tier configuration
- raw SQL execution and polling
- Dune result pagination
- credit-consuming date windows
- SQL template CLI command

## Added

- SQD Portal finalized instruction streaming
- date-to-slot resolution
- NDJSON continuation
- slot-based durable cursors
- Portal rate-limit retry and pacing
- `sqd-status` CLI/REST diagnostics

## Preserved

- Jupiter and GMTrade event decoders
- historical Jupiter layout compatibility
- canonical event model
- position reducer
- leaderboard materialization
- SQLite schema
- Parquet export
- market registry and GMTrade discovery
- legacy Dune JSONL import

## Existing database

An existing SQLite database can be reused. SQD has its own cursor keys:

```text
sqd:JUPITER:next-slot
sqd:GMTRADE:next-slot
```

Dune cursor records are ignored. Canonical source uniqueness prevents duplicate events when SQD replays signatures that were already inserted through Dune.

## Recommended first run

Use a fresh database for the provider-completeness benchmark, then compare signatures and counts with the old Dune database. After validation, either keep the fresh SQD database or point the new code at the existing database and replay the full range with `--resume` disabled for the first SQD pass.
