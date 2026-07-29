declare module 'node:assert/strict' { const value: any; export = value; }
declare module 'node:crypto' { export function createHash(name: string): any; export function randomUUID(): string; }
declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding?: string): any;
  export function writeFileSync(path: string, data: any): void;
  export function appendFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: any): void;
  export function createReadStream(path: string, options?: any): any;
  export function unlinkSync(path: string): void;
  export function copyFileSync(source: string, destination: string): void;
  export function renameSync(source: string, destination: string): void;
}
declare module 'node:path' {
  export function resolve(...parts: string[]): string;
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
}
declare module 'node:child_process' { export function spawn(command: string, args?: string[], options?: any): any; }
declare module 'node:http' { export function createServer(handler: (request: any, response: any) => void | Promise<void>): any; }
declare module 'node:url' { export class URL { constructor(input: string, base?: string); pathname: string; searchParams: any; } }
declare module 'node:readline' { export function createInterface(options: any): any; }
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): any;
    close(): void;
  }
}
declare module 'node:test' { const value: any; export = value; }
declare const process: any;
declare const Buffer: any;
declare const require: any;
declare const module: any;

declare const __dirname: string;
