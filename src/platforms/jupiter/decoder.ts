import { unwrapAnchorCpiEvent } from '../../codec/anchor';
import { BorshReader } from '../../codec/borsh';
import { DecodedPlatformEvent } from '../../domain/platform-adapter';
import { JUPITER_EVENTS } from './constants';

type AnyEvent = Record<string, unknown>;
type SchemaVersion = 'legacy' | 'current';

function markSchema(value: AnyEvent, version: SchemaVersion): void {
  value.schemaVersion = version;
}

function expectExtensionLength(
  reader: BorshReader,
  eventName: string,
  allowed: readonly number[],
): number {
  const remaining = reader.remaining;
  if (!allowed.includes(remaining)) {
    throw new Error(
      `Unsupported Jupiter ${eventName} extension length ${remaining}; expected ${allowed.join(' or ')}`,
    );
  }
  return remaining;
}

function readIncreaseExtension(reader: BorshReader, value: AnyEvent, eventName: string): void {
  const remaining = expectExtensionLength(reader, eventName, [0, 24]);
  if (remaining === 0) {
    value.positionFeeUsd = value.feeUsd;
    value.fundingFeeUsd = 0n;
    value.priceImpactFeeUsd = 0n;
    value.hasExtendedFeeBreakdown = false;
    markSchema(value, 'legacy');
    return;
  }
  value.positionFeeUsd = reader.readU64();
  value.fundingFeeUsd = reader.readU64();
  value.priceImpactFeeUsd = reader.readU64();
  value.hasExtendedFeeBreakdown = true;
  markSchema(value, 'current');
}

function readDecreaseExtension(
  reader: BorshReader,
  value: AnyEvent,
  eventName: string,
  instant: boolean,
): void {
  const allowed = instant ? [0, 57, 89] : [0, 56];
  const remaining = expectExtensionLength(reader, eventName, allowed);
  if (remaining === 0) {
    value.positionFeeUsd = value.feeUsd;
    value.fundingFeeUsd = 0n;
    value.priceImpactFeeUsd = 0n;
    value.originalPositionCollateralUsd = 0n;
    value.positionCollateralUsd = 0n;
    value.positionOpenTime = 0n;
    value.positionPrice = 0n;
    if (instant) value.positionRequest = null;
    value.hasExtendedFeeBreakdown = false;
    value.hasPositionCollateralState = false;
    markSchema(value, 'legacy');
    return;
  }

  value.positionFeeUsd = reader.readU64();
  value.fundingFeeUsd = reader.readU64();
  if (instant) {
    value.originalPositionCollateralUsd = reader.readU64();
    value.positionCollateralUsd = reader.readU64();
    value.priceImpactFeeUsd = reader.readU64();
    value.positionOpenTime = reader.readI64();
    value.positionPrice = reader.readU64();
    value.positionRequest = reader.readOption(() => reader.readPubkey());
  } else {
    value.priceImpactFeeUsd = reader.readU64();
    value.originalPositionCollateralUsd = reader.readU64();
    value.positionCollateralUsd = reader.readU64();
    value.positionOpenTime = reader.readI64();
    value.positionPrice = reader.readU64();
  }
  value.hasExtendedFeeBreakdown = true;
  value.hasPositionCollateralState = true;
  markSchema(value, 'current');
}

function readLiquidationExtension(
  reader: BorshReader,
  value: AnyEvent,
  eventName: string,
): void {
  // Jupiter has emitted three full-liquidation layouts under the same event
  // discriminator:
  //   0 bytes  - original legacy layout
  //   8 bytes  - legacy layout with only open_time appended
  //   64 bytes - current fee breakdown and position-state layout
  // The 8-byte variant produces a 306-byte complete CPI instruction and is
  // common in January 2025 Dune history.
  const remaining = expectExtensionLength(reader, eventName, [0, 8, 64]);
  if (remaining === 0 || remaining === 8) {
    value.openTime = remaining === 8 ? reader.readI64() : 0n;
    value.positionFeeUsd = value.feeUsd;
    value.fundingFeeUsd = 0n;
    value.priceImpactFeeUsd = 0n;
    value.originalPositionCollateralUsd = 0n;
    value.positionCollateralUsd = 0n;
    value.positionOpenTime = 0n;
    value.positionPrice = 0n;
    value.hasOpenTime = remaining === 8;
    value.hasExtendedFeeBreakdown = false;
    value.hasPositionCollateralState = false;
    markSchema(value, 'legacy');
    return;
  }
  value.openTime = reader.readI64();
  value.positionFeeUsd = reader.readU64();
  value.fundingFeeUsd = reader.readU64();
  value.priceImpactFeeUsd = reader.readU64();
  value.originalPositionCollateralUsd = reader.readU64();
  value.positionCollateralUsd = reader.readU64();
  value.positionOpenTime = reader.readI64();
  value.positionPrice = reader.readU64();
  value.hasOpenTime = true;
  value.hasExtendedFeeBreakdown = true;
  value.hasPositionCollateralState = true;
  markSchema(value, 'current');
}

function commonIncrease(reader: BorshReader, instant: boolean, eventName: string): AnyEvent {
  const value: AnyEvent = {
    positionKey: reader.readPubkey(), positionSide: reader.readU8(), positionCustody: reader.readPubkey(),
    positionCollateralCustody: reader.readPubkey(), positionSizeUsd: reader.readU64(), positionMint: reader.readPubkey(),
  };
  if (!instant) {
    value.positionRequestKey = reader.readPubkey(); value.positionRequestMint = reader.readPubkey();
    value.positionRequestChange = reader.readU8(); value.positionRequestType = reader.readU8();
    value.positionRequestCollateralDelta = reader.readU64();
  }
  value.owner = reader.readPubkey(); value.pool = reader.readPubkey(); value.sizeUsdDelta = reader.readU64();
  value.collateralUsdDelta = reader.readU64(); value.collateralTokenDelta = reader.readU64(); value.price = reader.readU64();
  value.priceSlippage = instant ? reader.readU64() : reader.readOption(() => reader.readU64());
  value.feeToken = reader.readU64(); value.feeUsd = reader.readU64(); value.openTime = reader.readI64();
  value.referral = reader.readOption(() => reader.readPubkey());
  readIncreaseExtension(reader, value, eventName);
  return value;
}

function commonDecrease(reader: BorshReader, instant: boolean, eventName: string): AnyEvent {
  const value: AnyEvent = {
    positionKey: reader.readPubkey(), positionSide: reader.readU8(), positionCustody: reader.readPubkey(),
    positionCollateralCustody: reader.readPubkey(), positionSizeUsd: reader.readU64(), positionMint: reader.readPubkey(),
  };
  if (instant) value.desiredMint = reader.readPubkey();
  else {
    value.positionRequestKey = reader.readPubkey(); value.positionRequestMint = reader.readPubkey();
    value.positionRequestChange = reader.readU8(); value.positionRequestType = reader.readU8();
  }
  value.hasProfit = reader.readBool(); value.pnlDelta = reader.readU64(); value.owner = reader.readPubkey(); value.pool = reader.readPubkey();
  value.sizeUsdDelta = reader.readU64(); value.transferAmountUsd = reader.readU64();
  value.transferToken = instant ? reader.readU64() : reader.readOption(() => reader.readU64());
  value.price = reader.readU64(); value.priceSlippage = instant ? reader.readU64() : reader.readOption(() => reader.readU64());
  value.feeUsd = reader.readU64(); value.openTime = reader.readI64(); value.referral = reader.readOption(() => reader.readPubkey());
  readDecreaseExtension(reader, value, eventName, instant);
  return value;
}

function legacyLiquidate(reader: BorshReader, eventName: string): AnyEvent {
  const value: AnyEvent = {
    positionKey: reader.readPubkey(), positionSide: reader.readU8(), positionCustody: reader.readPubkey(),
    positionCollateralCustody: reader.readPubkey(), positionCollateralMint: reader.readPubkey(), positionMint: reader.readPubkey(),
    positionSizeUsd: reader.readU64(), hasProfit: reader.readBool(), pnlDelta: reader.readU64(), owner: reader.readPubkey(),
    pool: reader.readPubkey(), transferAmountUsd: reader.readU64(), transferToken: reader.readU64(), price: reader.readU64(),
    feeUsd: reader.readU64(), liquidationFeeUsd: 0n,
  };
  readLiquidationExtension(reader, value, eventName);
  return value;
}

function liquidate(reader: BorshReader, eventName: string): AnyEvent {
  const value: AnyEvent = {
    positionKey: reader.readPubkey(), positionSide: reader.readU8(), positionCustody: reader.readPubkey(),
    positionCollateralCustody: reader.readPubkey(), positionCollateralMint: reader.readPubkey(), positionMint: reader.readPubkey(),
    positionSizeUsd: reader.readU64(), hasProfit: reader.readBool(), pnlDelta: reader.readU64(), owner: reader.readPubkey(),
    pool: reader.readPubkey(), transferAmountUsd: reader.readU64(), transferToken: reader.readU64(), price: reader.readU64(),
    feeUsd: reader.readU64(), liquidationFeeUsd: reader.readU64(),
  };
  readLiquidationExtension(reader, value, eventName);
  return value;
}

function deposit(reader: BorshReader): AnyEvent {
  const value = { owner: reader.readPubkey(), pool: reader.readPubkey(), positionKey: reader.readPubkey(), positionMint: reader.readPubkey(), positionCustody: reader.readPubkey(), depositAmount: reader.readU64(), userTokenAccount: reader.readPubkey(), time: reader.readI64(), schemaVersion: 'current' };
  expectExtensionLength(reader, 'DepositCollateralEvent', [0]);
  return value;
}

function withdraw(reader: BorshReader): AnyEvent {
  const value = {
    owner: reader.readPubkey(), pool: reader.readPubkey(), positionKey: reader.readPubkey(), positionMint: reader.readPubkey(),
    positionCustody: reader.readPubkey(), withdrawAmount: reader.readU64(), userTokenAccount: reader.readPubkey(), custody: reader.readPubkey(),
    previousCollateralAmount: reader.readU64(), collateralAmount: reader.readU64(), collateralAmountUsd: reader.readU64(), marginUsd: reader.readU64(), time: reader.readI64(), schemaVersion: 'current',
  };
  expectExtensionLength(reader, 'WithdrawCollateralEvent', [0]);
  return value;
}

export function decodeJupiterInstruction(data: Uint8Array): DecodedPlatformEvent | null {
  const cpi = unwrapAnchorCpiEvent(data);
  if (!cpi) return null;
  const entry = Object.entries(JUPITER_EVENTS).find(([, discriminator]) => discriminator === cpi.eventDiscriminatorHex);
  if (!entry) return null;
  const [eventName] = entry;
  const reader = new BorshReader(cpi.payload);
  let value: AnyEvent;
  switch (eventName) {
    case 'IncreasePositionEvent': value = commonIncrease(reader, false, eventName); break;
    case 'InstantIncreasePositionEvent': value = commonIncrease(reader, true, eventName); break;
    case 'DecreasePositionEvent': value = commonDecrease(reader, false, eventName); break;
    case 'InstantDecreasePositionEvent': value = commonDecrease(reader, true, eventName); break;
    case 'LiquidatePositionEvent': value = legacyLiquidate(reader, eventName); break;
    case 'LiquidateFullPositionEvent': value = liquidate(reader, eventName); break;
    case 'DepositCollateralEvent': value = deposit(reader); break;
    case 'WithdrawCollateralEvent': value = withdraw(reader); break;
    default: return null;
  }
  return { eventName, eventDiscriminatorHex: cpi.eventDiscriminatorHex, value };
}
