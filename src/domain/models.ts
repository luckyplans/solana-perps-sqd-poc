import { DataQuality, IngestionSource, PerpCloseReason, PerpTradeHistoryOperation, Platform } from './enums';
import { fixed6ToNumber } from './fixed';

export interface SourceInstruction {
  platform: Platform;
  programId: string;
  ingestionSource: IngestionSource;
  signature: string;
  slot: number;
  blockTime: Date;
  outerInstructionIndex: number;
  innerInstructionIndex: number;
  instructionAddress?: number[];
  accounts?: string[];
  data: Uint8Array;
}

export interface SourceCoordinates {
  platform: Platform;
  programId: string;
  ingestionSource: IngestionSource;
  signature: string;
  slot: number;
  blockTime: Date;
  outerInstructionIndex: number;
  innerInstructionIndex: number;
  eventName: string;
  eventDiscriminatorHex: string;
  orderKey: string | null;
  requestKey: string | null;
}

export interface CanonicalPerpTradeHistory {
  positionKey: string;
  address: string;
  pair: string;
  operation: PerpTradeHistoryOperation;
  usdPnlE6: bigint;
  usdBasePnlE6: bigint;
  usdFeeE6: bigint;
  sizeInUsdE6: bigint;
  leverageE6: bigint;
  collateralInUsdE6: bigint;
  collateralDeltaUsdE6: bigint;
  sizeDeltaUsdE6: bigint;
  leverageDeltaE6: bigint;
  isLong: boolean;
  priceE6: bigint;
  collateralUsdPriceE6: bigint;
  closeReason: PerpCloseReason | null;
  dataQuality: DataQuality;
  liquidation: boolean;
  marketAddress: string;
  collateralAddress: string | null;
}

export interface NormalizedPerpEvent {
  source: SourceCoordinates;
  history: CanonicalPerpTradeHistory;
  decodedEvent: Record<string, unknown>;
}

export interface PositionState {
  platform: Platform;
  positionKey: string;
  address: string;
  marketAddress: string;
  collateralAddress: string | null;
  pair: string;
  isLong: boolean;
  sizeInUsdE6: bigint;
  collateralInUsdE6: bigint;
  leverageE6: bigint;
  lastPriceE6: bigint;
  openedAt: Date | null;
  lastSlot: number;
  updatedAt: Date;
  closed: boolean;
}

export type MarketDefinitionSource = 'officialStatic' | 'rpcDiscovery' | 'manual';

export interface MarketDefinition {
  platform: Platform;
  marketAddress: string;
  pair: string;
  source?: MarketDefinitionSource;
  marketAccountAddress?: string;
  indexTokenAddress?: string;
  enabled?: boolean;
  verifiedAt?: string;
  indexTokenDecimals?: number;
  collateralAddress?: string;
  collateralTokenDecimals?: number;
  collateralIsStable?: boolean;
  collateralUsdPrice?: number;
  longCollateralAddress?: string;
  longCollateralTokenDecimals?: number;
  shortCollateralAddress?: string;
  shortCollateralTokenDecimals?: number;
  notes?: string;
}


export interface MarketRegistrySourceMetadata {
  type: 'officialStatic' | 'rpcDiscovery' | 'manual';
  programId: string;
  generatedAt: string;
  sourceUrl?: string;
  rpcUrl?: string;
  marketCount: number;
  notes?: string;
}

export interface MarketRegistryDocument {
  schemaVersion: 1;
  generatedAt: string;
  sources: Partial<Record<Platform, MarketRegistrySourceMetadata>>;
  markets: MarketDefinition[];
}

export interface MarketResolution extends MarketDefinition {
  known: boolean;
  collateralUsdPriceE6: bigint | null;
}

export interface LuckyPlansPurePerpTradeHistory {
  positionKey: string; address: string; pair: string; operation: PerpTradeHistoryOperation;
  usdPnl: number; usdBasePnl: number; usdFee: number; sizeInUsd: number; leverage: number;
  collateralInUsd: number; collateralDeltaUsd: number; sizeDeltaUsd: number; leverageDelta: number;
  isLong: boolean; price: number; collateralUsdPrice: number;
}

export interface EventLogView extends LuckyPlansPurePerpTradeHistory {
  dedupeKey: string; platform: Platform; programId: string; ingestionSource: IngestionSource;
  signature: string; slot: number; date: string; outerInstructionIndex: number; innerInstructionIndex: number;
  eventName: string; eventDiscriminatorHex: string; closeReason: PerpCloseReason | null;
  dataQuality: DataQuality; liquidation: boolean; marketAddress: string; collateralAddress: string | null;
  decodedEvent: Record<string, unknown>;
  fixed: Record<string, string>;
}

export function toLuckyPlansPurePerpTradeHistory(value: CanonicalPerpTradeHistory): LuckyPlansPurePerpTradeHistory {
  return {
    positionKey: value.positionKey, address: value.address, pair: value.pair, operation: value.operation,
    usdPnl: fixed6ToNumber(value.usdPnlE6), usdBasePnl: fixed6ToNumber(value.usdBasePnlE6),
    usdFee: fixed6ToNumber(value.usdFeeE6), sizeInUsd: fixed6ToNumber(value.sizeInUsdE6),
    leverage: fixed6ToNumber(value.leverageE6), collateralInUsd: fixed6ToNumber(value.collateralInUsdE6),
    collateralDeltaUsd: fixed6ToNumber(value.collateralDeltaUsdE6), sizeDeltaUsd: fixed6ToNumber(value.sizeDeltaUsdE6),
    leverageDelta: fixed6ToNumber(value.leverageDeltaE6), isLong: value.isLong,
    price: fixed6ToNumber(value.priceE6), collateralUsdPrice: fixed6ToNumber(value.collateralUsdPriceE6),
  };
}
