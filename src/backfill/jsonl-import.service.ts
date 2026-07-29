import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { base58Decode } from '../codec/base58';
import { hexToBytes } from '../codec/hex';
import { IngestionSource, Platform } from '../domain/enums';
import { SourceInstruction } from '../domain/models';
import { PlatformAdapterRegistry } from '../platforms/registry';
import { IngestionService } from '../services/ingestion.service';
import { duneRowToInstruction } from './dune-row';

export class JsonlImportService {
  constructor(private readonly adapters: PlatformAdapterRegistry,private readonly ingestion: IngestionService) {}
  async run(platform: Platform, path: string): Promise<Record<string, number>> {
    const adapter = this.adapters.get(platform);
    const counts = { lines: 0,inserted: 0,duplicate: 0,unsupported: 0,ignored: 0,failed: 0 };
    const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }),crlfDelay: Infinity });
    for await (const line of reader) {
      const trimmed = String(line).trim(); if (!trimmed) continue; counts.lines += 1;
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      let instruction: SourceInstruction;
      if (row.data_hex !== undefined) instruction = { ...duneRowToInstruction(platform, adapter.programId, row),ingestionSource: IngestionSource.JSONL };
      else instruction = {
        platform,programId: adapter.programId,ingestionSource: IngestionSource.JSONL,signature: String(row.signature),
        slot: Number(row.slot),blockTime: new Date(String(row.block_time)),outerInstructionIndex: Number(row.outer_instruction_index),
        innerInstructionIndex: Number(row.inner_instruction_index ?? 0),data: row.instruction_data ? base58Decode(String(row.instruction_data)) : hexToBytes(String(row.data)),
      };
      const result = await this.ingestion.processInstruction(instruction); counts[result.status] += 1;
    }
    return counts;
  }
}
