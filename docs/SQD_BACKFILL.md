# SQD backfill notes

## Request strategy

For each platform and slot range, the POC sends one logical query:

```json
{
  "type": "solana",
  "fromBlock": 311000000,
  "toBlock": 311024999,
  "fields": {
    "block": { "number": true, "timestamp": true },
    "transaction": { "signatures": true, "err": true },
    "instruction": {
      "programId": true,
      "data": true,
      "transactionIndex": true,
      "instructionAddress": true,
      "isCommitted": true,
      "error": true
    }
  },
  "instructions": [{
    "programId": ["PROTOCOL_PROGRAM_ID"],
    "d8": ["0xe445a52e51cb9a1d"]
  }]
}
```

The `d8` value is Anchor's event-CPI instruction tag. Jupiter/GMTrade event discriminators are bytes 8-15 and are filtered locally.

## Continuation

Portal can close a response before `toBlock`. The first and last covered slots act as continuation boundaries. The client repeats the same query with:

```text
fromBlock = last received block + 1
```

until the application window is complete.

## Resume

The persistent cursor stores the next application slot, not the current HTTP response boundary. This guarantees that a stopped process replays at most one configured window.

## Tuning

Start with:

```env
SQD_SLOT_BATCH_SIZE=25000
SQD_REQUEST_INTERVAL_MS=650
```

Reduce slot size when:

- responses are very large
- retries waste too much work
- the public endpoint times out

Increase slot size when:

- filters are highly selective
- responses are small
- request overhead dominates

Always compare `portalInstructions`, `targetInstructions`, `inserted`, and `failed` after changing the batch size.


## Related transaction inclusion

The instruction selector uses SQD's current relation syntax:

```json
{
  "where": {
    "programId": ["..."],
    "d8": ["0xe445a52e51cb9a1d"],
    "isCommitted": true
  },
  "include": {
    "transaction": true
  }
}
```

Requesting `fields.transaction.signatures` selects the transaction columns, but it does not by itself include the related transaction rows. The raw Portal selector flag `transaction: true` is required so `instruction.transactionIndex` can be resolved to its signature without fetching every transaction in the block.

## Raw Portal request shape

This project posts directly to `/finalized-stream`. The raw Portal API expects instruction filters and relation flags at the same level:

```json
{
  "instructions": [{
    "programId": ["PROGRAM_ID"],
    "d8": ["0xe445a52e51cb9a1d"],
    "isCommitted": true,
    "transaction": true
  }]
}
```

Do not wrap these values in `where` or `include`; those wrappers belong to higher-level SDK builder types and are rejected by the raw HTTP endpoint.
