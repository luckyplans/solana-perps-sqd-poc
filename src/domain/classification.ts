import { PerpTradeHistoryOperation } from './enums';
import { absBigInt, ratioFixed6 } from './fixed';

export interface TransitionInput {
  beforeSizeE6: bigint;
  afterSizeE6: bigint;
  beforeCollateralE6: bigint;
  afterCollateralE6: bigint;
}

export interface PositionTransition {
  operation: PerpTradeHistoryOperation;
  sizeDeltaE6: bigint;
  collateralDeltaE6: bigint;
  beforeLeverageE6: bigint;
  afterLeverageE6: bigint;
  leverageDeltaE6: bigint;
}

export function classifyPositionTransition(input: TransitionInput): PositionTransition | null {
  const beforeLeverageE6 = ratioFixed6(input.beforeSizeE6, input.beforeCollateralE6);
  const afterLeverageE6 = ratioFixed6(input.afterSizeE6, input.afterCollateralE6);
  const signedSizeDelta = input.afterSizeE6 - input.beforeSizeE6;
  const collateralDeltaE6 = input.afterCollateralE6 - input.beforeCollateralE6;
  let operation: PerpTradeHistoryOperation | null = null;
  if (input.beforeSizeE6 === 0n && input.afterSizeE6 > 0n) operation = PerpTradeHistoryOperation.OPEN;
  else if (input.beforeSizeE6 > 0n && input.afterSizeE6 === 0n) operation = PerpTradeHistoryOperation.CLOSE;
  else if (signedSizeDelta > 0n) operation = PerpTradeHistoryOperation.INCREASE_SIZE;
  else if (signedSizeDelta < 0n) operation = PerpTradeHistoryOperation.DECREASE_SIZE;
  else if (collateralDeltaE6 < 0n) operation = PerpTradeHistoryOperation.INCREASE_LEVERAGE;
  else if (collateralDeltaE6 > 0n) operation = PerpTradeHistoryOperation.DECREASE_LEVERAGE;
  if (!operation) return null;
  return {
    operation,
    sizeDeltaE6: absBigInt(signedSizeDelta),
    collateralDeltaE6,
    beforeLeverageE6,
    afterLeverageE6,
    leverageDeltaE6: afterLeverageE6 - beforeLeverageE6,
  };
}
