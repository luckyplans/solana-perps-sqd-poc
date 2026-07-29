import { Platform } from '../domain/enums';
import { SourceInstruction } from '../domain/models';
import { PlatformAdapterRegistry } from '../platforms/registry';
import { SqliteStore } from '../storage/sqlite-store';
import { Logger } from '../utils/logger';
import { KeyedMutex } from './keyed-mutex';
import { MarketRegistryService } from './market-registry.service';

export interface IngestionResult {
  status: 'inserted' | 'duplicate' | 'unsupported' | 'ignored' | 'failed';
  platform: Platform; signature: string; eventName?: string; positionKey?: string; error?: string;
}

export class IngestionService {
  private readonly mutex = new KeyedMutex();
  constructor(
    private readonly adapters: PlatformAdapterRegistry,
    private readonly markets: MarketRegistryService,
    private readonly store: SqliteStore,
    private readonly logger: Logger,
  ) {}

  async processInstruction(raw: SourceInstruction): Promise<IngestionResult> {
    const adapter = this.adapters.get(raw.platform);
    if (raw.programId !== adapter.programId) return { status: 'unsupported',platform: raw.platform,signature: raw.signature };
    try {
      const decoded = adapter.decodeInstruction(raw.data);
      if (!decoded) return { status: 'unsupported',platform: raw.platform,signature: raw.signature };
      const positionKey = adapter.positionKey(decoded);
      return await this.mutex.run(`${raw.platform}:${positionKey}`, async () => {
        const storedPosition = this.store.getPositionState(raw.platform, positionKey);
        const previousPosition = storedPosition && storedPosition.lastSlot <= raw.slot ? storedPosition : null;
        const marketAddress = adapter.marketAddress(decoded);
        const collateralAddress = adapter.collateralAddress(decoded) ?? previousPosition?.collateralAddress ?? null;
        const market = this.markets.resolve(raw.platform, marketAddress, collateralAddress);
        const normalized = adapter.normalize(decoded, { raw,previousPosition,market });
        if (!normalized) return { status: 'ignored',platform: raw.platform,signature: raw.signature,eventName: decoded.eventName,positionKey };
        const inserted = this.store.insertEventAndState(normalized.event, normalized.nextPositionState);
        return { status: inserted ? 'inserted' : 'duplicate',platform: raw.platform,signature: raw.signature,eventName: decoded.eventName,positionKey };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('event ingestion failed', {
        platform: raw.platform,
        signature: raw.signature,
        slot: raw.slot,
        outerInstructionIndex: raw.outerInstructionIndex,
        innerInstructionIndex: raw.innerInstructionIndex,
        dataLength: raw.data.length,
        instructionPrefixHex: Buffer.from(raw.data.subarray(0, 16)).toString('hex'),
        error: message,
      });
      return { status: 'failed',platform: raw.platform,signature: raw.signature,error: message };
    }
  }

  async processInstructions(instructions: SourceInstruction[]): Promise<Record<IngestionResult['status'], number>> {
    const counts = { inserted: 0,duplicate: 0,unsupported: 0,ignored: 0,failed: 0 };
    const sorted = [...instructions].sort((left, right) => left.slot - right.slot || left.outerInstructionIndex - right.outerInstructionIndex || left.innerInstructionIndex - right.innerInstructionIndex);
    for (const instruction of sorted) counts[(await this.processInstruction(instruction)).status] += 1;
    return counts;
  }
}
