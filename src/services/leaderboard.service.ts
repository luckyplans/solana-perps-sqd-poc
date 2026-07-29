import { DailyLeaderboardRow, LeaderboardEntry, LeaderboardQuery } from '../domain/leaderboard';
import { PerpTradeHistoryOperation, Platform } from '../domain/enums';
import { fixed6ToNumber } from '../domain/fixed';
import { EventLogView } from '../domain/models';
import { SqliteStore } from '../storage/sqlite-store';

interface Aggregate {
  platform: Platform;address: string;grossPnlE6: bigint;feesPaidE6: bigint;netPnlE6: bigint;volumeE6: bigint;
  actionCount: number;realizedActionCount: number;winningActionCount: number;losingActionCount: number;liquidationCount: number;
  firstEventAt: string | null;lastEventAt: string | null;dailyPnl: Array<{ date: string;netPnlE6: bigint }>;
}

export class LeaderboardService {
  constructor(private readonly store: SqliteStore) {}

  rebuild(platform?: Platform): number {
    const days = this.store.listEventDays(platform);
    for (const day of days) {
      const events = this.store.findEventLogsByDay(day.platform, day.dateStr);
      this.store.replaceDailyRows(day.platform, day.dateStr, buildDaily(events, day.platform, day.dateStr));
    }
    return days.length;
  }

  list(query: LeaderboardQuery = {}): LeaderboardEntry[] {
    const rows = this.store.findDailyRows({ platform: query.platform,from: query.from,to: query.to });
    const grouped = new Map<string, Aggregate>();
    for (const row of rows) {
      const key = `${row.platform}:${row.address}`;
      const value = grouped.get(key) ?? {
        platform: row.platform,address: row.address,grossPnlE6: 0n,feesPaidE6: 0n,netPnlE6: 0n,volumeE6: 0n,
        actionCount: 0,realizedActionCount: 0,winningActionCount: 0,losingActionCount: 0,liquidationCount: 0,
        firstEventAt: null,lastEventAt: null,dailyPnl: [],
      };
      value.grossPnlE6 += row.grossPnlE6; value.feesPaidE6 += row.feesPaidE6; value.netPnlE6 += row.netPnlE6; value.volumeE6 += row.volumeE6;
      value.actionCount += row.actionCount; value.realizedActionCount += row.realizedActionCount; value.winningActionCount += row.winningActionCount;
      value.losingActionCount += row.losingActionCount; value.liquidationCount += row.liquidationCount;
      if (!value.firstEventAt || row.firstEventAt < value.firstEventAt) value.firstEventAt = row.firstEventAt;
      if (!value.lastEventAt || row.lastEventAt > value.lastEventAt) value.lastEventAt = row.lastEventAt;
      value.dailyPnl.push({ date: row.dateStr,netPnlE6: row.netPnlE6 }); grouped.set(key, value);
    }
    const entries = [...grouped.values()].filter((value) => value.actionCount >= Math.max(0, query.minActions ?? 1)).map((value): LeaderboardEntry => ({
      rank: 0,platform: value.platform,address: value.address,grossPnlUsd: fixed6ToNumber(value.grossPnlE6),
      feesPaidUsd: fixed6ToNumber(value.feesPaidE6),netPnlUsd: fixed6ToNumber(value.netPnlE6),volumeUsd: fixed6ToNumber(value.volumeE6),
      actionCount: value.actionCount,realizedActionCount: value.realizedActionCount,winningActionCount: value.winningActionCount,
      losingActionCount: value.losingActionCount,winRate: value.realizedActionCount ? value.winningActionCount / value.realizedActionCount : 0,
      liquidationCount: value.liquidationCount,maxDrawdownUsd: fixed6ToNumber(maxDrawdownE6(value.dailyPnl)),
      firstEventAt: value.firstEventAt,lastEventAt: value.lastEventAt,
    }));
    const sortBy = query.sortBy ?? 'netPnl';
    entries.sort((left, right) => sortBy === 'volume' ? right.volumeUsd - left.volumeUsd : sortBy === 'winRate' ? right.winRate - left.winRate || right.netPnlUsd - left.netPnlUsd : right.netPnlUsd - left.netPnlUsd);
    entries.forEach((entry, index) => { entry.rank = index + 1; });
    const offset = Math.max(0, query.offset ?? 0); const limit = Math.max(1, Math.min(10_000, query.limit ?? 100));
    return entries.slice(offset, offset + limit);
  }
}

function buildDaily(events: EventLogView[], platform: Platform, dateStr: string): DailyLeaderboardRow[] {
  const grouped = new Map<string, DailyLeaderboardRow>();
  for (const event of events) {
    const row = grouped.get(event.address) ?? {
      platform,address: event.address,dateStr,grossPnlE6: 0n,feesPaidE6: 0n,netPnlE6: 0n,volumeE6: 0n,
      actionCount: 0,realizedActionCount: 0,winningActionCount: 0,losingActionCount: 0,liquidationCount: 0,
      firstEventAt: event.date,lastEventAt: event.date,
    };
    const base = BigInt(event.fixed.usdBasePnlE6!); const fee = BigInt(event.fixed.usdFeeE6!); const net = BigInt(event.fixed.usdPnlE6!);
    row.grossPnlE6 += base; row.feesPaidE6 += fee < 0n ? -fee : 0n; row.netPnlE6 += net; row.volumeE6 += BigInt(event.fixed.sizeDeltaUsdE6!);
    row.actionCount += 1; row.liquidationCount += event.liquidation ? 1 : 0;
    const realized = event.operation === PerpTradeHistoryOperation.CLOSE || event.operation === PerpTradeHistoryOperation.DECREASE_SIZE || base !== 0n;
    if (realized) { row.realizedActionCount += 1; if (net > 0n) row.winningActionCount += 1; else if (net < 0n) row.losingActionCount += 1; }
    if (event.date < row.firstEventAt) row.firstEventAt = event.date; if (event.date > row.lastEventAt) row.lastEventAt = event.date;
    grouped.set(event.address, row);
  }
  return [...grouped.values()];
}

function maxDrawdownE6(values: Array<{ date: string;netPnlE6: bigint }>): bigint {
  let running = 0n; let peak = 0n; let maximum = 0n;
  for (const value of [...values].sort((left, right) => left.date.localeCompare(right.date))) {
    running += value.netPnlE6; if (running > peak) peak = running; if (peak - running > maximum) maximum = peak - running;
  }
  return maximum;
}
