# Changelog

## 0.3.3

- Request `transactionIndex` in SQD transaction fields.
- Resolve instructions against the original block transaction index.
- Add a safe fallback when Portal returns exactly one related transaction without its index.
- Improve missing-signature diagnostics.

## 0.3.2

- Fixed the raw SQD Portal `/finalized-stream` instruction selector.
- Portal filter and relation fields are now sent flat (`programId`, `d8`, `isCommitted`, `transaction`) rather than using the SDK-only `where` / `include` wrapper shape.
- Added regression assertions that reject the invalid nested request shape.

## 0.3.1 — Include related SQD transactions

- changed the Portal instruction selector to the current `{ where, include }` request shape
- explicitly includes each matching instruction's parent transaction
- resolves transaction signatures from both `signatures[]` and legacy `signature` response shapes
- adds diagnostic details when a related transaction is absent
- adds regression coverage for real high transaction indexes such as `1182`

## 0.3.0 — SQD historical source

- replaced direct Dune API backfill with SQD Portal `/finalized-stream`
- added Portal date-to-slot resolution
- added constant-memory NDJSON parsing and continuation
- added slot-based durable cursors and resume support
- added Portal 429/503 retry, pacing, and `Retry-After` handling
- added `sqd-status` CLI and REST diagnostics
- retained legacy Dune JSONL import only
- preserved Jupiter/GMTrade decoders, market registry, event logs, leaderboards, and Parquet export
