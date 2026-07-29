# Market registry

`markets.json` is a real versioned registry, not a mock template.

- Jupiter mappings are pre-populated from its official mainnet custody documentation.
- GMTrade mappings are dynamic and are added by querying all on-chain `Market` accounts, while retaining each account’s current enabled status so disabled historical markets remain resolvable.

Refresh GMTrade:

```bash
node --env-file=.env ../dist/cli.js markets-sync --platform GMTRADE --force
```

A row with `source: "manual"` is retained during automatic refresh. Use manual definitions only for reviewed overrides.
