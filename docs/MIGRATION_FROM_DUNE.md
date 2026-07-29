# Migration from Dune

Dune is no longer the durable historical layer.

```text
Before: Dune SQL → decoder → event_logs
Now:    SQD → immutable local chunks → decoder → event_logs
```

Keep any already downloaded Dune JSONL files for cross-provider validation. Import remains supported, but new Solana history should use `source-fetch`.

The source archive is independent from the canonical database. A mapper fix requires only `event-build`; it does not consume SQD or Dune credits.
