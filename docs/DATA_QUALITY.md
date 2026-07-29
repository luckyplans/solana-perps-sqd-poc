# Data quality states

Every canonical event carries one of these values.

| Value | Meaning |
|---|---|
| `complete` | event, market mapping, collateral conversion, and prior position state are sufficient |
| `partialMarket` | the market/custody address has no configured pair or decimal mapping |
| `partialCollateral` | the transition is known, but collateral token metadata or historical USD pricing is incomplete |
| `partialState` | history began mid-position and prior size/collateral cannot be reconstructed safely |

The POC never invents a symbol, side, collateral value, leverage, or PnL to make a row appear complete.

## Typical causes

### Jupiter

- normal increase/decrease events contain USD values and can generally be complete
- a non-stable collateral-only deposit contains token amount but not historical USD price; without enrichment it may be `partialCollateral`
- a collateral event arriving before the position open is `partialState`

### GMTrade

- an unknown market token before `markets-sync` is `partialMarket`
- a synthetic index mint without a decodable mint account uses the market symbol decimal fallback where known
- missing long/short collateral mint metadata is `partialCollateral`

## Reconciliation workflow

1. run `markets-sync --platform GMTRADE --force`
2. list `/unknown-markets` or inspect `stats`
3. add a reviewed manual override only when discovery metadata is insufficient
4. for rows not yet stored, rerun the affected historical interval after correcting metadata; source-key dedupe makes replay idempotent
5. already-persisted canonical rows are immutable in this POC, so rebuild a fresh database or add a migration-time re-normalization job when correcting historical mappings
6. compare complete position lifecycles with the protocol UI or an independent indexer
7. publish rankings only after setting an acceptable completeness threshold

## Leaderboard formula

```text
gross PnL = sum(usdBasePnl)
fees paid = sum(abs(negative usdFee))
net PnL   = sum(usdPnl)
volume    = sum(sizeDeltaUsd)
```

A realized action is a close, decrease, or event carrying realized base PnL. Win rate uses net PnL on those realized actions. Max drawdown is based on cumulative daily realized net PnL, not intraday account equity.
