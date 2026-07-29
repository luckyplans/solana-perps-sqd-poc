# Changelog

## 0.4.0

- Split remote SQD fetching from canonical event-log construction.
- Added immutable local source chunks under `SOURCE_ARCHIVE_DIR`.
- Added compact ordered tuple records in gzip-compressed NDJSON.
- Added per-chunk manifests with slot coverage, counts, source policy, sizes, and SHA-256.
- Added atomic `.partial` writes and manifest-based gap/resume detection.
- Archive policy stores all committed Anchor CPI event instructions for the selected program, including event discriminators not currently mapped.
- Added `source-fetch`, `source-verify`, `source-stats`, and `event-build` CLI commands.
- Retained `backfill` as a two-stage compatibility facade.
- Added independent per-chunk event-build cursors keyed by build version and requested scope.
- Increased the default SQD retry count from 8 to 10.
- Added source archive and replay regression tests.

## 0.3.4

- Accepted successful empty bounded SQD stream remainders.
- Increased worker-unavailable retry cooldown.
