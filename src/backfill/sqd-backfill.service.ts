import { bytesToHex } from '../codec/hex';
import { Platform } from '../domain/enums';
import { SourceInstruction } from '../domain/models';
import { PerpPlatformAdapter } from '../domain/platform-adapter';
import { SqdBlock } from './sqd-client';
import {
  EventBuildInput,
  EventBuildService,
  archiveRecordToSourceInstruction,
  encodeInnerInstructionAddress,
} from './event-build.service';
import {
  ResolvedSqdRange,
  SqdSourceFetchInput,
  SqdSourceFetchService,
  getTransactionSignature,
  sqdBlockToArchiveRecords,
} from './sqd-source-fetch.service';
import { SourceChunkManifest } from '../archive/source-chunk-store';

export type SqdBackfillInput = SqdSourceFetchInput;
export { encodeInnerInstructionAddress, getTransactionSignature };

/**
 * Compatibility facade. It no longer builds event logs directly from SQD.
 * It first commits immutable source chunks, then builds canonical events from
 * those local files.
 */
export class SqdBackfillService {
  constructor(
    private readonly sourceFetch: SqdSourceFetchService,
    private readonly eventBuild: EventBuildService,
  ) {}

  resolveRange(input: SqdBackfillInput): Promise<ResolvedSqdRange> {
    return this.sourceFetch.resolveRange(input);
  }

  async run(input: SqdBackfillInput): Promise<Record<string, unknown>> {
    const source = await this.sourceFetch.run(input);
    const buildInput: EventBuildInput = {
      platform: input.platform,
      from: input.from,
      to: input.to,
      fromSlot: input.fromSlot,
      toSlot: input.toSlot,
      resume: input.resume,
    };
    const build = await this.eventBuild.run(buildInput);
    return { source, build };
  }
}

/**
 * Test/backward-compatible conversion helper. Production ingestion now uses
 * source chunks and EventBuildService instead of calling this directly.
 */
export function sqdBlockToInstructions(
  platform: Platform,
  adapter: PerpPlatformAdapter,
  block: SqdBlock,
): {
  portalInstructions: number;
  filteredEvents: number;
  instructions: SourceInstruction[];
} {
  const converted = sqdBlockToArchiveRecords(adapter.programId, block);
  const manifest: SourceChunkManifest = {
    format: 'luckyplans-solana-program-instructions',
    formatVersion: 1,
    network: 'solana-mainnet',
    platform,
    programId: adapter.programId,
    chunkId: `${platform}:${block.header.number}:${block.header.number}:test`,
    fromSlot: block.header.number,
    toSlot: block.header.number,
    firstRecordSlot: converted.records[0]?.[0] ?? null,
    lastRecordSlot: converted.records.at(-1)?.[0] ?? null,
    firstBlockTimestamp: converted.records[0]?.[1] ?? null,
    lastBlockTimestamp: converted.records.at(-1)?.[1] ?? null,
    recordCount: converted.records.length,
    blockCount: 1,
    uncompressedBytes: 0,
    compressedBytes: 0,
    compression: 'gzip',
    sha256: '0'.repeat(64),
    recordSchema: [
      'slot',
      'blockTimestamp',
      'signature',
      'transactionIndex',
      'instructionAddress',
      'accounts',
      'dataBase64',
    ],
    sqd: {
      portalUrl: 'test',
      queryVersion: 1,
      filter: 'programId+anchorCpiEventTag+isCommitted',
    },
    createdAt: new Date(0).toISOString(),
    dataFile: 'test.ndjson.gz',
  };
  const allowed = new Set(adapter.eventDiscriminatorHexes.map((value) => value.toLowerCase()));
  const instructions: SourceInstruction[] = [];
  let filteredEvents = converted.skippedInstructions;
  for (const record of converted.records) {
    const raw = archiveRecordToSourceInstruction(platform, manifest, record);
    if (raw.data.length < 16) {
      filteredEvents += 1;
      continue;
    }
    const eventDiscriminator = bytesToHex(raw.data.subarray(8, 16)).toLowerCase();
    if (!allowed.has(eventDiscriminator)) {
      filteredEvents += 1;
      continue;
    }
    instructions.push(raw);
  }
  return {
    portalInstructions: converted.portalInstructions,
    filteredEvents,
    instructions,
  };
}
