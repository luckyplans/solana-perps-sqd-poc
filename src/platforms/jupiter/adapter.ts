import { classifyPositionTransition } from '../../domain/classification';
import { DataQuality, PerpCloseReason, PerpTradeHistoryOperation, Platform } from '../../domain/enums';
import { fixed6FromRaw, numberToFixed6, pow10, ratioFixed6 } from '../../domain/fixed';
import { PositionState } from '../../domain/models';
import { DecodedPlatformEvent, PerpPlatformAdapter, PlatformNormalizationContext, PlatformNormalizationResult } from '../../domain/platform-adapter';
import { JUPITER_EVENTS, JUPITER_PROGRAM_ID, JUPITER_USD_DECIMALS } from './constants';
import { decodeJupiterInstruction } from './decoder';

export class JupiterAdapter implements PerpPlatformAdapter {
  readonly platform = Platform.JUPITER;
  readonly programId = JUPITER_PROGRAM_ID;
  readonly eventDiscriminatorHexes = Object.values(JUPITER_EVENTS);
  decodeInstruction(data: Uint8Array): DecodedPlatformEvent | null { return decodeJupiterInstruction(data); }
  positionKey(decoded: DecodedPlatformEvent): string { return text(decoded, 'positionKey'); }
  marketAddress(decoded: DecodedPlatformEvent): string { return text(decoded, 'positionCustody'); }
  collateralAddress(decoded: DecodedPlatformEvent): string | null {
    return nullableText(decoded, 'positionCollateralCustody') ?? nullableText(decoded, 'custody');
  }

  normalize(decoded: DecodedPlatformEvent, context: PlatformNormalizationContext): PlatformNormalizationResult | null {
    if (decoded.eventName.includes('IncreasePosition')) return this.normalizeIncrease(decoded, context);
    if (decoded.eventName.includes('DecreasePosition')) return this.normalizeDecrease(decoded, context);
    if (decoded.eventName === 'LiquidatePositionEvent' || decoded.eventName === 'LiquidateFullPositionEvent') return this.normalizeLiquidation(decoded, context);
    if (decoded.eventName === 'DepositCollateralEvent') return this.normalizeDeposit(decoded, context);
    if (decoded.eventName === 'WithdrawCollateralEvent') return this.normalizeWithdraw(decoded, context);
    return null;
  }

  private normalizeIncrease(decoded: DecodedPlatformEvent, context: PlatformNormalizationContext): PlatformNormalizationResult | null {
    const delta = amount(decoded, 'sizeUsdDelta');
    const hintedAfter = amount(decoded, 'positionSizeUsd');
    const beforeSize = context.previousPosition?.sizeInUsdE6 ?? (hintedAfter >= delta ? hintedAfter - delta : 0n);
    const afterSize = context.previousPosition ? beforeSize + delta : hintedAfter;
    const beforeCollateral = context.previousPosition?.collateralInUsdE6 ?? 0n;
    const collateralDelta = amount(decoded, 'collateralUsdDelta');
    const afterCollateral = beforeCollateral + collateralDelta;
    return this.finish(decoded, context, {
      beforeSize, afterSize, beforeCollateral, afterCollateral,
      basePnl: 0n, fee: amount(decoded, 'feeUsd'), liquidation: false,
      price: amount(decoded, 'price'), isLong: side(decoded),
      openedAtHint: timestamp(decoded, 'openTime'), stateComplete: Boolean(context.previousPosition) || beforeSize === 0n,
    });
  }

  private normalizeDecrease(decoded: DecodedPlatformEvent, context: PlatformNormalizationContext): PlatformNormalizationResult | null {
    const delta = amount(decoded, 'sizeUsdDelta');
    const hintedAfter = amount(decoded, 'positionSizeUsd');
    const beforeSize = context.previousPosition?.sizeInUsdE6 ?? hintedAfter + delta;
    const afterSize = beforeSize > delta ? beforeSize - delta : 0n;
    const hasCollateralState = decoded.value.hasPositionCollateralState === true;
    const beforeCollateral = hasCollateralState
      ? amount(decoded, 'originalPositionCollateralUsd')
      : context.previousPosition?.collateralInUsdE6 ?? 0n;
    const afterCollateral = hasCollateralState
      ? amount(decoded, 'positionCollateralUsd')
      : afterSize === 0n
        ? 0n
        : context.previousPosition?.collateralInUsdE6 ?? 0n;
    const pnl = signedPnl(decoded);
    return this.finish(decoded, context, {
      beforeSize, afterSize, beforeCollateral, afterCollateral,
      basePnl: pnl, fee: amount(decoded, 'feeUsd'), liquidation: false,
      price: amount(decoded, 'price'), isLong: side(decoded),
      openedAtHint: timestamp(decoded, 'positionOpenTime') ?? timestamp(decoded, 'openTime'),
      stateComplete: Boolean(context.previousPosition) && hasCollateralState,
    });
  }

  private normalizeLiquidation(decoded: DecodedPlatformEvent, context: PlatformNormalizationContext): PlatformNormalizationResult | null {
    const beforeSize = context.previousPosition?.sizeInUsdE6 ?? amount(decoded, 'positionSizeUsd');
    const beforeCollateral = amount(decoded, 'originalPositionCollateralUsd') || context.previousPosition?.collateralInUsdE6 || 0n;
    const fee = amount(decoded, 'feeUsd') + amount(decoded, 'liquidationFeeUsd');
    return this.finish(decoded, context, {
      beforeSize, afterSize: 0n, beforeCollateral, afterCollateral: 0n,
      basePnl: signedPnl(decoded), fee, liquidation: true,
      price: amount(decoded, 'price'), isLong: side(decoded),
      openedAtHint: timestamp(decoded, 'positionOpenTime') ?? timestamp(decoded, 'openTime'), stateComplete: Boolean(context.previousPosition),
    });
  }

  private normalizeDeposit(decoded: DecodedPlatformEvent, context: PlatformNormalizationContext): PlatformNormalizationResult | null {
    const previous = context.previousPosition;
    if (!previous) return this.collateralOnlyWithoutState(decoded, context, false);
    const delta = tokenAmountUsd(decoded, 'depositAmount', context);
    return this.finish(decoded, context, {
      beforeSize: previous.sizeInUsdE6, afterSize: previous.sizeInUsdE6,
      beforeCollateral: previous.collateralInUsdE6, afterCollateral: previous.collateralInUsdE6 + delta,
      basePnl: 0n, fee: 0n, liquidation: false, price: previous.lastPriceE6,
      isLong: previous.isLong, openedAtHint: previous.openedAt, stateComplete: delta > 0n,
    });
  }

  private normalizeWithdraw(decoded: DecodedPlatformEvent, context: PlatformNormalizationContext): PlatformNormalizationResult | null {
    const previous = context.previousPosition;
    if (!previous) return this.collateralOnlyWithoutState(decoded, context, true);
    const hintedAfter = amount(decoded, 'collateralAmountUsd');
    const afterCollateral = hintedAfter > 0n ? hintedAfter : previous.collateralInUsdE6 - tokenAmountUsd(decoded, 'withdrawAmount', context);
    return this.finish(decoded, context, {
      beforeSize: previous.sizeInUsdE6, afterSize: previous.sizeInUsdE6,
      beforeCollateral: previous.collateralInUsdE6, afterCollateral: afterCollateral > 0n ? afterCollateral : 0n,
      basePnl: 0n, fee: 0n, liquidation: false, price: previous.lastPriceE6,
      isLong: previous.isLong, openedAtHint: previous.openedAt, stateComplete: true,
    });
  }

  private collateralOnlyWithoutState(
    decoded: DecodedPlatformEvent,
    context: PlatformNormalizationContext,
    withdraw: boolean,
  ): PlatformNormalizationResult | null {
    const operation = withdraw
      ? PerpTradeHistoryOperation.INCREASE_LEVERAGE
      : PerpTradeHistoryOperation.DECREASE_LEVERAGE;
    const date = timestamp(decoded, 'time') ?? context.raw.blockTime;
    const collateralAddress = this.collateralAddress(decoded);
    // A deposit event does not identify the collateral custody. Without earlier
    // position state, converting its token amount with an arbitrary market
    // fallback would fabricate a value. Withdraw events identify the custody,
    // so the token delta can be converted when that custody has USD metadata.
    const delta = withdraw
      ? tokenAmountUsd(decoded, 'withdrawAmount', context)
      : 0n;
    const afterCollateral = withdraw ? amount(decoded, 'collateralAmountUsd') : 0n;
    const history = {
      positionKey: text(decoded, 'positionKey'),
      address: text(decoded, 'owner'),
      pair: context.market.pair,
      operation,
      usdPnlE6: 0n,
      usdBasePnlE6: 0n,
      usdFeeE6: 0n,
      sizeInUsdE6: 0n,
      leverageE6: 0n,
      collateralInUsdE6: afterCollateral,
      collateralDeltaUsdE6: withdraw ? -delta : 0n,
      sizeDeltaUsdE6: 0n,
      leverageDeltaE6: 0n,
      isLong: false,
      priceE6: 0n,
      collateralUsdPriceE6:
        collateralAddress && context.market.collateralUsdPriceE6 !== null
          ? context.market.collateralUsdPriceE6
          : 0n,
      closeReason: null,
      dataQuality: DataQuality.PARTIAL_STATE,
      liquidation: false,
      marketAddress: text(decoded, 'positionCustody'),
      collateralAddress,
    };
    const source = sourceOf(this, decoded, context, date);
    // Do not persist a synthetic zero-sized position. A later event can still
    // reconstruct its own state, and an earlier chronological replay will
    // provide the real prior position.
    return {
      event: { source, history, decodedEvent: decoded.value },
      nextPositionState: null,
    };
  }

  private finish(decoded: DecodedPlatformEvent, context: PlatformNormalizationContext, input: {
    beforeSize: bigint; afterSize: bigint; beforeCollateral: bigint; afterCollateral: bigint;
    basePnl: bigint; fee: bigint; liquidation: boolean; price: bigint; isLong: boolean;
    openedAtHint: Date | null; stateComplete: boolean;
  }): PlatformNormalizationResult | null {
    const transition = classifyPositionTransition({
      beforeSizeE6: input.beforeSize, afterSizeE6: input.afterSize,
      beforeCollateralE6: input.beforeCollateral, afterCollateralE6: input.afterCollateral,
    });
    if (!transition) return null;
    const date = timestamp(decoded, 'openTime') ?? timestamp(decoded, 'time') ?? context.raw.blockTime;
    const collateralAddress = this.collateralAddress(decoded) ?? context.market.collateralAddress ?? null;
    const quality = !context.market.known ? DataQuality.PARTIAL_MARKET : !input.stateComplete ? DataQuality.PARTIAL_STATE : DataQuality.COMPLETE;
    const history = {
      positionKey: text(decoded, 'positionKey'), address: text(decoded, 'owner'), pair: context.market.pair,
      operation: transition.operation, usdPnlE6: input.basePnl - input.fee, usdBasePnlE6: input.basePnl, usdFeeE6: -input.fee,
      sizeInUsdE6: input.afterSize, leverageE6: transition.afterLeverageE6, collateralInUsdE6: input.afterCollateral,
      collateralDeltaUsdE6: transition.collateralDeltaE6, sizeDeltaUsdE6: transition.sizeDeltaE6,
      leverageDeltaE6: transition.leverageDeltaE6, isLong: input.isLong, priceE6: input.price,
      collateralUsdPriceE6: context.market.collateralUsdPriceE6 ?? 1_000_000n,
      closeReason: input.liquidation ? PerpCloseReason.LIQUIDATION : transition.operation === PerpTradeHistoryOperation.CLOSE ? PerpCloseReason.USER : null,
      dataQuality: quality, liquidation: input.liquidation, marketAddress: text(decoded, 'positionCustody'), collateralAddress,
    };
    const source = sourceOf(this, decoded, context, date);
    const openedAt = input.afterSize > 0n ? context.previousPosition?.openedAt ?? input.openedAtHint ?? date : context.previousPosition?.openedAt ?? input.openedAtHint;
    const nextPositionState: PositionState = {
      platform: this.platform, positionKey: history.positionKey, address: history.address, marketAddress: history.marketAddress,
      collateralAddress, pair: history.pair, isLong: input.isLong, sizeInUsdE6: input.afterSize,
      collateralInUsdE6: input.afterCollateral, leverageE6: transition.afterLeverageE6, lastPriceE6: input.price,
      openedAt, lastSlot: context.raw.slot, updatedAt: date, closed: input.afterSize === 0n,
    };
    return { event: { source, history, decodedEvent: decoded.value }, nextPositionState };
  }
}

function sourceOf(adapter: JupiterAdapter, decoded: DecodedPlatformEvent, context: PlatformNormalizationContext, date: Date) {
  return {
    platform: adapter.platform, programId: adapter.programId, ingestionSource: context.raw.ingestionSource,
    signature: context.raw.signature, slot: context.raw.slot, blockTime: date,
    outerInstructionIndex: context.raw.outerInstructionIndex, innerInstructionIndex: context.raw.innerInstructionIndex,
    eventName: decoded.eventName, eventDiscriminatorHex: decoded.eventDiscriminatorHex,
    orderKey: null, requestKey: nullableText(decoded, 'positionRequestKey') ?? nullableText(decoded, 'positionRequest'),
  };
}
function text(decoded: DecodedPlatformEvent, key: string): string { const value = decoded.value[key]; if (typeof value !== 'string') throw new Error(`${decoded.eventName}.${key} is missing`); return value; }
function nullableText(decoded: DecodedPlatformEvent, key: string): string | null { const value = decoded.value[key]; return typeof value === 'string' ? value : null; }
function rawBigInt(decoded: DecodedPlatformEvent, key: string): bigint { const value = decoded.value[key]; if (typeof value === 'bigint') return value; if (typeof value === 'number') return BigInt(value); if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value); return 0n; }
function amount(decoded: DecodedPlatformEvent, key: string): bigint { return fixed6FromRaw(rawBigInt(decoded, key), JUPITER_USD_DECIMALS); }
function side(decoded: DecodedPlatformEvent): boolean { return Number(rawBigInt(decoded, 'positionSide')) === 1; }
function signedPnl(decoded: DecodedPlatformEvent): bigint { const pnl = amount(decoded, 'pnlDelta'); return decoded.value.hasProfit === true ? pnl : -pnl; }
function timestamp(decoded: DecodedPlatformEvent, key: string): Date | null { const value = rawBigInt(decoded, key); return value > 0n ? new Date(Number(value) * 1000) : null; }
function tokenAmountUsd(decoded: DecodedPlatformEvent, key: string, context: PlatformNormalizationContext): bigint {
  const raw = rawBigInt(decoded, key);
  const decimals = context.market.collateralTokenDecimals;
  const price = context.market.collateralUsdPriceE6;
  if (decimals === undefined || price === null) return 0n;
  return (raw * price) / pow10(decimals);
}
