# Protocol interfaces used by the POC

## Anchor CPI envelope

Both protocols emit typed events as self-CPI instructions:

```text
8-byte Anchor event-CPI tag
8-byte event discriminator
Borsh event payload
```

The SQD request filters by protocol program ID and the first 8-byte CPI tag. The POC then checks the second 8-byte event discriminator locally before calling a protocol decoder.

## GMTrade

- program: `Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo`
- executed event: `TradeEvent`
- event discriminator: `bddb7fd34ee661ee`
- program USD precision: 20 decimals

The decoder reads trader, position, order, market token, timestamp/slot, before/after position state, execution price, price impact, realized PnL, and fee buckets.

### Dynamic market metadata

The zero-copy `Market` prefix contains flags, name, market token mint, index token mint, long/short token mints, and store address. The POC discovers these accounts through Solana RPC and resolves mint decimals. This is independent from the SQD historical stream.

## Jupiter Perps

- program: `PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu`
- normalized USD/price precision in this POC: 6 decimals

Supported events:

| Event | Discriminator |
|---|---|
| `IncreasePositionEvent` | `f5715534d6bb9984` |
| `DecreasePositionEvent` | `409c2b4a6d83107f` |
| `LiquidatePositionEvent` | `68452084d423bf2f` |
| `LiquidateFullPositionEvent` | `806547a880485654` |
| `InstantIncreasePositionEvent` | `cdec3904d16a5745` |
| `InstantDecreasePositionEvent` | `abad6a19efbe3a3b` |
| `DepositCollateralEvent` | `a90e66949b8912eb` |
| `WithdrawCollateralEvent` | `91262e57be95fdbf` |

The decoder supports historical layout changes that reused the same discriminator. Old events lacking later collateral/fee-state extensions are marked `partialState` while preserving the fields actually present.

### Mainnet custody registry

The repository includes custody addresses for SOL, ETH, BTC, USDC, USDT, and JupUSD. SOL, ETH, and BTC are index markets; all supported custodies can resolve collateral metadata.
