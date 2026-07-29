import { randomUUID } from 'node:crypto';
import { ArchivedInstructionRecord, SourceChunkManifest, SourceChunkStore } from '../archive/source-chunk-store';
import { ANCHOR_CPI_EVENT_TAG } from '../codec/anchor';
import { base58Decode } from '../codec/base58';
import { bytesToHex } from '../codec/hex';
import { Platform } from '../domain/enums';
import { PlatformAdapterRegistry } from '../platforms/registry';
import { SqliteStore } from '../storage/sqlite-store';
import { Logger } from '../utils/logger';
import { SqdBlock, SqdClient, SqdTransaction } from './sqd-client';

const ANCHOR_CPI_EVENT_TAG_HEX = bytesToHex(ANCHOR_CPI_EVENT_TAG);

export interface SqdSourceFetchInput {
  platform: Platform;
  from?: Date;
  to?: Date;
  fromSlot?: number;
  toSlot?: number;
  batchSlots?: number;
  resume?: boolean;
}

export interface ResolvedSqdRange {
  requestedFrom?: string;
  requestedTo?: string;
  fromSlot: number;
  toSlot: number;
}

export class SqdSourceFetchService {
  constructor(
    private readonly defaultBatchSlots: number,
    private readonly client: SqdClient,
    private readonly adapters: PlatformAdapterRegistry,
    private readonly chunks: SourceChunkStore,
    private readonly store: SqliteStore,
    private readonly logger: Logger,
  ) {}

  async resolveRange(input: SqdSourceFetchInput): Promise<ResolvedSqdRange> {
    if ((input.fromSlot === undefined) !== (input.toSlot === undefined)) {
      throw new Error('--from-slot and --to-slot must be supplied together');
    }

    if (input.fromSlot !== undefined && input.toSlot !== undefined) {
      validateSlot(input.fromSlot, 'fromSlot');
      validateSlot(input.toSlot, 'toSlot');
      if (input.fromSlot > input.toSlot) {
        throw new Error('fromSlot must be less than or equal to toSlot');
      }
      return { fromSlot: input.fromSlot, toSlot: input.toSlot };
    }

    if (!input.from || !input.to) {
      throw new Error('Source fetch requires either from/to dates or fromSlot/toSlot');
    }
    if (input.from >= input.to) {
      throw new Error('Source fetch from date must be earlier than to date');
    }

    const [fromSlot, toExclusiveSlot] = await Promise.all([
      this.client.resolveTimestamp(input.from),
      this.client.resolveTimestamp(input.to),
    ]);
    if (toExclusiveSlot <= fromSlot) {
      throw new Error('SQD resolved an empty slot range for the requested dates');
    }
    return {
      requestedFrom: input.from.toISOString(),
      requestedTo: input.to.toISOString(),
      fromSlot,
      toSlot: toExclusiveSlot - 1,
    };
  }

  async run(input: SqdSourceFetchInput): Promise<Record<string, unknown>> {
    const adapter = this.adapters.get(input.platform);
    const range = await this.resolveRange(input);
    const batchSlots = input.batchSlots ?? this.defaultBatchSlots;
    if (!Number.isInteger(batchSlots) || batchSlots < 1_000 || batchSlots > 250_000) {
      throw new Error('batchSlots must be an integer between 1,000 and 250,000');
    }

    const uncovered = this.chunks.uncoveredRanges(input.platform, range.fromSlot, range.toSlot);
    const windows = uncovered.flatMap((gap) => [...slotWindows(gap.from, gap.to, batchSlots)]);
    const effectiveFromSlot = windows[0]?.from ?? range.toSlot + 1;
    const id = randomUUID();
    this.store.createBackfillJob({
      id,
      platform: input.platform,
      provider: 'sqd-source-archive',
      parameters: {
        portalUrl: this.client.url,
        archiveRoot: this.chunks.rootDir,
        requestedFrom: range.requestedFrom,
        requestedTo: range.requestedTo,
        requestedFromSlot: range.fromSlot,
        requestedToSlot: range.toSlot,
        effectiveFromSlot,
        batchSlots,
        resume: Boolean(input.resume),
        uncovered,
      },
    });

    const total = {
      windows: 0,
      existingWindows: countCoveredWindows(range.fromSlot, range.toSlot, batchSlots, uncovered),
      blocks: 0,
      portalInstructions: 0,
      archivedInstructions: 0,
      skippedInstructions: 0,
      compressedBytes: 0,
      chunks: [] as SourceChunkManifest[],
    };

    try {
      for (const window of windows) {
        this.logger.info('starting SQD source archive slot window', {
          platform: input.platform,
          fromSlot: window.from,
          toSlot: window.to,
        });

        const records: ArchivedInstructionRecord[] = [];
        let blockCount = 0;
        let portalInstructions = 0;
        let skippedInstructions = 0;

        for await (const block of this.client.streamInstructions({
          fromSlot: window.from,
          toSlot: window.to,
          programId: adapter.programId,
          cpiDiscriminatorHex: ANCHOR_CPI_EVENT_TAG_HEX,
        })) {
          blockCount += 1;
          const converted = sqdBlockToArchiveRecords(adapter.programId, block);
          portalInstructions += converted.portalInstructions;
          skippedInstructions += converted.skippedInstructions;
          records.push(...converted.records);
        }

        const manifest = this.chunks.writeChunk({
          platform: input.platform,
          programId: adapter.programId,
          portalUrl: this.client.url,
          fromSlot: window.from,
          toSlot: window.to,
          blockCount,
          records,
        });

        total.windows += 1;
        total.blocks += blockCount;
        total.portalInstructions += portalInstructions;
        total.archivedInstructions += manifest.recordCount;
        total.skippedInstructions += skippedInstructions;
        total.compressedBytes += manifest.compressedBytes;
        total.chunks.push(manifest);

        this.store.updateBackfillJob(id, {
          seen: total.portalInstructions,
          decoded: total.archivedInstructions,
          inserted: total.archivedInstructions,
          skipped: total.skippedInstructions,
        });
      }

      this.store.updateBackfillJob(id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      return {
        id,
        portalUrl: this.client.url,
        archiveRoot: this.chunks.rootDir,
        fromSlot: range.fromSlot,
        toSlot: range.toSlot,
        effectiveFromSlot,
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

export function sqdBlockToArchiveRecords(
  expectedProgramId: string,
  block: SqdBlock,
): {
  portalInstructions: number;
  skippedInstructions: number;
  records: ArchivedInstructionRecord[];
} {
  const slot = numeric(block.header.number, 'block.header.number');
  const blockTimestamp = parseBlockTimestamp(block.header.timestamp, slot);
  const transactionMap = transactionIndexMap(block.transactions ?? []);
  const records: ArchivedInstructionRecord[] = [];
  let skippedInstructions = 0;
  const instructions = block.instructions ?? [];

  for (const instruction of instructions) {
    const programId = String(instruction.programId ?? instruction.program_id ?? '');
    if (programId !== expectedProgramId) {
      skippedInstructions += 1;
      continue;
    }
    const committed = instruction.isCommitted ?? instruction.is_committed;
    if (committed === false || instruction.error) {
      skippedInstructions += 1;
      continue;
    }

    const data = base58Decode(String(instruction.data ?? ''));
    if (data.length < 8 || bytesToHex(data.subarray(0, 8)) !== ANCHOR_CPI_EVENT_TAG_HEX) {
      skippedInstructions += 1;
      continue;
    }

    const transactionIndex = numeric(
      instruction.transactionIndex ?? instruction.transaction_index,
      'instruction.transactionIndex',
    );
    let transaction = transactionMap.get(transactionIndex);
    if (!transaction && transactionMap.size === 1) {
      transaction = transactionMap.values().next().value as SqdTransaction | undefined;
    }
    const signature = getTransactionSignature(transaction);
    if (!signature) {
      const availableIndexes = [...transactionMap.keys()].slice(0, 20).join(', ');
      const fields = transaction ? Object.keys(transaction).join(', ') : 'transaction not included';
      throw new Error(
        `SQD instruction at slot ${slot} transaction ${transactionIndex} has no transaction signature `
        + `(fields: ${fields}; available transaction indexes: ${availableIndexes || 'none'})`,
      );
    }
    if (transaction?.err !== null && transaction?.err !== undefined) {
      skippedInstructions += 1;
      continue;
    }

    const instructionAddress = instruction.instructionAddress ?? instruction.instruction_address;
    if (!Array.isArray(instructionAddress) || instructionAddress.length === 0) {
      throw new Error(`SQD instruction ${signature} at slot ${slot} has no instructionAddress`);
    }
    const normalizedAddress = instructionAddress.map((item) => numeric(item, 'instructionAddress item'));

    records.push([
      slot,
      blockTimestamp,
      signature,
      transactionIndex,
      normalizedAddress,
      normalizeAccounts(instruction.accounts),
      Buffer.from(data).toString('base64'),
    ]);
  }

  records.sort(compareArchiveRecords);
  return {
    portalInstructions: instructions.length,
    skippedInstructions,
    records,
  };
}

export function getTransactionSignature(transaction?: SqdTransaction): string | undefined {
  if (!transaction) return undefined;
  if (typeof transaction.signature === 'string' && transaction.signature.length > 0) {
    return transaction.signature;
  }
  if (typeof transaction.signatures === 'string' && transaction.signatures.length > 0) {
    return transaction.signatures;
  }
  if (Array.isArray(transaction.signatures)) {
    return transaction.signatures.find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
  }
  return undefined;
}


function normalizeAccounts(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error('Invalid SQD instruction accounts');
  }
  return value as string[];
}

function transactionIndexMap(transactions: SqdTransaction[]): Map<number, SqdTransaction> {
  const map = new Map<number, SqdTransaction>();
  for (let index = 0; index < transactions.length; index += 1) {
    const transaction = transactions[index]!;
    const transactionIndex = numeric(
      transaction.transactionIndex ?? transaction.transaction_index ?? transaction.index ?? index,
      'transactionIndex',
    );
    map.set(transactionIndex, transaction);
  }
  return map;
}

function parseBlockTimestamp(value: number | string | undefined, slot: number): number {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error(`SQD block ${slot} has no valid timestamp`);
  }
  const seconds = timestamp > 10_000_000_000 ? Math.floor(timestamp / 1_000) : Math.floor(timestamp);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(`SQD block ${slot} has invalid timestamp ${String(value)}`);
  }
  return seconds;
}

function numeric(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid SQD ${name}: ${String(value)}`);
  }
  return parsed;
}

function validateSlot(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function* slotWindows(
  fromSlot: number,
  toSlot: number,
  size: number,
): Generator<{ from: number; to: number }> {
  let cursor = fromSlot;
  while (cursor <= toSlot) {
    const end = Math.min(toSlot, cursor + size - 1);
    yield { from: cursor, to: end };
    cursor = end + 1;
  }
}

function compareArchiveRecords(left: ArchivedInstructionRecord, right: ArchivedInstructionRecord): number {
  return left[0] - right[0]
    || left[3] - right[3]
    || compareAddresses(left[4], right[4])
    || left[2].localeCompare(right[2]);
}

function compareAddresses(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function countCoveredWindows(
  fromSlot: number,
  toSlot: number,
  batchSlots: number,
  uncovered: Array<{ from: number; to: number }>,
): number {
  const all = [...slotWindows(fromSlot, toSlot, batchSlots)].length;
  const missing = uncovered.reduce(
    (sum, gap) => sum + [...slotWindows(gap.from, gap.to, batchSlots)].length,
    0,
  );
  return Math.max(0, all - missing);
}
