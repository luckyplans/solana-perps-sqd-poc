# Validation

v0.4.0 automated checks cover:

- TypeScript typecheck and build
- immutable gzip source chunk creation
- atomic manifest/data naming
- SHA-256 verification
- ordered source record replay
- archive coverage and gap detection
- all target-program Anchor CPI events retained before local filtering
- local supported-event filtering during event build
- independent per-chunk event-build resume
- 10 default SQD retries
- HTTP 429 retry and Retry-After
- HTTP 503 worker-unavailable cooldown
- bounded empty SQD response handling
- Jupiter current and historical layouts
- GMTrade normalization
- canonical idempotent ingestion

The packaging environment could not resolve `portal.sqd.dev`; a live source fetch must be run from a network-enabled host.
