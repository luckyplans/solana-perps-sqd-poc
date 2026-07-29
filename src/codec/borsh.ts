import { base58Encode } from './base58';

export class BorshReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get remaining(): number { return this.bytes.length - this.offset; }
  get position(): number { return this.offset; }

  readBytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      throw new Error(`Borsh buffer underflow at ${this.offset}; requested ${length}, remaining ${this.remaining}`);
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  skip(length: number): void { this.readBytes(length); }
  readU8(): number { return this.readBytes(1)[0]!; }
  readBool(): boolean {
    const value = this.readU8();
    if (value !== 0 && value !== 1) throw new Error(`Invalid Borsh bool: ${value}`);
    return value === 1;
  }
  readU16(): number { return Number(this.readUnsigned(2)); }
  readU32(): number { return Number(this.readUnsigned(4)); }
  readU64(): bigint { return this.readUnsigned(8); }
  readI64(): bigint { return this.readSigned(8); }
  readU128(): bigint { return this.readUnsigned(16); }
  readI128(): bigint { return this.readSigned(16); }
  readPubkey(): string { return base58Encode(this.readBytes(32)); }
  readOption<T>(reader: () => T): T | null {
    const tag = this.readU8();
    if (tag === 0) return null;
    if (tag !== 1) throw new Error(`Invalid Borsh option tag: ${tag}`);
    return reader();
  }
  private readUnsigned(length: number): bigint {
    const input = this.readBytes(length);
    let value = 0n;
    for (let index = input.length - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(input[index]!);
    return value;
  }
  private readSigned(length: number): bigint {
    const unsigned = this.readUnsigned(length);
    const bits = BigInt(length * 8);
    const sign = 1n << (bits - 1n);
    return unsigned & sign ? unsigned - (1n << bits) : unsigned;
  }
}

export class BorshWriter {
  private readonly values: number[] = [];
  writeBytes(bytes: Uint8Array): this { this.values.push(...bytes); return this; }
  writeU8(value: number): this { this.values.push(value & 0xff); return this; }
  writeBool(value: boolean): this { return this.writeU8(value ? 1 : 0); }
  writeU64(value: bigint): this { return this.writeUnsigned(value, 8); }
  writeI64(value: bigint): this { return this.writeSigned(value, 8); }
  writeU128(value: bigint): this { return this.writeUnsigned(value, 16); }
  writeI128(value: bigint): this { return this.writeSigned(value, 16); }
  writePubkey(bytes: Uint8Array): this {
    if (bytes.length !== 32) throw new Error('Pubkey must contain 32 bytes');
    return this.writeBytes(bytes);
  }
  writeOption<T>(value: T | null, writer: (value: T) => void): this {
    this.writeU8(value === null ? 0 : 1);
    if (value !== null) writer(value);
    return this;
  }
  toUint8Array(): Uint8Array { return Uint8Array.from(this.values); }
  private writeUnsigned(value: bigint, length: number): this {
    if (value < 0n) throw new Error('Unsigned Borsh value cannot be negative');
    let remaining = value;
    for (let index = 0; index < length; index += 1) {
      this.values.push(Number(remaining & 0xffn));
      remaining >>= 8n;
    }
    if (remaining !== 0n) throw new Error(`Borsh integer does not fit in ${length} bytes`);
    return this;
  }
  private writeSigned(value: bigint, length: number): this {
    const bits = BigInt(length * 8);
    return this.writeUnsigned(value < 0n ? (1n << bits) + value : value, length);
  }
}
