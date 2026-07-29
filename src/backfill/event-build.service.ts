import { createHash, randomUUID } from 'node:crypto';
import { ArchivedInstructionRecord, SourceChunkManifest, SourceChunkStore } from '../archive/source-chunk-store';
import { ANCHOR_CPI_EVENT_TAG } from '../codec/anchor';
import { bytesToHex } from '../codec/hex';
import { IngestionSource, Platform } from '../domain/enums';
import { SourceInstruction } from '../domain/models';
import { PlatformAdapterRegistry } from '../platforms/registry';
import { IngestionService } from '../services/ingestion.service';
import { SqliteStore } from '../storage/sqlite-store';
import { Logger } from '../utils/logger';

const ANCHOR_CPI_EVENT_TAG_HEX = bytesToHex(ANCHOR_CPI_EVENT_TAG);
export const EVENT_BUILD_VERSION = 1;

export interface EventBuildInput {
  platform: Platform;
  from?: Date;
  to?: Date;
  fromSlot?: number;
  toSlot?: number;
  resume?: boolean;
  verifyChunks?: boolean;
  instructionBatchSize?: number;
}

export class EventBuildService {
  constructor(
    private readonly chunks: SourceChunkStore,
    private readonly adapters: PlatformAdapterRegistry,
    private readonly ingestion: IngestionService,
    private readonly store: SqliteStore,
    private readonly logger: Logger,
  ) {}

  async run(input: EventBuildInput): Promise<Record<string, unknown>> {
    validateInput(input);
    const adapter = this.adapters.get(input.platform);
    const instructionBatchSize = input.instructionBatchSize ?? 1_000;
    if (!Number.isSafeInteger(instructionBatchSize) || instructionBatchSize < 1 || instructionBatchSize > 100_000) {
      throw new Error('instructionBatchSize must be an integer between 1 and 100,000');
    }

    const manifests = this.chunks.listOverlapping(input.platform, {
      fromSlot: input.fromSlot,
      toSlot: input.toSlot,
    }).filter((manifest) => manifestOverlapsTime(manifest, input.from, input.to));
    const scope = buildScope(input);
    const id = randomUUID();
    this.store.createBackfillJob({
      id,
      platform: input.platform,
      provider: 'local-source-chunks',
      parameters: {
        archiveRoot: this.chunks.rootDir,
        eventBuildVersion: EVENT_BUILD_VERSION,
        scope,
        from: input.from?.toISOString(),
        to: input.to?.toISOString(),
        fromSlot: input.fromSlot,
        toSlot: input.toSlot,
        resume: Boolean(input.resume),
        verifyChunks: input.verifyChunks !== false,
        instructionBatchSize,
      },
    });

    const total = {
      chunks: 0,
      skippedChunks: 0,
      archivedInstructions: 0,
      targetInstructions: 0,
      filteredEvents: 0,
      inserted: 0,
      duplicate: 0,
      unsupported: 0,
      ignored: 0,
      failed: 0,
    };

    try {
      for (const manifest of manifests) {
        const cursorKey = buildCursorKey(input.platform, scope, manifest.chunkId);
        if (input.resume && this.store.getCursor(cursorKey)?.completed === true) {
          total.skippedChunks += 1;
          continue;
        }

        this.logger.info('building event logs from source chunk', {
          platform: input.platform,
          chunkId: manifest.chunkId,
          fromSlot: manifest.fromSlot,
          toSlot: manifest.toSlot,
          recordCount: manifest.recordCount,
        });

        const records = this.chunks.readRecords(manifest, input.verifyChunks !== false);
        total.archivedInstructions += records.length;
        let pending: SourceInstruction[] = [];

        const flush = async (): Promise<void> => {
          if (pending.length === 0) return;
          const counts = await this.ingestion.processInstructions(pending);
          pending = [];
          for (const key of ['inserted', 'duplicate', 'unsupported', 'ignored', 'failed'] as const) {
            total[key] += counts[key];
          }
          if (counts.failed > 0 || counts.unsupported > 0) {
            throw new Error(
              `Source chunk ${manifest.chunkId} produced ${counts.failed} failed and ${counts.unsupported} unsupported target event(s); build cursor was not advanced`,
            );
          }
        };

        for (const record of records) {
          if (!recordInRange(record, input)) continue;
          const converted = archiveRecordToSourceInstruction(input.platform, manifest, record);
          const data = converted.data;
          if (data.length < 16 || bytesToHex(data.subarray(0, 8)) !== ANCHOR_CPI_EVENT_TAG_HEX) {
            total.filteredEvents += 1;
            continue;
          }
          const discriminator = bytesToHex(data.subarray(8, 16)).toLowerCase();
          if (!adapter.eventDiscriminatorHexes.some((value) => value.toLowerCase() === discriminator)) {
            total.filteredEvents += 1;
            continue;
          }
          total.targetInstructions += 1;
          pending.push(converted);
          if (pending.length >= instructionBatchSize) await flush();
        }
        await flush();

        total.chunks += 1;
        this.store.setCursor(cursorKey, {
          completed: true,
          chunkId: manifest.chunkId,
          buildVersion: EVENT_BUILD_VERSION,
          completedAt: new Date().toISOString(),
        });
        this.store.updateBackfillJob(id, {
          seen: total.archivedInstructions,
          decoded: total.targetInstructions - total.unsupported,
          inserted: total.inserted,
          skipped: total.duplicate + total.ignored + total.filteredEvents + total.unsupported,
        });
      }

      this.store.updateBackfillJob(id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      return {
        id,
        archiveRoot: this.chunks.rootDir,
        eventBuildVersion: EVENT_BUILD_VERSION,
        scope,
        availableChunks: manifests.length,
        ...total,
      };
    } catch (error) {
      this.store.updateBackfillJob(id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      });
      throw error;
    }
  }
}

export function archiveRecordToSourceInstruction(
  platform: Platform,
  manifest: SourceChunkManifest,
  record: ArchivedInstructionRecord,
): SourceInstruction {
  const [slot, blockTimestamp, signature, , instructionAddress, accounts, dataBase64] = record;
  if (manifest.platform !== platform) {
    throw new Error(`Source chunk ${manifest.chunkId} platform mismatch`);
  }
  if (!Array.isArray(instructionAddress) || instructionAddress.length === 0) {
    throw new Error(`Source record ${signature} at slot ${slot} has no instruction address`);
  }
  const data = Buffer.from(dataBase64, 'base64');
  if (data.length === 0) {
    throw new Error(`Source record ${signature} at slot ${slot} has empty instruction data`);
  }
  return {
    platform,
    programId: manifest.programId,
    ingestionSource: IngestionSource.SQD,
    signature,
    slot,
    blockTime: new Date(blockTimestamp * 1_000),
    outerInstructionIndex: instructionAddress[0]! + 1,
    innerInstructionIndex: encodeInnerInstructionAddress(instructionAddress.slice(1)),
    instructionAddress: [...instructionAddress],
    accounts: [...accounts],
    data,
  };
}

export function encodeInnerInstructionAddress(address: number[]): number {
  if (address.length === 0) return 0;
  let encoded = 0;
  for (const item of address) {
    if (!Number.isSafeInteger(item) || item < 0 || item >= 9_999) {
      throw new Error(`Invalid instructionAddress item: ${String(item)}`);
    }
    encoded = encoded * 10_000 + item + 1;
    if (!Number.isSafeInteger(encoded)) {
      throw new Error('instructionAddress cannot be encoded safely');
    }
  }
  return encoded;
}

function validateInput(input: EventBuildInput): void {
  if ((input.fromSlot === undefined) !== (input.toSlot === undefined)) {
    throw new Error('--from-slot and --to-slot must be supplied together');
  }
  if (input.fromSlot !== undefined && input.toSlot !== undefined) {
    if (!Number.isSafeInteger(input.fromSlot) || input.fromSlot < 0) throw new Error('fromSlot must be a non-negative safe integer');
    if (!Number.isSafeInteger(input.toSlot) || input.toSlot < input.fromSlot) throw new Error('toSlot must be greater than or equal to fromSlot');
  }
  if ((input.from === undefined) !== (input.to === undefined)) {
    throw new Error('--from and --to must be supplied together');
  }
  if (input.from && input.to && input.from >= input.to) {
    throw new Error('Event build from date must be earlier than to date');
  }
}

function recordInRange(record: ArchivedInstructionRecord, input: EventBuildInput): boolean {
  if (input.fromSlot !== undefined && record[0] < input.fromSlot) return false;
  if (input.toSlot !== undefined && record[0] > input.toSlot) return false;
  const timestampMs = record[1] * 1_000;
  if (input.from && timestampMs < input.from.getTime()) return false;
  if (input.to && timestampMs >= input.to.getTime()) return false;
  return true;
}

function manifestOverlapsTime(
  manifest: SourceChunkManifest,
  from?: Date,
  to?: Date,
): boolean {
  if (!from || !to) return true;
  if (manifest.recordCount === 0) return false;
  const first = (manifest.firstBlockTimestamp ?? 0) * 1_000;
  const last = (manifest.lastBlockTimestamp ?? 0) * 1_000;
  return last >= from.getTime() && first < to.getTime();
}

function buildScope(input: EventBuildInput): string {
  const value = JSON.stringify({
    from: input.from?.toISOString() ?? null,
    to: input.to?.toISOString() ?? null,
    fromSlot: input.fromSlot ?? null,
    toSlot: input.toSlot ?? null,
  });
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function buildCursorKey(platform: Platform, scope: string, chunkId: string): string {
  return `source-build:${platform}:v${EVENT_BUILD_VERSION}:${scope}:${chunkId}`;
}
