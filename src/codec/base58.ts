const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map(Array.from(ALPHABET, (character, index) => [character, index]));

export function base58Decode(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array();
  const bytes: number[] = [0];
  for (const character of value) {
    const digit = INDEX.get(character);
    if (digit === undefined) throw new Error(`Invalid base58 character: ${character}`);
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      const current = bytes[index]! * 58 + carry;
      bytes[index] = current & 0xff;
      carry = current >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeroes = 0;
  while (zeroes < value.length - 1 && value[zeroes] === '1') zeroes += 1;
  const output = new Uint8Array(zeroes + bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    output[output.length - 1 - index] = bytes[index]!;
  }
  return output;
}

export function base58Encode(value: Uint8Array): string {
  if (value.length === 0) return '';
  const digits: number[] = [0];
  for (const byte of value) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const current = digits[index]! * 256 + carry;
      digits[index] = current % 58;
      carry = Math.floor(current / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let zeroes = 0;
  while (zeroes < value.length - 1 && value[zeroes] === 0) zeroes += 1;
  let output = '1'.repeat(zeroes);
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    output += ALPHABET[digits[index]!]!;
  }
  return output;
}
