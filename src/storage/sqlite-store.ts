import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DailyLeaderboardRow } from '../domain/leaderboard';
import { DataQuality, IngestionSource, PerpCloseReason, PerpTradeHistoryOperation, Platform } from '../domain/enums';
import { EventLogView, NormalizedPerpEvent, PositionState, toLuckyPlansPurePerpTradeHistory } from '../domain/models';
import { jsonStringify } from '../utils/json';

export interface EventLogQuery {
  platform?: Platform; address?: string; positionKey?: string; from?: string; to?: string;
  operation?: PerpTradeHistoryOperation; limit?: number; offset?: number; order?: 'asc' | 'desc';
}

export class SqliteStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }
  close(): void { this.db.close(); }

  insertEventAndState(event: NormalizedPerpEvent, state: PositionState | null): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const h = event.history;
      const s = event.source;
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO event_logs (
          platform,program_id,ingestion_source,signature,slot,block_time,
          outer_instruction_index,inner_instruction_index,event_name,event_discriminator,
          order_key,request_key,position_key,address,pair,market_address,collateral_address,
          operation,close_reason,data_quality,usd_pnl_e6,usd_base_pnl_e6,usd_fee_e6,
          size_in_usd_e6,leverage_e6,collateral_in_usd_e6,collateral_delta_usd_e6,
          size_delta_usd_e6,leverage_delta_e6,is_long,price_e6,collateral_usd_price_e6,
          liquidation,decoded_event_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        s.platform,s.programId,s.ingestionSource,s.signature,s.slot,s.blockTime.toISOString(),
        s.outerInstructionIndex,s.innerInstructionIndex,s.eventName,s.eventDiscriminatorHex,
        s.orderKey,s.requestKey,h.positionKey,h.address,h.pair,h.marketAddress,h.collateralAddress,
        h.operation,h.closeReason,h.dataQuality,h.usdPnlE6.toString(),h.usdBasePnlE6.toString(),h.usdFeeE6.toString(),
        h.sizeInUsdE6.toString(),h.leverageE6.toString(),h.collateralInUsdE6.toString(),h.collateralDeltaUsdE6.toString(),
        h.sizeDeltaUsdE6.toString(),h.leverageDeltaE6.toString(),h.isLong ? 1 : 0,h.priceE6.toString(),
        h.collateralUsdPriceE6.toString(),h.liquidation ? 1 : 0,jsonStringify(event.decodedEvent),
      );
      const inserted = Number(result.changes ?? 0) > 0;
      if (inserted) {
        if (state) this.upsertPositionState(state);
        this.applyEventToDailyLeaderboard(event);
      }
      this.db.exec('COMMIT');
      return inserted;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getPositionState(platform: Platform, positionKey: string): PositionState | null {
    const row = this.db.prepare('SELECT * FROM position_states WHERE platform=? AND position_key=?').get(platform, positionKey) as any;
    return row ? rowToPosition(row) : null;
  }

  findEventLogs(query: EventLogQuery = {}): EventLogView[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.platform) { conditions.push('platform=?'); params.push(query.platform); }
    if (query.address) { conditions.push('address=?'); params.push(query.address); }
    if (query.positionKey) { conditions.push('position_key=?'); params.push(query.positionKey); }
    if (query.operation) { conditions.push('operation=?'); params.push(query.operation); }
    if (query.from) { conditions.push('block_time>=?'); params.push(new Date(query.from).toISOString()); }
    if (query.to) { conditions.push('block_time<?'); params.push(new Date(query.to).toISOString()); }
    const limit = Math.max(1, Math.min(query.limit ?? 100, 10_000));
    const offset = Math.max(0, query.offset ?? 0);
    const order = query.order === 'desc' ? 'DESC' : 'ASC';
    const rows = this.db.prepare(`
      SELECT * FROM event_logs ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY block_time ${order},slot ${order},outer_instruction_index ${order},inner_instruction_index ${order}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];
    return rows.map(rowToEventView);
  }

  findEventLogsByDay(platform: Platform, dateStr: string): EventLogView[] {
    const rows = this.db.prepare(`SELECT * FROM event_logs WHERE platform=? AND substr(block_time,1,10)=? ORDER BY block_time,slot,outer_instruction_index,inner_instruction_index`).all(platform, dateStr) as any[];
    return rows.map(rowToEventView);
  }

  listEventDays(platform?: Platform): Array<{ platform: Platform; dateStr: string }> {
    const rows = platform
      ? this.db.prepare('SELECT DISTINCT platform,substr(block_time,1,10) date_str FROM event_logs WHERE platform=? ORDER BY date_str').all(platform)
      : this.db.prepare('SELECT DISTINCT platform,substr(block_time,1,10) date_str FROM event_logs ORDER BY platform,date_str').all();
    return (rows as any[]).map((row) => ({ platform: row.platform as Platform, dateStr: row.date_str }));
  }

  replaceDailyRows(platform: Platform, dateStr: string, rows: DailyLeaderboardRow[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM leaderboard_daily WHERE platform=? AND date_str=?').run(platform, dateStr);
      const statement = this.db.prepare(`
        INSERT INTO leaderboard_daily (
          platform,address,date_str,gross_pnl_e6,fees_paid_e6,net_pnl_e6,volume_e6,
          action_count,realized_action_count,winning_action_count,losing_action_count,
          liquidation_count,first_event_at,last_event_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const row of rows) statement.run(
        row.platform,row.address,row.dateStr,row.grossPnlE6.toString(),row.feesPaidE6.toString(),
        row.netPnlE6.toString(),row.volumeE6.toString(),row.actionCount,row.realizedActionCount,
        row.winningActionCount,row.losingActionCount,row.liquidationCount,row.firstEventAt,row.lastEventAt,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  findDailyRows(params: { platform?: Platform; from?: string; to?: string } = {}): DailyLeaderboardRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params.platform) { conditions.push('platform=?'); values.push(params.platform); }
    if (params.from) { conditions.push('date_str>=?'); values.push(params.from.slice(0, 10)); }
    if (params.to) { conditions.push('date_str<=?'); values.push(params.to.slice(0, 10)); }
    const rows = this.db.prepare(`SELECT * FROM leaderboard_daily ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY date_str,address`).all(...values) as any[];
    return rows.map(rowToDaily);
  }

  getCursor(key: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT value_json FROM ingestion_cursors WHERE key=?').get(key) as any;
    return row ? JSON.parse(row.value_json) as Record<string, unknown> : null;
  }
  setCursor(key: string, value: Record<string, unknown>): void {
    this.db.prepare(`INSERT INTO ingestion_cursors(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(key,jsonStringify(value),new Date().toISOString());
  }

  createBackfillJob(job: { id: string; platform: Platform; provider: string; parameters: Record<string, unknown> }): void {
    this.db.prepare(`INSERT INTO backfill_jobs(id,platform,provider,status,parameters_json,seen,decoded,inserted,skipped,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(job.id,job.platform,job.provider,'running',jsonStringify(job.parameters),0,0,0,0,new Date().toISOString());
  }
  updateBackfillJob(id: string, patch: Record<string, unknown>): void {
    const current = this.getBackfillJob(id);
    if (!current) throw new Error(`Unknown backfill job ${id}`);
    const next = { ...current, ...patch } as any;
    this.db.prepare(`UPDATE backfill_jobs SET status=?,seen=?,decoded=?,inserted=?,skipped=?,error=?,completed_at=? WHERE id=?`).run(
      next.status ?? 'running',next.seen ?? 0,next.decoded ?? 0,next.inserted ?? 0,next.skipped ?? 0,
      next.error ?? null,next.completedAt ?? null,id,
    );
  }
  getBackfillJob(id: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT * FROM backfill_jobs WHERE id=?').get(id) as any;
    if (!row) return null;
    return { id: row.id,platform: row.platform,provider: row.provider,status: row.status,parameters: JSON.parse(row.parameters_json),seen: row.seen,decoded: row.decoded,inserted: row.inserted,skipped: row.skipped,error: row.error,createdAt: row.created_at,completedAt: row.completed_at };
  }
  listBackfillJobs(limit = 50): Record<string, unknown>[] {
    const rows = this.db.prepare('SELECT id FROM backfill_jobs ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(limit, 500))) as any[];
    return rows.map((row) => this.getBackfillJob(row.id)!).filter(Boolean);
  }

  listUnknownMarkets(): Record<string, unknown>[] {
    const rows = this.db.prepare(`
      SELECT platform,market_address,collateral_address,pair,count(*) event_count,
        min(block_time) first_seen_at,max(block_time) last_seen_at
      FROM event_logs WHERE data_quality='partialMarket'
      GROUP BY platform,market_address,collateral_address,pair
      ORDER BY event_count DESC
    `).all() as any[];
    return rows.map((row) => ({
      platform: row.platform, marketAddress: row.market_address, collateralAddress: row.collateral_address ?? null,
      pair: row.pair, eventCount: Number(row.event_count), firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
    }));
  }

  getStats(): Record<string, number> {
    const count = (table: string): number => Number((this.db.prepare(`SELECT count(*) count FROM ${table}`).get() as any).count);
    return { events: count('event_logs'),positions: count('position_states'),dailyLeaderboardRows: count('leaderboard_daily'),backfillJobs: count('backfill_jobs') };
  }

  private upsertPositionState(state: PositionState): void {
    this.db.prepare(`
      INSERT INTO position_states (
        platform,position_key,address,market_address,collateral_address,pair,is_long,
        size_in_usd_e6,collateral_in_usd_e6,leverage_e6,last_price_e6,opened_at,
        closed,last_slot,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(platform,position_key) DO UPDATE SET
        address=excluded.address,market_address=excluded.market_address,collateral_address=excluded.collateral_address,
        pair=excluded.pair,is_long=excluded.is_long,size_in_usd_e6=excluded.size_in_usd_e6,
        collateral_in_usd_e6=excluded.collateral_in_usd_e6,leverage_e6=excluded.leverage_e6,
        last_price_e6=excluded.last_price_e6,opened_at=COALESCE(position_states.opened_at,excluded.opened_at),
        closed=excluded.closed,last_slot=excluded.last_slot,updated_at=excluded.updated_at
      WHERE excluded.last_slot > position_states.last_slot
         OR (excluded.last_slot = position_states.last_slot AND excluded.updated_at >= position_states.updated_at)
    `).run(
      state.platform,state.positionKey,state.address,state.marketAddress,state.collateralAddress,state.pair,state.isLong ? 1 : 0,
      state.sizeInUsdE6.toString(),state.collateralInUsdE6.toString(),state.leverageE6.toString(),state.lastPriceE6.toString(),
      state.openedAt?.toISOString() ?? null,state.closed ? 1 : 0,state.lastSlot,state.updatedAt.toISOString(),
    );
  }

  private applyEventToDailyLeaderboard(event: NormalizedPerpEvent): void {
    const history = event.history;
    const dateStr = event.source.blockTime.toISOString().slice(0, 10);
    const existing = this.db.prepare(
      'SELECT * FROM leaderboard_daily WHERE platform=? AND address=? AND date_str=?',
    ).get(event.source.platform, history.address, dateStr) as any;
    const paidFeeE6 = history.usdFeeE6 < 0n ? -history.usdFeeE6 : 0n;
    const realized = history.operation === PerpTradeHistoryOperation.CLOSE
      || history.operation === PerpTradeHistoryOperation.DECREASE_SIZE
      || history.usdBasePnlE6 !== 0n;
    const winning = realized && history.usdPnlE6 > 0n ? 1 : 0;
    const losing = realized && history.usdPnlE6 < 0n ? 1 : 0;
    const timestamp = event.source.blockTime.toISOString();

    if (!existing) {
      this.db.prepare(`
        INSERT INTO leaderboard_daily (
          platform,address,date_str,gross_pnl_e6,fees_paid_e6,net_pnl_e6,volume_e6,
          action_count,realized_action_count,winning_action_count,losing_action_count,
          liquidation_count,first_event_at,last_event_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        event.source.platform,history.address,dateStr,history.usdBasePnlE6.toString(),paidFeeE6.toString(),
        history.usdPnlE6.toString(),history.sizeDeltaUsdE6.toString(),1,realized ? 1 : 0,winning,losing,
        history.liquidation ? 1 : 0,timestamp,timestamp,
      );
      return;
    }

    this.db.prepare(`
      UPDATE leaderboard_daily SET
        gross_pnl_e6=?,fees_paid_e6=?,net_pnl_e6=?,volume_e6=?,action_count=?,
        realized_action_count=?,winning_action_count=?,losing_action_count=?,liquidation_count=?,
        first_event_at=?,last_event_at=?
      WHERE platform=? AND address=? AND date_str=?
    `).run(
      (BigInt(existing.gross_pnl_e6) + history.usdBasePnlE6).toString(),
      (BigInt(existing.fees_paid_e6) + paidFeeE6).toString(),
      (BigInt(existing.net_pnl_e6) + history.usdPnlE6).toString(),
      (BigInt(existing.volume_e6) + history.sizeDeltaUsdE6).toString(),
      Number(existing.action_count) + 1,
      Number(existing.realized_action_count) + (realized ? 1 : 0),
      Number(existing.winning_action_count) + winning,
      Number(existing.losing_action_count) + losing,
      Number(existing.liquidation_count) + (history.liquidation ? 1 : 0),
      timestamp < String(existing.first_event_at) ? timestamp : existing.first_event_at,
      timestamp > String(existing.last_event_at) ? timestamp : existing.last_event_at,
      event.source.platform,history.address,dateStr,
    );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,program_id TEXT NOT NULL,ingestion_source TEXT NOT NULL,
        signature TEXT NOT NULL,slot INTEGER NOT NULL,block_time TEXT NOT NULL,
        outer_instruction_index INTEGER NOT NULL,inner_instruction_index INTEGER NOT NULL,
        event_name TEXT NOT NULL,event_discriminator TEXT NOT NULL,order_key TEXT,request_key TEXT,
        position_key TEXT NOT NULL,address TEXT NOT NULL,pair TEXT NOT NULL,market_address TEXT NOT NULL,
        collateral_address TEXT,operation TEXT NOT NULL,close_reason TEXT,data_quality TEXT NOT NULL,
        usd_pnl_e6 TEXT NOT NULL,usd_base_pnl_e6 TEXT NOT NULL,usd_fee_e6 TEXT NOT NULL,
        size_in_usd_e6 TEXT NOT NULL,leverage_e6 TEXT NOT NULL,collateral_in_usd_e6 TEXT NOT NULL,
        collateral_delta_usd_e6 TEXT NOT NULL,size_delta_usd_e6 TEXT NOT NULL,leverage_delta_e6 TEXT NOT NULL,
        is_long INTEGER NOT NULL,price_e6 TEXT NOT NULL,collateral_usd_price_e6 TEXT NOT NULL,
        liquidation INTEGER NOT NULL,decoded_event_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(platform,signature,outer_instruction_index,inner_instruction_index,event_discriminator)
      );
      CREATE INDEX IF NOT EXISTS event_logs_trader_idx ON event_logs(platform,address,block_time,slot);
      CREATE INDEX IF NOT EXISTS event_logs_position_idx ON event_logs(platform,position_key,block_time,slot);
      CREATE INDEX IF NOT EXISTS event_logs_day_idx ON event_logs(platform,block_time);
      CREATE TABLE IF NOT EXISTS position_states (
        platform TEXT NOT NULL,position_key TEXT NOT NULL,address TEXT NOT NULL,market_address TEXT NOT NULL,
        collateral_address TEXT,pair TEXT NOT NULL,is_long INTEGER NOT NULL,size_in_usd_e6 TEXT NOT NULL,
        collateral_in_usd_e6 TEXT NOT NULL,leverage_e6 TEXT NOT NULL,last_price_e6 TEXT NOT NULL,
        opened_at TEXT,closed INTEGER NOT NULL,last_slot INTEGER NOT NULL,updated_at TEXT NOT NULL,
        PRIMARY KEY(platform,position_key)
      );
      CREATE TABLE IF NOT EXISTS leaderboard_daily (
        platform TEXT NOT NULL,address TEXT NOT NULL,date_str TEXT NOT NULL,gross_pnl_e6 TEXT NOT NULL,
        fees_paid_e6 TEXT NOT NULL,net_pnl_e6 TEXT NOT NULL,volume_e6 TEXT NOT NULL,
        action_count INTEGER NOT NULL,realized_action_count INTEGER NOT NULL,winning_action_count INTEGER NOT NULL,
        losing_action_count INTEGER NOT NULL,liquidation_count INTEGER NOT NULL,first_event_at TEXT NOT NULL,last_event_at TEXT NOT NULL,
        PRIMARY KEY(platform,address,date_str)
      );
      CREATE INDEX IF NOT EXISTS leaderboard_daily_period_idx ON leaderboard_daily(platform,date_str,address);
      CREATE TABLE IF NOT EXISTS ingestion_cursors (key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backfill_jobs (
        id TEXT PRIMARY KEY,platform TEXT NOT NULL,provider TEXT NOT NULL,status TEXT NOT NULL,parameters_json TEXT NOT NULL,
        seen INTEGER NOT NULL,decoded INTEGER NOT NULL,inserted INTEGER NOT NULL,skipped INTEGER NOT NULL,
        error TEXT,created_at TEXT NOT NULL,completed_at TEXT
      );
    `);
  }
}

function rowToPosition(row: any): PositionState {
  return {
    platform: row.platform as Platform,positionKey: row.position_key,address: row.address,marketAddress: row.market_address,
    collateralAddress: row.collateral_address ?? null,pair: row.pair,isLong: Boolean(row.is_long),
    sizeInUsdE6: BigInt(row.size_in_usd_e6),collateralInUsdE6: BigInt(row.collateral_in_usd_e6),
    leverageE6: BigInt(row.leverage_e6),lastPriceE6: BigInt(row.last_price_e6),
    openedAt: row.opened_at ? new Date(row.opened_at) : null,lastSlot: Number(row.last_slot),updatedAt: new Date(row.updated_at),closed: Boolean(row.closed),
  };
}

function rowToEventView(row: any): EventLogView {
  const fixed = {
    usdPnlE6: row.usd_pnl_e6,usdBasePnlE6: row.usd_base_pnl_e6,usdFeeE6: row.usd_fee_e6,
    sizeInUsdE6: row.size_in_usd_e6,leverageE6: row.leverage_e6,collateralInUsdE6: row.collateral_in_usd_e6,
    collateralDeltaUsdE6: row.collateral_delta_usd_e6,sizeDeltaUsdE6: row.size_delta_usd_e6,
    leverageDeltaE6: row.leverage_delta_e6,priceE6: row.price_e6,collateralUsdPriceE6: row.collateral_usd_price_e6,
  };
  const history = {
    positionKey: row.position_key,address: row.address,pair: row.pair,operation: row.operation as PerpTradeHistoryOperation,
    usdPnlE6: BigInt(row.usd_pnl_e6),usdBasePnlE6: BigInt(row.usd_base_pnl_e6),usdFeeE6: BigInt(row.usd_fee_e6),
    sizeInUsdE6: BigInt(row.size_in_usd_e6),leverageE6: BigInt(row.leverage_e6),collateralInUsdE6: BigInt(row.collateral_in_usd_e6),
    collateralDeltaUsdE6: BigInt(row.collateral_delta_usd_e6),sizeDeltaUsdE6: BigInt(row.size_delta_usd_e6),
    leverageDeltaE6: BigInt(row.leverage_delta_e6),isLong: Boolean(row.is_long),priceE6: BigInt(row.price_e6),
    collateralUsdPriceE6: BigInt(row.collateral_usd_price_e6),closeReason: row.close_reason as PerpCloseReason | null,
    dataQuality: row.data_quality as DataQuality,liquidation: Boolean(row.liquidation),marketAddress: row.market_address,
    collateralAddress: row.collateral_address ?? null,
  };
  return {
    ...toLuckyPlansPurePerpTradeHistory(history),
    dedupeKey: `${row.platform}:${row.signature}:${row.outer_instruction_index}:${row.inner_instruction_index}:${row.event_discriminator}`,
    platform: row.platform as Platform,programId: row.program_id,ingestionSource: row.ingestion_source as IngestionSource,
    signature: row.signature,slot: Number(row.slot),date: row.block_time,outerInstructionIndex: row.outer_instruction_index,
    innerInstructionIndex: row.inner_instruction_index,eventName: row.event_name,eventDiscriminatorHex: row.event_discriminator,
    closeReason: row.close_reason as PerpCloseReason | null,dataQuality: row.data_quality as DataQuality,
    liquidation: Boolean(row.liquidation),marketAddress: row.market_address,collateralAddress: row.collateral_address ?? null,
    decodedEvent: JSON.parse(row.decoded_event_json),fixed,
  };
}

function rowToDaily(row: any): DailyLeaderboardRow {
  return {
    platform: row.platform as Platform,address: row.address,dateStr: row.date_str,
    grossPnlE6: BigInt(row.gross_pnl_e6),feesPaidE6: BigInt(row.fees_paid_e6),netPnlE6: BigInt(row.net_pnl_e6),volumeE6: BigInt(row.volume_e6),
    actionCount: row.action_count,realizedActionCount: row.realized_action_count,winningActionCount: row.winning_action_count,
    losingActionCount: row.losing_action_count,liquidationCount: row.liquidation_count,firstEventAt: row.first_event_at,lastEventAt: row.last_event_at,
  };
}
