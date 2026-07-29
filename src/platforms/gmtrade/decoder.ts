import { unwrapAnchorCpiEvent } from '../../codec/anchor';
import { BorshReader } from '../../codec/borsh';
import { DecodedPlatformEvent } from '../../domain/platform-adapter';
import { GMTRADE_TRADE_EVENT, GMTRADE_TRADE_EVENT_DISCRIMINATOR } from './constants';

export interface GmTradePositionState {
  tradeId: bigint; increasedAt: bigint; updatedAtSlot: bigint; decreasedAt: bigint;
  sizeInTokens: bigint; collateralAmount: bigint; sizeInUsd: bigint; borrowingFactor: bigint;
  fundingFeeAmountPerSize: bigint; longTokenClaimableFundingAmountPerSize: bigint;
  shortTokenClaimableFundingAmountPerSize: bigint;
}

export interface GmTradeEvent {
  flags: number; tradeId: bigint; authority: string; store: string; marketToken: string; user: string;
  position: string; order: string; finalOutputToken: string; ts: bigint; slot: bigint;
  before: GmTradePositionState; after: GmTradePositionState;
  transferOut: Record<string, bigint | number>;
  prices: { index: { min: bigint; max: bigint }; long: { min: bigint; max: bigint }; short: { min: bigint; max: bigint } };
  executionPrice: bigint; priceImpactValue: bigint; priceImpactDiff: bigint;
  pnl: { pnl: bigint; uncappedPnl: bigint };
  fees: {
    orderFeeForReceiverAmount: bigint; orderFeeForPoolAmount: bigint; liquidationFeeAmount: bigint;
    liquidationFeeForReceiverAmount: bigint; totalBorrowingFeeAmount: bigint;
    borrowingFeeForReceiverAmount: bigint; fundingFeeAmount: bigint;
    claimableFundingFeeLongTokenAmount: bigint; claimableFundingFeeShortTokenAmount: bigint;
  };
  outputAmounts: { outputAmount: bigint; secondaryOutputAmount: bigint };
  isLong: boolean; isCollateralLong: boolean; isIncrease: boolean;
}

function positionState(reader: BorshReader): GmTradePositionState {
  const value = {
    tradeId: reader.readU64(), increasedAt: reader.readI64(), updatedAtSlot: reader.readU64(), decreasedAt: reader.readI64(),
    sizeInTokens: reader.readU128(), collateralAmount: reader.readU128(), sizeInUsd: reader.readU128(),
    borrowingFactor: reader.readU128(), fundingFeeAmountPerSize: reader.readU128(),
    longTokenClaimableFundingAmountPerSize: reader.readU128(), shortTokenClaimableFundingAmountPerSize: reader.readU128(),
  };
  reader.skip(128);
  return value;
}

function price(reader: BorshReader): { min: bigint; max: bigint } { return { min: reader.readU128(), max: reader.readU128() }; }

export function decodeGmTradeInstruction(data: Uint8Array): DecodedPlatformEvent | null {
  const cpi = unwrapAnchorCpiEvent(data);
  if (!cpi || cpi.eventDiscriminatorHex !== GMTRADE_TRADE_EVENT_DISCRIMINATOR) return null;
  const reader = new BorshReader(cpi.payload);
  const flags = reader.readU8();
  reader.skip(7);
  const event: GmTradeEvent = {
    flags,
    tradeId: reader.readU64(),
    authority: reader.readPubkey(), store: reader.readPubkey(), marketToken: reader.readPubkey(), user: reader.readPubkey(),
    position: reader.readPubkey(), order: reader.readPubkey(), finalOutputToken: reader.readPubkey(),
    ts: reader.readI64(), slot: reader.readU64(), before: positionState(reader), after: positionState(reader),
    transferOut: {},
    prices: { index: { min: 0n, max: 0n }, long: { min: 0n, max: 0n }, short: { min: 0n, max: 0n } },
    executionPrice: 0n, priceImpactValue: 0n, priceImpactDiff: 0n,
    pnl: { pnl: 0n, uncappedPnl: 0n },
    fees: {
      orderFeeForReceiverAmount: 0n, orderFeeForPoolAmount: 0n, liquidationFeeAmount: 0n,
      liquidationFeeForReceiverAmount: 0n, totalBorrowingFeeAmount: 0n,
      borrowingFeeForReceiverAmount: 0n, fundingFeeAmount: 0n,
      claimableFundingFeeLongTokenAmount: 0n, claimableFundingFeeShortTokenAmount: 0n,
    },
    outputAmounts: { outputAmount: 0n, secondaryOutputAmount: 0n },
    isLong: Boolean(flags & 1), isCollateralLong: Boolean(flags & 2), isIncrease: Boolean(flags & 4),
  };
  const transferExecuted = reader.readU8();
  reader.skip(7);
  event.transferOut = {
    executed: transferExecuted,
    finalOutputToken: reader.readU64(), secondaryOutputToken: reader.readU64(), longToken: reader.readU64(), shortToken: reader.readU64(),
    longTokenForClaimableAccountOfUser: reader.readU64(), shortTokenForClaimableAccountOfUser: reader.readU64(),
    longTokenForClaimableAccountOfHolding: reader.readU64(), shortTokenForClaimableAccountOfHolding: reader.readU64(),
  };
  reader.skip(8);
  event.prices = { index: price(reader), long: price(reader), short: price(reader) };
  event.executionPrice = reader.readU128();
  event.priceImpactValue = reader.readI128();
  event.priceImpactDiff = reader.readU128();
  event.pnl = { pnl: reader.readI128(), uncappedPnl: reader.readI128() };
  event.fees = {
    orderFeeForReceiverAmount: reader.readU128(), orderFeeForPoolAmount: reader.readU128(), liquidationFeeAmount: reader.readU128(),
    liquidationFeeForReceiverAmount: reader.readU128(), totalBorrowingFeeAmount: reader.readU128(),
    borrowingFeeForReceiverAmount: reader.readU128(), fundingFeeAmount: reader.readU128(),
    claimableFundingFeeLongTokenAmount: reader.readU128(), claimableFundingFeeShortTokenAmount: reader.readU128(),
  };
  event.outputAmounts = { outputAmount: reader.readU128(), secondaryOutputAmount: reader.readU128() };
  return { eventName: GMTRADE_TRADE_EVENT, eventDiscriminatorHex: cpi.eventDiscriminatorHex, value: event as unknown as Record<string, unknown> };
}
