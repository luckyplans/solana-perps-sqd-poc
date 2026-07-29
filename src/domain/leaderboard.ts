import { Platform } from './enums';

export interface DailyLeaderboardRow {
  platform: Platform; address: string; dateStr: string;
  grossPnlE6: bigint; feesPaidE6: bigint; netPnlE6: bigint; volumeE6: bigint;
  actionCount: number; realizedActionCount: number; winningActionCount: number; losingActionCount: number;
  liquidationCount: number; firstEventAt: string; lastEventAt: string;
}

export interface LeaderboardQuery {
  platform?: Platform; from?: string; to?: string; limit?: number; offset?: number;
  minActions?: number; sortBy?: 'netPnl' | 'volume' | 'winRate';
}

export interface LeaderboardEntry {
  rank: number; platform: Platform; address: string;
  grossPnlUsd: number; feesPaidUsd: number; netPnlUsd: number; volumeUsd: number;
  actionCount: number; realizedActionCount: number; winningActionCount: number; losingActionCount: number;
  winRate: number; liquidationCount: number; maxDrawdownUsd: number;
  firstEventAt: string | null; lastEventAt: string | null;
}
