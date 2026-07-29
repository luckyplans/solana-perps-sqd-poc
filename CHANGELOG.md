# Changelog

## 0.3.0 — SQD historical source

- replaced direct Dune API backfill with SQD Portal `/finalized-stream`
- added Portal date-to-slot resolution
- added constant-memory NDJSON parsing and continuation
- added slot-based durable cursors and resume support
- added Portal 429/503 retry, pacing, and `Retry-After` handling
- added `sqd-status` CLI and REST diagnostics
- retained legacy Dune JSONL import only
- preserved Jupiter/GMTrade decoders, market registry, event logs, leaderboards, and Parquet export
