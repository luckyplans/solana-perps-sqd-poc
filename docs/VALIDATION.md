# Validation report

Validation for the SQD migration completed on 2026-07-29 with Node.js 22.

## Commands

```bash
npm ci
npm run typecheck
npm test
```

## Results

- strict TypeScript type check: passed
- clean TypeScript build: passed
- automated tests: 25 passed, 0 failed
- optional Parquet test: skipped when `pyarrow` is not installed
- SQD timestamp resolver fixture: passed
- SQD NDJSON continuation fixture: passed
- SQD HTTP 429/`Retry-After` fixture: passed
- SQD empty 204 finalized range fixture: passed
- SQD instruction-address mapping: passed
- non-target Anchor event filtering: passed
- cursor resume at completed slot boundary: passed
- Jupiter current and historical event layouts: passed
- GMTrade market discovery fixtures: passed
- canonical event, position, and leaderboard integration: passed

## Covered SQD behavior

- exact request shape for `/finalized-stream`
- minimal block, transaction, and instruction fields
- program ID plus Anchor CPI `d8` filter
- transaction-signature association by transaction index
- zero-based call-tree address conversion
- deeper CPI path encoding
- constant-memory NDJSON parsing
- continuation from the last returned slot plus one
- bounded retry and request pacing
- date-to-slot resolution
- full-window-only cursor advancement

## Package-registry boundary

A clean `npm ci` could not be repeated in the isolated packaging directory because the environment's internal npm mirror returned HTTP 404 for the TypeScript tarball and audit endpoint. The repository has only one development dependency (`typescript`); the source tree was type-checked and tested with TypeScript 5.8.3 already installed in the build environment. The lock file points to the public npm registry and should install normally in a standard developer environment.

## Network boundary

The packaging container could not resolve `portal.sqd.dev`, so a real mainnet SQD request was not claimed. The client and service are covered by HTTP/NDJSON fixtures matching the documented Portal API.

Run this first in the deployment environment:

```bash
node --env-file=.env dist/cli.js sqd-status \
  --from 2025-01-01T00:00:00Z \
  --to 2025-01-02T00:00:00Z
```

Then run a one-day Jupiter backfill and compare the resulting signatures and counts against the already downloaded Dune sample before expanding the range.

A fresh GMTrade market snapshot also requires a reachable Solana RPC:

```bash
node --env-file=.env dist/cli.js markets-sync --platform GMTRADE --force
```

- Regression: partial SQD continuation followed by an empty bounded finalized-stream response is accepted without skipping a failed cursor window.
- Regression: SQD HTTP 503 worker-unavailable responses wait at least five seconds before retrying.
