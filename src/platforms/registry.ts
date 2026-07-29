import { Platform } from '../domain/enums';
import { PerpPlatformAdapter } from '../domain/platform-adapter';
import { GmTradeAdapter } from './gmtrade/adapter';
import { JupiterAdapter } from './jupiter/adapter';

export class PlatformAdapterRegistry {
  private readonly adapters = new Map<Platform, PerpPlatformAdapter>();
  constructor(adapters: PerpPlatformAdapter[] = [new GmTradeAdapter(), new JupiterAdapter()]) {
    for (const adapter of adapters) this.adapters.set(adapter.platform, adapter);
  }
  get(platform: Platform): PerpPlatformAdapter { const adapter = this.adapters.get(platform); if (!adapter) throw new Error(`No adapter registered for ${platform}`); return adapter; }
  list(): PerpPlatformAdapter[] { return [...this.adapters.values()]; }
  all(): PerpPlatformAdapter[] { return this.list(); }
  byProgramId(programId: string): PerpPlatformAdapter | null { return this.list().find((adapter) => adapter.programId === programId) ?? null; }
  forProgram(programId: string): PerpPlatformAdapter | null { return this.byProgramId(programId); }
}
