import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Platform } from '../domain/enums';

export interface ParquetExportInput {
  platform?: Platform;
  from?: Date;
  to?: Date;
  outputDir?: string;
  overwrite?: boolean;
}

export class ParquetExportService {
  constructor(
    private readonly databasePath: string,
    private readonly defaultOutputDir: string,
    private readonly pythonCommand: string,
    private readonly batchSize: number,
  ) {}

  async run(input: ParquetExportInput = {}): Promise<Record<string, unknown>> {
    const script = resolve(__dirname, '../../scripts/export_parquet.py');
    const args = [
      script,
      '--database',
      this.databasePath,
      '--output',
      resolve(input.outputDir ?? this.defaultOutputDir),
      '--batch-size',
      String(this.batchSize),
    ];
    if (input.platform) args.push('--platform', input.platform);
    if (input.from) args.push('--from', input.from.toISOString());
    if (input.to) args.push('--to', input.to.toISOString());
    if (input.overwrite) args.push('--overwrite');

    const { stdout, stderr, code } = await runProcess(this.pythonCommand, args);
    if (code !== 0) {
      throw new Error(
        `Parquet export failed with exit code ${code}: ${(stderr || stdout).trim()}`,
      );
    }
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!line) throw new Error('Parquet exporter did not return a result');
    return JSON.parse(line) as Record<string, unknown>;
  }
}

function runProcess(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: unknown) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk: unknown) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code: number | null) => {
      resolvePromise({ stdout, stderr, code: code ?? 1 });
    });
  });
}
