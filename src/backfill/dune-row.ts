import { hexToBytes } from '../codec/hex';
import { IngestionSource, Platform } from '../domain/enums';
import { SourceInstruction } from '../domain/models';

const DUNE_SQL_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2}))?$/i;

/** Legacy helper retained only for importing previously downloaded Dune JSONL. */
export function parseDuneDate(value: unknown): Date {
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    if (!Number.isNaN(copy.getTime())) return copy;
  }
  if (typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const text = String(value ?? '').trim();
  if (!text) throw new Error('Invalid Dune block_time: empty value');
  const match = DUNE_SQL_TIMESTAMP.exec(text);
  let normalized = text;
  if (match) {
    const [, datePart, timePart, fraction = '', rawZone] = match;
    const milliseconds = fraction ? `.${fraction.padEnd(3, '0').slice(0, 3)}` : '';
    let zone = 'Z';
    if (rawZone && !/^(?:UTC|GMT|Z)$/i.test(rawZone)) {
      zone = /^[+-]\d{4}$/.test(rawZone)
        ? `${rawZone.slice(0, 3)}:${rawZone.slice(3)}`
        : rawZone;
    }
    normalized = `${datePart}T${timePart}${milliseconds}${zone}`;
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid Dune block_time: ${text}`);
  return date;
}

export function duneRowToInstruction(
  platform: Platform,
  programId: string,
  row: Record<string, unknown>,
): SourceInstruction {
  return {
    platform,
    programId,
    ingestionSource: IngestionSource.DUNE,
    signature: String(row.signature),
    slot: integer(row.slot, 'slot'),
    blockTime: parseDuneDate(row.block_time),
    outerInstructionIndex: integer(row.outer_instruction_index, 'outer_instruction_index'),
    innerInstructionIndex: integer(row.inner_instruction_index ?? 0, 'inner_instruction_index'),
    data: hexToBytes(String(row.data_hex).replace(/^0x/, '')),
  };
}

function integer(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isInteger(result)) throw new Error(`Invalid Dune ${name}: ${String(value)}`);
  return result;
}
