import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Platform } from '../domain/enums';

export const SOURCE_CHUNK_FORMAT = 'luckyplans-solana-program-instructions';
export const SOURCE_CHUNK_FORMAT_VERSION = 1;
export const SOURCE_CHUNK_COMPRESSION = 'gzip';

/**
 * Compact, ordered, replayable source record.
 *
 * Tuple fields:
 * 0 slot
 * 1 block timestamp in Unix seconds
 * 2 transaction signature (base58)
 * 3 transaction index in block
 * 4 raw instruction address in the Solana call tree
 * 5 instruction accounts (base58)
 * 6 raw instruction data (base64)
 */
export type ArchivedInstructionRecord = [
  slot: number,
  blockTimestamp: number,
  signature: string,
  transactionIndex: number,
  instructionAddress: number[],
  accounts: string[],
  dataBase64: string,
];

export interface SourceChunkManifest {
  format: typeof SOURCE_CHUNK_FORMAT;
  formatVersion: typeof SOURCE_CHUNK_FORMAT_VERSION;
  network: 'solana-mainnet';
  platform: Platform;
  programId: string;
  chunkId: string;
  fromSlot: number;
  toSlot: number;
  firstRecordSlot: number | null;
  lastRecordSlot: number | null;
  firstBlockTimestamp: number | null;
  lastBlockTimestamp: number | null;
  recordCount: number;
  blockCount: number;
  uncompressedBytes: number;
  compressedBytes: number;
  compression: typeof SOURCE_CHUNK_COMPRESSION;
  sha256: string;
  recordSchema: [
    'slot',
    'blockTimestamp',
    'signature',
    'transactionIndex',
    'instructionAddress',
    'accounts',
    'dataBase64',
  ];
  sqd: {
    portalUrl: string;
    queryVersion: 1;
    filter: 'programId+anchorCpiEventTag+isCommitted';
  };
  createdAt: string;
  dataFile: string;
}

export interface WriteSourceChunkInput {
  platform: Platform;
  programId: string;
  portalUrl: string;
  fromSlot: number;
  toSlot: number;
  blockCount: number;
  records: ArchivedInstructionRecord[];
}

export interface SourceArchiveStats {
  rootDir: string;
  platform?: Platform;
  chunkCount: number;
  recordCount: number;
  compressedBytes: number;
  fromSlot: number | null;
  toSlot: number | null;
}

export class SourceChunkStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
    mkdirSync(this.rootDir, { recursive: true });
  }

  writeChunk(input: WriteSourceChunkInput): SourceChunkManifest {
    validateRange(input.fromSlot, input.toSlot);
    assertOrdered(input.records, input.fromSlot, input.toSlot);

    const directory = this.platformDir(input.platform);
    mkdirSync(directory, { recursive: true });
    const stem = chunkStem(input.fromSlot, input.toSlot);
    const dataFile = `${stem}.ndjson.gz`;
    const manifestFile = `${stem}.manifest.json`;
    const dataPath = join(directory, dataFile);
    const manifestPath = join(directory, manifestFile);

    if (existsSync(dataPath) || existsSync(manifestPath)) {
      const existing = this.readManifest(manifestPath);
      this.verifyManifest(existing);
      return existing;
    }

    const text = input.records.length === 0
      ? ''
      : `${input.records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    const compressed = gzipSync(Buffer.from(text, 'utf8'), { level: 6 });
    const sha256 = createHash('sha256').update(compressed).digest('hex');
    const partialToken = randomUUID();
    const partialDataPath = `${dataPath}.${partialToken}.partial`;
    const partialManifestPath = `${manifestPath}.${partialToken}.partial`;

    try {
      writeFileSync(partialDataPath, compressed, { flag: 'wx' });
      const first = input.records[0];
      const last = input.records[input.records.length - 1];
      const manifest: SourceChunkManifest = {
        format: SOURCE_CHUNK_FORMAT,
        formatVersion: SOURCE_CHUNK_FORMAT_VERSION,
        network: 'solana-mainnet',
        platform: input.platform,
        programId: input.programId,
        chunkId: `${input.platform}:${input.fromSlot}:${input.toSlot}:v${SOURCE_CHUNK_FORMAT_VERSION}`,
        fromSlot: input.fromSlot,
        toSlot: input.toSlot,
        firstRecordSlot: first?.[0] ?? null,
        lastRecordSlot: last?.[0] ?? null,
        firstBlockTimestamp: first?.[1] ?? null,
        lastBlockTimestamp: last?.[1] ?? null,
        recordCount: input.records.length,
        blockCount: input.blockCount,
        uncompressedBytes: Buffer.byteLength(text),
        compressedBytes: compressed.byteLength,
        compression: SOURCE_CHUNK_COMPRESSION,
        sha256,
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
          portalUrl: input.portalUrl,
          queryVersion: 1,
          filter: 'programId+anchorCpiEventTag+isCommitted',
        },
        createdAt: new Date().toISOString(),
        dataFile,
      };
      writeFileSync(partialManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      renameSync(partialDataPath, dataPath);
      renameSync(partialManifestPath, manifestPath);
      return manifest;
    } catch (error) {
      safeUnlink(partialDataPath);
      safeUnlink(partialManifestPath);
      throw error;
    }
  }

  list(platform?: Platform): SourceChunkManifest[] {
    const platforms = platform ? [platform] : Object.values(Platform);
    const manifests: SourceChunkManifest[] = [];
    for (const selected of platforms) {
      const directory = this.platformDir(selected);
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory)) {
        if (!name.endsWith('.manifest.json')) continue;
        manifests.push(this.readManifest(join(directory, name)));
      }
    }
    return manifests.sort((left, right) =>
      left.platform.localeCompare(right.platform)
      || left.fromSlot - right.fromSlot
      || left.toSlot - right.toSlot,
    );
  }

  listOverlapping(
    platform: Platform,
    range: { fromSlot?: number; toSlot?: number } = {},
  ): SourceChunkManifest[] {
    return this.list(platform).filter((manifest) => {
      if (range.fromSlot !== undefined && manifest.toSlot < range.fromSlot) return false;
      if (range.toSlot !== undefined && manifest.fromSlot > range.toSlot) return false;
      return true;
    });
  }

  uncoveredRanges(
    platform: Platform,
    fromSlot: number,
    toSlot: number,
  ): Array<{ from: number; to: number }> {
    validateRange(fromSlot, toSlot);
    const intervals = this.listOverlapping(platform, { fromSlot, toSlot })
      .map((manifest) => ({
        from: Math.max(fromSlot, manifest.fromSlot),
        to: Math.min(toSlot, manifest.toSlot),
      }))
      .sort((left, right) => left.from - right.from || left.to - right.to);

    const merged: Array<{ from: number; to: number }> = [];
    for (const interval of intervals) {
      const previous = merged[merged.length - 1];
      if (!previous || interval.from > previous.to + 1) {
        merged.push({ ...interval });
      } else {
        previous.to = Math.max(previous.to, interval.to);
      }
    }

    const gaps: Array<{ from: number; to: number }> = [];
    let cursor = fromSlot;
    for (const interval of merged) {
      if (cursor < interval.from) gaps.push({ from: cursor, to: interval.from - 1 });
      cursor = Math.max(cursor, interval.to + 1);
    }
    if (cursor <= toSlot) gaps.push({ from: cursor, to: toSlot });
    return gaps;
  }

  readRecords(manifest: SourceChunkManifest, verify = true): ArchivedInstructionRecord[] {
    if (verify) this.verifyManifest(manifest);
    const dataPath = this.dataPath(manifest);
    const text = String(gunzipSync(readFileSync(dataPath)).toString('utf8'));
    if (!text) return [];
    const records = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => parseRecord(line, manifest, index + 1));
    if (records.length !== manifest.recordCount) {
      throw new Error(
        `Source chunk ${manifest.chunkId} record count mismatch: manifest=${manifest.recordCount}, actual=${records.length}`,
      );
    }
    assertOrdered(records, manifest.fromSlot, manifest.toSlot);
    return records;
  }

  verifyManifest(manifest: SourceChunkManifest): void {
    validateManifest(manifest);
    const dataPath = this.dataPath(manifest);
    if (!existsSync(dataPath)) {
      throw new Error(`Source chunk data file is missing: ${dataPath}`);
    }
    const bytes = readFileSync(dataPath);
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== manifest.sha256) {
      throw new Error(
        `Source chunk checksum mismatch for ${manifest.chunkId}: expected ${manifest.sha256}, actual ${actualHash}`,
      );
    }
    if (bytes.byteLength !== manifest.compressedBytes) {
      throw new Error(
        `Source chunk size mismatch for ${manifest.chunkId}: expected ${manifest.compressedBytes}, actual ${bytes.byteLength}`,
      );
    }
  }

  stats(platform?: Platform): SourceArchiveStats {
    const manifests = this.list(platform);
    return {
      rootDir: this.rootDir,
      platform,
      chunkCount: manifests.length,
      recordCount: manifests.reduce((sum, item) => sum + item.recordCount, 0),
      compressedBytes: manifests.reduce((sum, item) => sum + item.compressedBytes, 0),
      fromSlot: manifests.length ? Math.min(...manifests.map((item) => item.fromSlot)) : null,
      toSlot: manifests.length ? Math.max(...manifests.map((item) => item.toSlot)) : null,
    };
  }

  manifestPath(manifest: SourceChunkManifest): string {
    return join(this.platformDir(manifest.platform), `${chunkStem(manifest.fromSlot, manifest.toSlot)}.manifest.json`);
  }

  dataPath(manifest: SourceChunkManifest): string {
    const path = join(this.platformDir(manifest.platform), basename(manifest.dataFile));
    if (dirname(path) !== this.platformDir(manifest.platform)) {
      throw new Error(`Unsafe source chunk data path: ${manifest.dataFile}`);
    }
    return path;
  }

  private platformDir(platform: Platform): string {
    return join(this.rootDir, 'solana-mainnet', platform);
  }

  private readManifest(path: string): SourceChunkManifest {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as SourceChunkManifest;
    validateManifest(manifest);
    return manifest;
  }
}

function chunkStem(fromSlot: number, toSlot: number): string {
  return `${String(fromSlot).padStart(12, '0')}-${String(toSlot).padStart(12, '0')}.v${SOURCE_CHUNK_FORMAT_VERSION}`;
}

function parseRecord(
  line: string,
  manifest: SourceChunkManifest,
  lineNumber: number,
): ArchivedInstructionRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `Invalid JSON in source chunk ${manifest.chunkId} line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(value) || value.length !== 7) {
    throw new Error(`Invalid source record tuple in ${manifest.chunkId} line ${lineNumber}`);
  }
  const [slot, timestamp, signature, transactionIndex, instructionAddress, accounts, dataBase64] = value;
  if (!Number.isSafeInteger(slot) || slot < 0) throw new Error(`Invalid slot in ${manifest.chunkId} line ${lineNumber}`);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error(`Invalid timestamp in ${manifest.chunkId} line ${lineNumber}`);
  if (typeof signature !== 'string' || signature.length === 0) throw new Error(`Invalid signature in ${manifest.chunkId} line ${lineNumber}`);
  if (!Number.isSafeInteger(transactionIndex) || transactionIndex < 0) throw new Error(`Invalid transaction index in ${manifest.chunkId} line ${lineNumber}`);
  if (!Array.isArray(instructionAddress) || instructionAddress.length === 0 || instructionAddress.some((item) => !Number.isSafeInteger(item) || item < 0)) {
    throw new Error(`Invalid instruction address in ${manifest.chunkId} line ${lineNumber}`);
  }
  if (!Array.isArray(accounts) || accounts.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`Invalid instruction accounts in ${manifest.chunkId} line ${lineNumber}`);
  }
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) throw new Error(`Invalid instruction data in ${manifest.chunkId} line ${lineNumber}`);
  return value as ArchivedInstructionRecord;
}

function validateManifest(manifest: SourceChunkManifest): void {
  if (manifest.format !== SOURCE_CHUNK_FORMAT) throw new Error(`Unsupported source chunk format: ${String(manifest.format)}`);
  if (manifest.formatVersion !== SOURCE_CHUNK_FORMAT_VERSION) throw new Error(`Unsupported source chunk version: ${String(manifest.formatVersion)}`);
  if (!Object.values(Platform).includes(manifest.platform)) throw new Error(`Invalid source chunk platform: ${String(manifest.platform)}`);
  validateRange(manifest.fromSlot, manifest.toSlot);
  if (!Number.isSafeInteger(manifest.recordCount) || manifest.recordCount < 0) throw new Error(`Invalid recordCount in ${manifest.chunkId}`);
  if (!Number.isSafeInteger(manifest.blockCount) || manifest.blockCount < 0) throw new Error(`Invalid blockCount in ${manifest.chunkId}`);
  if (manifest.compression !== SOURCE_CHUNK_COMPRESSION) throw new Error(`Unsupported source chunk compression: ${String(manifest.compression)}`);
  if (!/^[0-9a-f]{64}$/i.test(manifest.sha256)) throw new Error(`Invalid SHA-256 in ${manifest.chunkId}`);
  if (typeof manifest.dataFile !== 'string' || !manifest.dataFile.endsWith('.ndjson.gz')) throw new Error(`Invalid dataFile in ${manifest.chunkId}`);
}

function validateRange(fromSlot: number, toSlot: number): void {
  if (!Number.isSafeInteger(fromSlot) || fromSlot < 0) throw new Error('fromSlot must be a non-negative safe integer');
  if (!Number.isSafeInteger(toSlot) || toSlot < fromSlot) throw new Error('toSlot must be a safe integer greater than or equal to fromSlot');
}

function assertOrdered(
  records: ArchivedInstructionRecord[],
  fromSlot: number,
  toSlot: number,
): void {
  let previous: ArchivedInstructionRecord | undefined;
  for (const record of records) {
    if (record[0] < fromSlot || record[0] > toSlot) {
      throw new Error(`Source record slot ${record[0]} is outside chunk range ${fromSlot}-${toSlot}`);
    }
    if (previous && compareRecords(previous, record) > 0) {
      throw new Error(`Source records are not ordered at slot ${record[0]}`);
    }
    previous = record;
  }
}

function compareRecords(left: ArchivedInstructionRecord, right: ArchivedInstructionRecord): number {
  return left[0] - right[0]
    || left[3] - right[3]
    || compareArrays(left[4], right[4])
    || left[2].localeCompare(right[2]);
}

function compareArrays(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  for (let index = 0; index < size; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function safeUnlink(path: string): void {
  try {
    if (existsSync(path) && statSync(path).isFile()) unlinkSync(path);
  } catch {
    // Best-effort cleanup only.
  }
}
