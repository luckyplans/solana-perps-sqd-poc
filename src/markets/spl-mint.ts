export function decodeSplMintDecimals(data: Uint8Array): number {
  // SPL Token and Token-2022 mint base layout both place decimals at byte 44.
  if (data.length < 45) throw new Error(`SPL mint account has only ${data.length} bytes`);
  return data[44] ?? 0;
}
