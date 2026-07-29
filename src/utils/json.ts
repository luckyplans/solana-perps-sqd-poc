export function jsonStringify(value: unknown, spacing?: number): string {
  return JSON.stringify(value, (_key, current) => typeof current === 'bigint' ? current.toString() : current, spacing);
}

export function toJsonSafe<T = unknown>(value: unknown): T {
  return JSON.parse(jsonStringify(value)) as T;
}
