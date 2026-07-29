import { Platform } from './enums';
import { MarketResolution, NormalizedPerpEvent, PositionState, SourceInstruction } from './models';

export interface DecodedPlatformEvent {
  eventName: string;
  eventDiscriminatorHex: string;
  value: Record<string, unknown>;
}

export interface PlatformNormalizationContext {
  raw: SourceInstruction;
  previousPosition: PositionState | null;
  market: MarketResolution;
}

export interface PlatformNormalizationResult {
  event: NormalizedPerpEvent;
  nextPositionState: PositionState | null;
}

export interface PerpPlatformAdapter {
  readonly platform: Platform;
  readonly programId: string;
  readonly eventDiscriminatorHexes: readonly string[];
  decodeInstruction(data: Uint8Array): DecodedPlatformEvent | null;
  positionKey(decoded: DecodedPlatformEvent): string;
  marketAddress(decoded: DecodedPlatformEvent): string;
  collateralAddress(decoded: DecodedPlatformEvent): string | null;
  normalize(decoded: DecodedPlatformEvent, context: PlatformNormalizationContext): PlatformNormalizationResult | null;
}
