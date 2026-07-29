const { BorshWriter } = require('../dist/codec/borsh');
const { ANCHOR_CPI_EVENT_TAG, anchorDiscriminator } = require('../dist/codec/anchor');
const { base58Encode } = require('../dist/codec/base58');

function key(seed) {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => (seed + index * 17) & 0xff);
  return { bytes, address: base58Encode(bytes) };
}
function prefix(eventName, payload) {
  const out = new Uint8Array(16 + payload.length);
  out.set(ANCHOR_CPI_EVENT_TAG, 0);
  out.set(anchorDiscriminator('event', eventName), 8);
  out.set(payload, 16);
  return out;
}
function writePositionState(writer, value) {
  writer.writeU64(value.tradeId ?? 0n).writeI64(value.increasedAt ?? 0n).writeU64(value.updatedAtSlot ?? 0n).writeI64(value.decreasedAt ?? 0n)
    .writeU128(value.sizeInTokens ?? 0n).writeU128(value.collateralAmount ?? 0n).writeU128(value.sizeInUsd ?? 0n)
    .writeU128(value.borrowingFactor ?? 0n).writeU128(value.fundingFeeAmountPerSize ?? 0n)
    .writeU128(value.longClaimable ?? 0n).writeU128(value.shortClaimable ?? 0n).writeBytes(new Uint8Array(128));
}
function gmTradeEvent(input) {
  const writer = new BorshWriter();
  writer.writeU8(input.flags).writeBytes(new Uint8Array(7)).writeU64(input.tradeId ?? 1n);
  for (const item of [input.authority,input.store,input.market,input.user,input.position,input.order,input.finalOutput]) writer.writePubkey(item.bytes);
  writer.writeI64(input.ts).writeU64(input.slot);
  writePositionState(writer, input.before); writePositionState(writer, input.after);
  writer.writeU8(1).writeBytes(new Uint8Array(7));
  for (let i = 0; i < 8; i += 1) writer.writeU64(0n);
  writer.writeBytes(new Uint8Array(8));
  const prices = input.prices;
  for (const value of [prices.indexMin,prices.indexMax,prices.longMin,prices.longMax,prices.shortMin,prices.shortMax]) writer.writeU128(value);
  writer.writeU128(input.executionPrice).writeI128(input.priceImpactValue ?? 0n).writeU128(input.priceImpactDiff ?? 0n)
    .writeI128(input.pnl ?? 0n).writeI128(input.uncappedPnl ?? input.pnl ?? 0n);
  const fees = input.fees ?? {};
  for (const value of [fees.orderReceiver ?? 0n,fees.orderPool ?? 0n,fees.liquidation ?? 0n,fees.liquidationReceiver ?? 0n,
    fees.borrowing ?? 0n,fees.borrowingReceiver ?? 0n,fees.funding ?? 0n,fees.claimableLong ?? 0n,fees.claimableShort ?? 0n]) writer.writeU128(value);
  writer.writeU128(0n).writeU128(0n);
  return prefix('TradeEvent', writer.toUint8Array());
}
function jupiterIncrease(input, instant = false) {
  const writer = new BorshWriter();
  writer.writePubkey(input.position.bytes).writeU8(input.isLong ? 1 : 2).writePubkey(input.market.bytes).writePubkey(input.collateral.bytes)
    .writeU64(input.positionSizeUsd).writePubkey(input.positionMint.bytes);
  if (!instant) writer.writePubkey(input.request.bytes).writePubkey(input.requestMint.bytes).writeU8(0).writeU8(0).writeU64(input.collateralDeltaUsd);
  writer.writePubkey(input.owner.bytes).writePubkey(input.pool.bytes).writeU64(input.sizeDeltaUsd).writeU64(input.collateralDeltaUsd)
    .writeU64(input.collateralTokenDelta ?? 0n).writeU64(input.price);
  if (instant) writer.writeU64(input.priceSlippage ?? 0n); else writer.writeOption(input.priceSlippage ?? null, (value) => writer.writeU64(value));
  writer.writeU64(0n).writeU64(input.feeUsd).writeI64(input.openTime).writeOption(input.referral ?? null, (value) => writer.writePubkey(value.bytes));
  if (!input.legacy) {
    writer.writeU64(input.positionFeeUsd ?? input.feeUsd).writeU64(input.fundingFeeUsd ?? 0n).writeU64(input.priceImpactFeeUsd ?? 0n);
  }
  return prefix(instant ? 'InstantIncreasePositionEvent' : 'IncreasePositionEvent', writer.toUint8Array());
}
function jupiterDecrease(input, instant = false) {
  const writer = new BorshWriter();
  writer.writePubkey(input.position.bytes).writeU8(input.isLong ? 1 : 2).writePubkey(input.market.bytes).writePubkey(input.collateral.bytes)
    .writeU64(input.positionSizeUsd).writePubkey(input.positionMint.bytes);
  if (instant) writer.writePubkey(input.desiredMint.bytes);
  else writer.writePubkey(input.request.bytes).writePubkey(input.requestMint.bytes).writeU8(0).writeU8(0);
  writer.writeBool(input.hasProfit).writeU64(input.pnlDelta).writePubkey(input.owner.bytes).writePubkey(input.pool.bytes)
    .writeU64(input.sizeDeltaUsd).writeU64(input.transferAmountUsd ?? 0n);
  if (instant) writer.writeU64(input.transferToken ?? 0n); else writer.writeOption(input.transferToken ?? null, (value) => writer.writeU64(value));
  writer.writeU64(input.price);
  if (instant) writer.writeU64(input.priceSlippage ?? 0n); else writer.writeOption(input.priceSlippage ?? null, (value) => writer.writeU64(value));
  writer.writeU64(input.feeUsd).writeI64(input.openTime).writeOption(input.referral ?? null, (value) => writer.writePubkey(value.bytes));
  if (!input.legacy) {
    writer.writeU64(input.positionFeeUsd ?? input.feeUsd).writeU64(input.fundingFeeUsd ?? 0n);
    if (instant) {
      writer.writeU64(input.originalCollateralUsd).writeU64(input.positionCollateralUsd).writeU64(input.priceImpactFeeUsd ?? 0n)
        .writeI64(input.positionOpenTime).writeU64(input.positionPrice).writeOption(input.positionRequest ?? null, (value) => writer.writePubkey(value.bytes));
    } else {
      writer.writeU64(input.priceImpactFeeUsd ?? 0n).writeU64(input.originalCollateralUsd).writeU64(input.positionCollateralUsd)
        .writeI64(input.positionOpenTime).writeU64(input.positionPrice);
    }
  }
  return prefix(instant ? 'InstantDecreasePositionEvent' : 'DecreasePositionEvent', writer.toUint8Array());
}

function jupiterLiquidation(input) {
  const writer = new BorshWriter();
  writer.writePubkey(input.position.bytes).writeU8(input.isLong ? 1 : 2).writePubkey(input.market.bytes).writePubkey(input.collateral.bytes)
    .writePubkey(input.collateralMint.bytes).writePubkey(input.positionMint.bytes).writeU64(input.positionSizeUsd)
    .writeBool(input.hasProfit).writeU64(input.pnlDelta).writePubkey(input.owner.bytes).writePubkey(input.pool.bytes)
    .writeU64(input.transferAmountUsd ?? 0n).writeU64(input.transferToken ?? 0n).writeU64(input.price).writeU64(input.feeUsd)
    .writeU64(input.liquidationFeeUsd);
  if (input.legacyOpenTimeOnly) {
    writer.writeI64(input.openTime);
  } else if (!input.legacy) {
    writer.writeI64(input.openTime).writeU64(input.positionFeeUsd ?? input.feeUsd)
      .writeU64(input.fundingFeeUsd ?? 0n).writeU64(input.priceImpactFeeUsd ?? 0n).writeU64(input.originalCollateralUsd)
      .writeU64(input.positionCollateralUsd ?? 0n).writeI64(input.positionOpenTime).writeU64(input.positionPrice);
  }
  return prefix('LiquidateFullPositionEvent', writer.toUint8Array());
}
function jupiterDeposit(input) {
  const writer = new BorshWriter();
  writer.writePubkey(input.owner.bytes).writePubkey(input.pool.bytes).writePubkey(input.position.bytes).writePubkey(input.positionMint.bytes)
    .writePubkey(input.market.bytes).writeU64(input.depositAmount).writePubkey(input.userTokenAccount.bytes).writeI64(input.time);
  return prefix('DepositCollateralEvent', writer.toUint8Array());
}
function jupiterWithdraw(input) {
  const writer = new BorshWriter();
  writer.writePubkey(input.owner.bytes).writePubkey(input.pool.bytes).writePubkey(input.position.bytes).writePubkey(input.positionMint.bytes)
    .writePubkey(input.market.bytes).writeU64(input.withdrawAmount).writePubkey(input.userTokenAccount.bytes).writePubkey(input.collateral.bytes)
    .writeU64(input.previousCollateralAmount).writeU64(input.collateralAmount).writeU64(input.collateralAmountUsd).writeU64(input.marginUsd ?? input.collateralAmountUsd).writeI64(input.time);
  return prefix('WithdrawCollateralEvent', writer.toUint8Array());
}

module.exports = { key, gmTradeEvent, jupiterIncrease, jupiterDecrease, jupiterLiquidation, jupiterDeposit, jupiterWithdraw, prefix };
