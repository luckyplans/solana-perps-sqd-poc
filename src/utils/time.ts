export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isoDay(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${String(value)}`);
  return date.toISOString().slice(0, 10);
}

export function dateWindows(from: Date, to: Date, days: number): Array<{ from: Date; to: Date }> {
  if (from >= to) return [];
  const output: Array<{ from: Date; to: Date }> = [];
  let cursor = new Date(from);
  while (cursor < to) {
    const end = new Date(Math.min(to.getTime(), cursor.getTime() + days * 86_400_000));
    output.push({ from: new Date(cursor), to: end });
    cursor = end;
  }
  return output;
}
