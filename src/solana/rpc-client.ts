import { sleep } from '../utils/time';

export interface SolanaRpcClientOptions {
  url: string;
  commitment: 'processed' | 'confirmed' | 'finalized';
  requestRetries?: number;
  requestRetryMs?: number;
}

export interface SolanaRpcAccount {
  data: [string, string];
  executable: boolean;
  lamports: number;
  owner: string;
  rentEpoch: number;
  space?: number;
}

export interface KeyedSolanaRpcAccount {
  pubkey: string;
  account: SolanaRpcAccount;
}

export interface ProgramAccountFilter {
  memcmp?: {
    offset: number;
    bytes: string;
    encoding?: 'base58' | 'base64';
  };
  dataSize?: number;
}

export class SolanaRpcClient {
  private id = 0;

  constructor(private readonly options: SolanaRpcClientOptions) {}

  get url(): string {
    return this.options.url;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastError: unknown;
    const retries = this.options.requestRetries ?? 3;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(this.options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        });
        const body = await response.text();
        if (!response.ok) {
          throw new Error(`Solana RPC ${method} HTTP ${response.status}: ${body.slice(0, 500)}`);
        }
        const payload = JSON.parse(body) as {
          result?: T;
          error?: { code?: number; message?: string; data?: unknown };
        };
        if (payload.error) {
          throw new Error(
            `Solana RPC ${method} error ${payload.error.code ?? ''}: ${payload.error.message ?? JSON.stringify(payload.error)}`,
          );
        }
        return payload.result as T;
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await sleep((this.options.requestRetryMs ?? 250) * 2 ** attempt);
        }
      }
    }
    throw lastError;
  }

  async getProgramAccounts(
    programId: string,
    input: {
      filters?: ProgramAccountFilter[];
      dataSlice?: { offset: number; length: number };
    } = {},
  ): Promise<KeyedSolanaRpcAccount[]> {
    return this.call<KeyedSolanaRpcAccount[]>('getProgramAccounts', [
      programId,
      {
        commitment: this.options.commitment,
        encoding: 'base64',
        withContext: false,
        ...(input.filters ? { filters: input.filters } : {}),
        ...(input.dataSlice ? { dataSlice: input.dataSlice } : {}),
      },
    ]);
  }

  async getMultipleAccounts(
    addresses: string[],
    input: { dataSlice?: { offset: number; length: number } } = {},
  ): Promise<Array<SolanaRpcAccount | null>> {
    if (addresses.length === 0) return [];
    const output: Array<SolanaRpcAccount | null> = [];
    // Solana RPC providers commonly cap getMultipleAccounts at 100 addresses.
    for (let start = 0; start < addresses.length; start += 100) {
      const chunk = addresses.slice(start, start + 100);
      const result = await this.call<{ context: { slot: number }; value: Array<SolanaRpcAccount | null> }>(
        'getMultipleAccounts',
        [
          chunk,
          {
            commitment: this.options.commitment,
            encoding: 'base64',
            ...(input.dataSlice ? { dataSlice: input.dataSlice } : {}),
          },
        ],
      );
      output.push(...result.value);
    }
    return output;
  }
}

export function decodeRpcAccountData(account: SolanaRpcAccount): Uint8Array {
  const [data, encoding] = account.data;
  if (encoding !== 'base64') throw new Error(`Unsupported Solana account encoding: ${encoding}`);
  return Uint8Array.from(Buffer.from(data, 'base64'));
}
