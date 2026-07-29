import { classifyPositionTransition } from '../../domain/classification';
import { DataQuality, PerpCloseReason, Platform } from '../../domain/enums';
import { fixed6FromRaw, rawAmountTimesUnitPriceToE6, unitPriceToTokenPriceE6 } from '../../domain/fixed';
import { DecodedPlatformEvent, PerpPlatformAdapter, PlatformNormalizationContext, PlatformNormalizationResult } from '../../domain/platform-adapter';
import { GmTradeEvent, decodeGmTradeInstruction } from './decoder';
import { GMTRADE_PROGRAM_ID, GMTRADE_TRADE_EVENT_DISCRIMINATOR, GMTRADE_USD_DECIMALS } from './constants';

export class GmTradeAdapter implements PerpPlatformAdapter {
  readonly platform = Platform.GMTRADE;
  readonly programId = GMTRADE_PROGRAM_ID;
  readonly eventDiscriminatorHexes = [GMTRADE_TRADE_EVENT_DISCRIMINATOR] as const;
  decodeInstruction(data: Uint8Array): DecodedPlatformEvent | null { return decodeGmTradeInstruction(data); }
  positionKey(decoded: DecodedPlatformEvent): string { return event(decoded).position; }
  marketAddress(decoded: DecodedPlatformEvent): string { return event(decoded).marketToken; }
  collateralAddress(decoded: DecodedPlatformEvent): string | null {
    const value = event(decoded);
    return value.isCollateralLong ? null : null;
  }

  normalize(decoded: DecodedPlatformEvent, context: PlatformNormalizationContext): PlatformNormalizationResult | null {
    const value = event(decoded);
    const collateralUnitPrice = value.isCollateralLong ? value.prices.long.min : value.prices.short.min;
    const beforeSizeE6 = fixed6FromRaw(value.before.sizeInUsd, GMTRADE_USD_DECIMALS);
    const afterSizeE6 = fixed6FromRaw(value.after.sizeInUsd, GMTRADE_USD_DECIMALS);
    const beforeCollateralE6 = rawAmountTimesUnitPriceToE6(value.before.collateralAmount, collateralUnitPrice, GMTRADE_USD_DECIMALS);
    const afterCollateralE6 = rawAmountTimesUnitPriceToE6(value.after.collateralAmount, collateralUnitPrice, GMTRADE_USD_DECIMALS);
    const transition = classifyPositionTransition({ beforeSizeE6, afterSizeE6, beforeCollateralE6, afterCollateralE6 });
    if (!transition) return null;

    const collateralDecimals = value.isCollateralLong
      ? context.market.longCollateralTokenDecimals ?? context.market.collateralTokenDecimals
      : context.market.shortCollateralTokenDecimals ?? context.market.collateralTokenDecimals;
    const collateralAddress = value.isCollateralLong
      ? context.market.longCollateralAddress ?? context.market.collateralAddress ?? null
      : context.market.shortCollateralAddress ?? context.market.collateralAddress ?? null;
    const collateralUsdPriceE6 = collateralDecimals === undefined ? 0n : unitPriceToTokenPriceE6(collateralUnitPrice, collateralDecimals, GMTRADE_USD_DECIMALS);
    const priceE6 = context.market.indexTokenDecimals === undefined
      ? 0n
      : unitPriceToTokenPriceE6(value.executionPrice, context.market.indexTokenDecimals, GMTRADE_USD_DECIMALS);

    const paidFeeAmount = value.fees.orderFeeForReceiverAmount
      + value.fees.orderFeeForPoolAmount
      + value.fees.liquidationFeeAmount
      + value.fees.totalBorrowingFeeAmount
      + value.fees.fundingFeeAmount;
    const paidFeesE6 = rawAmountTimesUnitPriceToE6(paidFeeAmount, collateralUnitPrice, GMTRADE_USD_DECIMALS);
    const claimableFundingE6 = rawAmountTimesUnitPriceToE6(
      value.fees.claimableFundingFeeLongTokenAmount,
      value.prices.long.min,
      GMTRADE_USD_DECIMALS,
    ) + rawAmountTimesUnitPriceToE6(
      value.fees.claimableFundingFeeShortTokenAmount,
      value.prices.short.min,
      GMTRADE_USD_DECIMALS,
    );
    const basePnlE6 = fixed6FromRaw(value.pnl.pnl, GMTRADE_USD_DECIMALS);
    const usdFeeE6 = claimableFundingE6 - paidFeesE6;
    const liquidation = value.fees.liquidationFeeAmount > 0n;
    const eventTime = Number(value.ts) > 0 ? new Date(Number(value.ts) * 1000) : context.raw.blockTime;
    const openedAt = afterSizeE6 > 0n
      ? context.previousPosition?.openedAt ?? (transition.operation === 'open' ? eventTime : null)
      : context.previousPosition?.openedAt ?? null;
    const dataQuality = !context.market.known || context.market.indexTokenDecimals === undefined
      ? DataQuality.PARTIAL_MARKET
      : collateralDecimals === undefined
        ? DataQuality.PARTIAL_COLLATERAL
        : DataQuality.COMPLETE;

    const history = {
      positionKey: value.position, address: value.user, pair: context.market.pair,
      operation: transition.operation, usdPnlE6: basePnlE6 + usdFeeE6, usdBasePnlE6: basePnlE6, usdFeeE6,
      sizeInUsdE6: afterSizeE6, leverageE6: transition.afterLeverageE6, collateralInUsdE6: afterCollateralE6,
      collateralDeltaUsdE6: transition.collateralDeltaE6, sizeDeltaUsdE6: transition.sizeDeltaE6,
      leverageDeltaE6: transition.leverageDeltaE6, isLong: value.isLong, priceE6, collateralUsdPriceE6,
      closeReason: liquidation ? PerpCloseReason.LIQUIDATION : transition.operation === 'close' ? PerpCloseReason.USER : null,
      dataQuality, liquidation, marketAddress: value.marketToken, collateralAddress,
    };
    const source = {
      platform: this.platform, programId: this.programId, ingestionSource: context.raw.ingestionSource,
      signature: context.raw.signature, slot: context.raw.slot, blockTime: eventTime,
      outerInstructionIndex: context.raw.outerInstructionIndex, innerInstructionIndex: context.raw.innerInstructionIndex,
      eventName: decoded.eventName, eventDiscriminatorHex: decoded.eventDiscriminatorHex,
      orderKey: value.order, requestKey: null,
    };
    const nextPositionState = {
      platform: this.platform, positionKey: value.position, address: value.user, marketAddress: value.marketToken,
      collateralAddress, pair: context.market.pair, isLong: value.isLong,
      sizeInUsdE6: afterSizeE6, collateralInUsdE6: afterCollateralE6, leverageE6: transition.afterLeverageE6,
      lastPriceE6: priceE6, openedAt, lastSlot: context.raw.slot, updatedAt: eventTime, closed: afterSizeE6 === 0n,
    };
    return { event: { source, history, decodedEvent: decoded.value }, nextPositionState };
  }
}

function event(decoded: DecodedPlatformEvent): GmTradeEvent { return decoded.value as unknown as GmTradeEvent; }
