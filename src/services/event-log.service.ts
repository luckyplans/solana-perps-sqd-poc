import { Platform, PerpTradeHistoryOperation } from '../domain/enums';
import { EventLogView } from '../domain/models';
import { SqliteStore } from '../storage/sqlite-store';

export class EventLogService {
  constructor(private readonly store: SqliteStore) {}
  findAll(input: { platform?: Platform;address?: string;positionKey?: string;operation?: PerpTradeHistoryOperation;from?: string;to?: string;limit?: number;offset?: number;order?: 'asc' | 'desc' } = {}): EventLogView[] {
    return this.store.findEventLogs(input);
  }
  findByAddress(address: string, input: { platform?: Platform;from?: string;to?: string;limit?: number;offset?: number } = {}): EventLogView[] {
    return this.store.findEventLogs({ ...input,address });
  }
  findPosition(platform: Platform, positionKey: string, limit = 10_000): EventLogView[] {
    return this.store.findEventLogs({ platform,positionKey,limit,order: 'asc' });
  }
  stats(): Record<string, number> { return this.store.getStats(); }
  unknownMarkets(): Record<string, unknown>[] { return this.store.listUnknownMarkets(); }
}
