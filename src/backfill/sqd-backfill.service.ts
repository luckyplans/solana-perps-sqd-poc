import { randomUUID } from 'node:crypto';
import { ANCHOR_CPI_EVENT_TAG } from '../codec/anchor';
import { base58Decode } from '../codec/base58';
import { bytesToHex } from '../codec/hex';
import { IngestionSource, Platform } from '../domain/enums';
import { SourceInstruction } from '../domain/models';
import { PerpPlatformAdapter } from '../domain/platform-adapter';
import { PlatformAdapterRegistry } from '../platforms/registry';
import { IngestionService } from '../services/ingestion.service';
import { SqliteStore } from '../storage/sqlite-store';
import { Logger } from '../utils/logger';
import { SqdBlock, SqdClient, SqdInstruction, SqdTransaction } from './sqd-client';

const ANCHOR_CPI_EVENT_TAG_HEX = bytesToHex(ANCHOR_CPI_EVENT_TAG);

export interface SqdBackfillInput {
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

export class SqdBackfillService {
  constructor(
    private readonly defaultBatchSlots: number,
    private readonly client: SqdClient,
    private readonly adapters: PlatformAdapterRegistry,
    private readonly ingestion: IngestionService,
    private readonly store: SqliteStore,
    private readonly logger: Logger,
  ) {}

  async resolveRange(input: SqdBackfillInput): Promise<ResolvedSqdRange> {
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
      throw new Error('Backfill requires either from/to dates or fromSlot/toSlot');
    }
    if (input.from >= input.to) {
      throw new Error('Backfill from date must be earlier than to date');
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

  async run(input: SqdBackfillInput): Promise<Record<string, unknown>> {
    const adapter = this.adapters.get(input.platform);
    const range = await this.resolveRange(input);
    const batchSlots = input.batchSlots ?? this.defaultBatchSlots;
    if (!Number.isInteger(batchSlots) || batchSlots < 1_000 || batchSlots > 1_000_000) {
      throw new Error('batchSlots must be an integer between 1,000 and 1,000,000');
    }

    const cursorKey = `sqd:${input.platform}:next-slot`;
    let effectiveFromSlot = range.fromSlot;
    if (input.resume) {
      const cursor = this.store.getCursor(cursorKey);
      const nextSlot = Number(cursor?.nextSlot);
      if (Number.isSafeInteger(nextSlot) && nextSlot > effectiveFromSlot) {
        effectiveFromSlot = Math.min(nextSlot, range.toSlot + 1);
      }
    }

    const id = randomUUID();
    this.store.createBackfillJob({
      id,
      platform: input.platform,
      provider: 'sqd-portal',
      parameters: {
        portalUrl: this.client.url,
        requestedFrom: range.requestedFrom,
        requestedTo: range.requestedTo,
        requestedFromSlot: range.fromSlot,
        requestedToSlot: range.toSlot,
        effectiveFromSlot,
        batchSlots,
        resume: Boolean(input.resume),
      },
    });

    const total = {
      windows: 0,
      blocks: 0,
      portalInstructions: 0,
      targetInstructions: 0,
      filteredEvents: 0,
      inserted: 0,
      duplicate: 0,
      unsupported: 0,
      ignored: 0,
      failed: 0,
    };

    try {
      for (const window of slotWindows(effectiveFromSlot, range.toSlot, batchSlots)) {
        this.logger.info('starting SQD backfill slot window', {
          platform: input.platform,
          fromSlot: window.from,
          toSlot: window.to,
        });

        for await (const block of this.client.streamInstructions({
          fromSlot: window.from,
          toSlot: window.to,
          programId: adapter.programId,
          cpiDiscriminatorHex: ANCHOR_CPI_EVENT_TAG_HEX,
        })) {
          total.blocks += 1;
          const converted = sqdBlockToInstructions(input.platform, adapter, block);
          total.portalInstructions += converted.portalInstructions;
          total.filteredEvents += converted.filteredEvents;
          total.targetInstructions += converted.instructions.length;
          if (converted.instructions.length === 0) continue;

          const counts = await this.ingestion.processInstructions(converted.instructions);
          for (const key of [
            'inserted',
            'duplicate',
            'unsupported',
            'ignored',
            'failed',
          ] as const) {
            total[key] += counts[key];
          }

          this.store.updateBackfillJob(id, {
            seen: total.portalInstructions,
            decoded: total.targetInstructions - total.unsupported,
            inserted: total.inserted,
            skipped: total.duplicate + total.ignored + total.filteredEvents + total.unsupported,
          });

          if (counts.failed > 0 || counts.unsupported > 0) {
            throw new Error(
              `SQD window produced ${counts.failed} failed and ${counts.unsupported} unsupported target event(s); cursor was not advanced`,
            );
          }
        }

        total.windows += 1;
        this.store.setCursor(cursorKey, { nextSlot: window.to + 1 });
      }

      this.store.updateBackfillJob(id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
      return {
        id,
        portalUrl: this.client.url,
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

export function sqdBlockToInstructions(
  platform: Platform,
  adapter: PerpPlatformAdapter,
  block: SqdBlock,
): {
  portalInstructions: number;
  filteredEvents: number;
  instructions: SourceInstruction[];
} {
  const slot = Number(block.header.number);
  validateSlot(slot, 'block.header.number');
  const blockTime = parseBlockTime(block.header.timestamp, slot);
  const transactionMap = new Map<number, SqdTransaction>();
  for (let index = 0; index < (block.transactions ?? []).length; index += 1) {
    const transaction = block.transactions![index]!;
    const transactionIndex = numeric(
      transaction.transactionIndex ?? transaction.transaction_index ?? transaction.index ?? index,
      'transactionIndex',
    );
    transactionMap.set(transactionIndex, transaction);
  }

  const allowed = new Set(adapter.eventDiscriminatorHexes.map((value) => value.toLowerCase()));
  const instructions: SourceInstruction[] = [];
  let filteredEvents = 0;
  const sourceInstructions = block.instructions ?? [];

  for (const instruction of sourceInstructions) {
    const programId = String(instruction.programId ?? instruction.program_id ?? '');
    if (programId !== adapter.programId) continue;
    const committed = instruction.isCommitted ?? instruction.is_committed;
    if (committed === false || instruction.error) continue;

    const data = base58Decode(String(instruction.data ?? ''));
    if (data.length < 16 || bytesToHex(data.subarray(0, 8)) !== ANCHOR_CPI_EVENT_TAG_HEX) {
      filteredEvents += 1;
      continue;
    }
    const eventDiscriminator = bytesToHex(data.subarray(8, 16)).toLowerCase();
    if (!allowed.has(eventDiscriminator)) {
      filteredEvents += 1;
      continue;
    }

    const transactionIndex = numeric(
      instruction.transactionIndex ?? instruction.transaction_index,
      'instruction.transactionIndex',
    );
    let transaction = transactionMap.get(transactionIndex);
    // Portal relation responses are filtered. Older/default field selections may omit
    // transactionIndex, leaving one related transaction at array position 0 while
    // the instruction retains its original block transaction index. Prefer the
    // explicit index, but safely use the sole returned transaction as a fallback.
    if (!transaction && transactionMap.size === 1) {
      transaction = transactionMap.values().next().value as SqdTransaction | undefined;
    }
    const signature = getTransactionSignature(transaction);
    if (!signature) {
      const availableIndexes = [...transactionMap.keys()].slice(0, 20).join(', ');
      const transactionFields = transaction ? Object.keys(transaction).join(', ') : 'transaction not included';
      throw new Error(
        `SQD instruction at slot ${slot} transaction ${transactionIndex} has no transaction signature ` +
        `(fields: ${transactionFields}; available transaction indexes: ${availableIndexes || 'none'}). ` +
        `Ensure fields.transaction includes transactionIndex and signatures, and the raw Portal ` +
        `instruction selector includes { transaction: true }.`,
      );
    }
    if (transaction?.err !== null && transaction?.err !== undefined) continue;

    const address = instruction.instructionAddress ?? instruction.instruction_address;
    if (!Array.isArray(address) || address.length === 0) {
      throw new Error(
        `SQD instruction ${signature} at slot ${slot} has no instructionAddress`,
      );
    }

    instructions.push({
      platform,
      programId,
      ingestionSource: IngestionSource.SQD,
      signature,
      slot,
      blockTime,
      outerInstructionIndex: numeric(address[0], 'instructionAddress[0]') + 1,
      innerInstructionIndex: encodeInnerInstructionAddress(address.slice(1)),
      data,
    });
  }

  return {
    portalInstructions: sourceInstructions.length,
    filteredEvents,
    instructions,
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
    const signature = transaction.signatures.find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    return signature;
  }
  return undefined;
}

export function encodeInnerInstructionAddress(address: number[]): number {
  if (address.length === 0) return 0;
  let encoded = 0;
  for (const item of address) {
    const index = numeric(item, 'instructionAddress item');
    if (index >= 9_999) {
      throw new Error(`instructionAddress item is too large: ${index}`);
    }
    encoded = encoded * 10_000 + index + 1;
    if (!Number.isSafeInteger(encoded)) {
      throw new Error('instructionAddress cannot be encoded safely');
    }
  }
  return encoded;
}

function parseBlockTime(value: number | string | undefined, slot: number): Date {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error(`SQD block ${slot} has no valid timestamp`);
  }
  const date = new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1_000);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`SQD block ${slot} has invalid timestamp ${String(value)}`);
  }
  return date;
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
