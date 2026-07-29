# Migration to the LuckyPlans backend

The POC separates SQD transport, protocol decoding, canonical actions, persistence, and APIs so the useful layers can move into the current LuckyPlans services without forcing Solana into EVM `eth_getLogs` abstractions.

## 1. Add Solana identity explicitly

Add `GMTRADE` and `JUPITER` to the platform enum. Do not represent Solana mainnet as an EVM chain ID. Add a chain-family/network field where existing helpers assume hex addresses, block numbers, or log indexes.

Never lowercase Solana public keys.

## 2. Reuse the canonical history contract

Map `CanonicalPerpTradeHistory` to LuckyPlans `PurePerpTradeHistory`. Persist exact integers or Prisma `Decimal`; convert to JavaScript numbers only at the presentation boundary.

Add Solana source metadata:

- `programId`
- `slot` as `BigInt`
- `outerInstructionIndex`
- `innerInstructionIndex`
- full `instructionAddress` when the production schema is changed
- `eventDiscriminator`
- `ingestionSource`

Use the unique constraint supplied in `migration/prisma-models.prisma`.

## 3. Move reusable modules

Recommended destination:

```text
src/web3/solana/
  codec/
  domain/
  history/sqd-client.ts
  history/sqd-history-source.ts
  markets/

src/web3/platform/gmtrade/
  constants.ts
  decoder.ts
  adapter.ts

src/web3/platform/jupiter/
  constants.ts
  decoder.ts
  adapter.ts
```

Adapters should consume a small normalization context and remain independent from Prisma, NestJS, HTTP, and SQD.

## 4. Introduce a provider-neutral history source

```ts
interface PerpHistorySource {
  backfill(input: BackfillRange): AsyncIterable<SourceInstruction[]>;
}
```

Implementations:

```text
EvmLogHistorySource
  ├── GNS
  ├── GMX
  └── Avantis

SqdSolanaInstructionHistorySource
  ├── GMTrade
  └── Jupiter Perps
```

The SQD implementation should own timestamp-to-slot resolution, finalized stream continuation, retries, and slot cursors. It should not contain protocol-specific Borsh decoding.

## 5. Use a worker

```text
analytics worker
  → synchronize GMTrade markets when required
  → resolve requested dates to slots
  → stream finalized SQD slot windows
  → normalize and persist canonical actions
  → update daily leaderboard
  → compact/export completed partitions

API service
  → query event history and leaderboard
```

Do not run a large backfill inside a request-handling process. The POC REST endpoint is only for demonstration.

## 6. Cursor semantics

Persist a provider/platform cursor such as:

```text
sqd:JUPITER:next-slot
sqd:GMTRADE:next-slot
```

Advance it only after a complete application slot window succeeds. Portal may split one requested range into several HTTP responses; those continuation boundaries are not durable cursor boundaries.

Retry the same failed window unchanged. Source-coordinate uniqueness makes partial commits idempotent.

## 7. Market metadata

### Jupiter

Ship the reviewed custody registry in source control. Treat additions or changes as protocol configuration updates.

### GMTrade

Discover on-chain `Market` accounts on deployment and periodically thereafter. Persist:

- market account
- market token mint
- index token mint
- long and short collateral mints
- mint decimals
- pair name
- enabled/disabled state
- verification timestamp and source

Manual overrides must survive refreshes.

## 8. Storage strategy

```text
PostgreSQL
  - market registry
  - jobs and cursors
  - daily leaderboard
  - queryable canonical events

Parquet/ClickHouse
  - complete canonical action archive
```

The POC SQLite schema demonstrates transaction boundaries, not the final production scaling choice.

## 9. Leaderboard interpretation

The included leaderboard is based on realized trading history:

- realized PnL
- fees
- net realized PnL
- volume
- wins/losses
- liquidations
- realized-PnL drawdown

Do not label it account ROI until deposits, withdrawals, funding, unrealized PnL, and equity snapshots are reconciled.

## 10. Production checklist

- verify SQD metadata and timestamp resolution
- backfill one day for Jupiter and record Portal/target/inserted counts
- compare the same day with previously downloaded Dune signatures
- backfill one week before expanding to full history
- synchronize GMTrade markets and inspect disabled-market retention
- verify at least 20 complete position lifecycles per protocol
- include partial changes, collateral changes, liquidations, and duplicate replay
- compare size, collateral, price, fees, and PnL with protocol UIs
- interrupt at multiple slot boundaries and verify `--resume`
- query exported Parquet independently
- alert on new/unknown event discriminators
- select a production SQD endpoint or self-hosted Portal after throughput benchmarking
