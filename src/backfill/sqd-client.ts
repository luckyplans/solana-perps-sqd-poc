import { sleep } from '../utils/time';

export interface SqdClientOptions {
  portalUrl?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  requestIntervalMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  onRetry?: (details: {
    method: string;
    path: string;
    status?: number;
    attempt: number;
    maxRetries: number;
    waitMs: number;
    reason: string;
  }) => void;
}

export interface SqdBlockHeader {
  number: number;
  timestamp?: number | string;
  hash?: string;
}

export interface SqdTransaction {
  transactionIndex?: number;
  transaction_index?: number;
  index?: number;
  signatures?: string[] | string;
  signature?: string;
  err?: unknown;
}

export interface SqdInstruction {
  programId?: string;
  program_id?: string;
  data?: string;
  transactionIndex?: number;
  transaction_index?: number;
  instructionAddress?: number[];
  instruction_address?: number[];
  isCommitted?: boolean;
  is_committed?: boolean;
  error?: string | null;
}

export interface SqdBlock {
  header: SqdBlockHeader;
  transactions?: SqdTransaction[];
  instructions?: SqdInstruction[];
}

export interface SqdInstructionStreamInput {
  fromSlot: number;
  toSlot: number;
  programId: string;
  cpiDiscriminatorHex: string;
}

export class SqdPortalError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'SqdPortalError';
  }
}

export class SqdClient {
  private readonly portalUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly requestIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (milliseconds: number) => Promise<void>;
  private readonly onRetry?: SqdClientOptions['onRetry'];
  private lastRequestAt = 0;

  constructor(options: SqdClientOptions = {}) {
    this.portalUrl = (options.portalUrl ?? 'https://portal.sqd.dev/datasets/solana-mainnet')
      .replace(/\/+$/, '');
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 8;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 30_000;
    this.requestIntervalMs = options.requestIntervalMs ?? 650;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.onRetry = options.onRetry;
  }

  get url(): string {
    return this.portalUrl;
  }

  async metadata(): Promise<Record<string, unknown>> {
    const response = await this.request('/metadata', { method: 'GET' });
    return await response.json() as Record<string, unknown>;
  }

  async resolveTimestamp(value: Date): Promise<number> {
    if (Number.isNaN(value.getTime())) throw new Error('Invalid timestamp');
    const unixSeconds = Math.floor(value.getTime() / 1_000);
    const path = `/timestamps/${unixSeconds}/block`;
    const response = await this.request(path, { method: 'GET' });
    const body = await response.json() as { block_number?: unknown; blockNumber?: unknown };
    const slot = Number(body.block_number ?? body.blockNumber);
    if (!Number.isSafeInteger(slot) || slot < 0) {
      throw new SqdPortalError(
        `SQD returned an invalid block_number for ${value.toISOString()}`,
        response.status,
        path,
      );
    }
    return slot;
  }

  async *streamInstructions(input: SqdInstructionStreamInput): AsyncGenerator<SqdBlock> {
    validateSlot(input.fromSlot, 'fromSlot');
    validateSlot(input.toSlot, 'toSlot');
    if (input.fromSlot > input.toSlot) return;

    let currentFrom = input.fromSlot;
    const d8 = input.cpiDiscriminatorHex.startsWith('0x')
      ? input.cpiDiscriminatorHex
      : `0x${input.cpiDiscriminatorHex}`;

    while (currentFrom <= input.toSlot) {
      const path = '/finalized-stream';
      const response = await this.request(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/x-ndjson, application/json',
          'accept-encoding': 'gzip, br',
        },
        body: JSON.stringify({
          type: 'solana',
          fromBlock: currentFrom,
          toBlock: input.toSlot,
          fields: {
            block: { number: true, timestamp: true },
            transaction: { transactionIndex: true, signatures: true, err: true },
            instruction: {
              programId: true,
              data: true,
              transactionIndex: true,
              instructionAddress: true,
              isCommitted: true,
              error: true,
            },
          },
          instructions: [{
            programId: [input.programId],
            d8: [d8],
            isCommitted: true,
            transaction: true,
          }],
        }),
      });

      if (response.status === 204) return;

      let lastBlock = currentFrom - 1;
      let received = 0;
      for await (const block of readNdjson(response)) {
        const number = Number(block?.header?.number);
        if (!Number.isSafeInteger(number) || number < currentFrom) {
          throw new SqdPortalError(
            `SQD returned an invalid or non-monotonic block number: ${String(block?.header?.number)}`,
            response.status,
            path,
          );
        }
        if (number < lastBlock) {
          throw new SqdPortalError(
            `SQD returned blocks out of order: ${number} after ${lastBlock}`,
            response.status,
            path,
          );
        }
        lastBlock = number;
        received += 1;
        yield block;
      }

      // A successful bounded Portal request may legitimately return an empty
      // 200 response when every block in the remaining range was skipped by
      // the filters. In that case the request itself is the completion
      // boundary, even though there is no block header to advance from.
      if (received === 0) return;

      currentFrom = lastBlock + 1;
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    const method = init.method ?? 'GET';

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.pace();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(`${this.portalUrl}${path}`, {
          ...init,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok || response.status === 204) return response;

        const body = await response.text();
        const retryable = [429, 502, 503, 504].includes(response.status);
        if (!retryable || attempt >= this.maxRetries) {
          throw new SqdPortalError(
            `SQD Portal ${method} ${path} HTTP ${response.status}: ${body.slice(0, 1_000)}`,
            response.status,
            path,
          );
        }

        const waitMs = retryDelay(
          response.headers.get('retry-after'),
          response.status,
          attempt,
          this.retryBaseDelayMs,
          this.retryMaxDelayMs,
        );
        this.onRetry?.({
          method,
          path,
          status: response.status,
          attempt: attempt + 1,
          maxRetries: this.maxRetries,
          waitMs,
          reason: body.slice(0, 500) || response.statusText,
        });
        await this.sleepImpl(waitMs);
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof SqdPortalError) throw error;
        lastError = error;
        if (attempt >= this.maxRetries) break;
        const waitMs = Math.min(
          this.retryMaxDelayMs,
          this.retryBaseDelayMs * 2 ** attempt,
        );
        this.onRetry?.({
          method,
          path,
          attempt: attempt + 1,
          maxRetries: this.maxRetries,
          waitMs,
          reason: error instanceof Error ? error.message : String(error),
        });
        await this.sleepImpl(waitMs);
      }
    }

    throw new SqdPortalError(
      `SQD Portal ${method} ${path} failed after ${this.maxRetries + 1} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      undefined,
      path,
    );
  }

  private async pace(): Promise<void> {
    if (this.requestIntervalMs <= 0) return;
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.requestIntervalMs) {
      await this.sleepImpl(this.requestIntervalMs - elapsed);
    }
    this.lastRequestAt = Date.now();
  }
}

async function* readNdjson(response: Response): AsyncGenerator<SqdBlock> {
  if (!response.body) {
    const text = await response.text();
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) yield JSON.parse(trimmed) as SqdBlock;
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    while (true) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) yield JSON.parse(line) as SqdBlock;
    }
  }
  pending += decoder.decode();
  const tail = pending.trim();
  if (tail) yield JSON.parse(tail) as SqdBlock;
}

function retryDelay(
  retryAfter: string | null,
  status: number,
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(maxMs, Math.max(250, Math.ceil(seconds * 1_000)));
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.min(maxMs, Math.max(250, date - Date.now()));
    }
  }
  const exponential = baseMs * 2 ** attempt;
  // Public Portal 503 responses commonly mean that no worker is currently
  // available. Retrying after one second only adds pressure, so give worker
  // allocation failures a larger minimum cooldown while preserving bounded
  // exponential backoff.
  const minimum = status === 503 ? 5_000 : 0;
  return Math.min(maxMs, Math.max(minimum, exponential));
}

function validateSlot(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}
