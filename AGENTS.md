# Coding notes

This repository is a dependency-light, backfill-only TypeScript proof of concept. Domain models and protocol adapters are intentionally independent from HTTP, SQLite, SQD Portal, and Parquet so they can move into LuckyPlans without transport coupling.

## Verification

```bash
npm ci
npm run typecheck
npm test
```

Node 22.5 or later is required for built-in `fetch` and `node:sqlite`. Parquet tests run when Python `pyarrow` is installed and otherwise skip with an explicit message.

## Invariants

- Never lowercase Solana public keys; Base58 addresses are case-sensitive.
- Never persist raw Solana transactions or instruction bytes.
- Dedupe by platform, signature, outer index, inner index, and event discriminator.
- Use signed fixed-point integers internally; do not use floating-point accounting.
- Decode only executed CPI events, not position/order requests.
- Use SQD `/finalized-stream` for historical ingestion; no reorg state belongs in this POC.
- Advance a backfill cursor only after the full chronological slot window succeeds.
- Unknown metadata must produce a partial data-quality state, never invented values.
- Jupiter custody mappings come from the official static registry.
- GMTrade production markets come from zero-copy `Market` account discovery, not frozen mock addresses.
- Keep this POC backfill-only. Live subscription concerns belong in a separate adapter/service.
- Keep the legacy Dune JSONL converter only for previously downloaded files; Dune is not a direct backfill provider.
