#!/usr/bin/env python3
"""Export canonical perp actions from the POC SQLite database to partitioned Parquet."""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
except ImportError as exc:  # pragma: no cover - user-facing setup guard
    raise SystemExit(
        "pyarrow is required. Install it with: python3 -m pip install -r requirements-parquet.txt"
    ) from exc

E6 = Decimal(1_000_000)

DECIMAL_COLUMNS = {
    "usd_pnl": "usd_pnl_e6",
    "usd_base_pnl": "usd_base_pnl_e6",
    "usd_fee": "usd_fee_e6",
    "size_in_usd": "size_in_usd_e6",
    "leverage": "leverage_e6",
    "collateral_in_usd": "collateral_in_usd_e6",
    "collateral_delta_usd": "collateral_delta_usd_e6",
    "size_delta_usd": "size_delta_usd_e6",
    "leverage_delta": "leverage_delta_e6",
    "price": "price_e6",
    "collateral_usd_price": "collateral_usd_price_e6",
}

SCHEMA = pa.schema(
    [
        ("platform", pa.string()),
        ("program_id", pa.string()),
        ("signature", pa.string()),
        ("slot", pa.int64()),
        ("block_time", pa.timestamp("ms", tz="UTC")),
        ("outer_instruction_index", pa.int32()),
        ("inner_instruction_index", pa.int32()),
        ("event_name", pa.string()),
        ("event_discriminator", pa.string()),
        ("order_key", pa.string()),
        ("request_key", pa.string()),
        ("position_key", pa.string()),
        ("address", pa.string()),
        ("pair", pa.string()),
        ("market_address", pa.string()),
        ("collateral_address", pa.string()),
        ("operation", pa.string()),
        ("close_reason", pa.string()),
        ("data_quality", pa.string()),
        *( (name, pa.decimal128(38, 6)) for name in DECIMAL_COLUMNS ),
        ("is_long", pa.bool_()),
        ("liquidation", pa.bool_()),
    ],
    metadata={
        b"dataset": b"luckyplans-canonical-perp-actions",
        b"fixed_point": b"decimal128(38,6)",
    },
)

SELECT_COLUMNS = [
    "platform",
    "program_id",
    "signature",
    "slot",
    "block_time",
    "outer_instruction_index",
    "inner_instruction_index",
    "event_name",
    "event_discriminator",
    "order_key",
    "request_key",
    "position_key",
    "address",
    "pair",
    "market_address",
    "collateral_address",
    "operation",
    "close_reason",
    "data_quality",
    *DECIMAL_COLUMNS.values(),
    "is_long",
    "liquidation",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--platform", choices=["GMTRADE", "JUPITER"])
    parser.add_argument("--from", dest="from_time")
    parser.add_argument("--to", dest="to_time")
    parser.add_argument("--batch-size", type=int, default=100_000)
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def conditions(args: argparse.Namespace) -> tuple[str, list[object]]:
    clauses: list[str] = []
    values: list[object] = []
    if args.platform:
        clauses.append("platform = ?")
        values.append(args.platform)
    if args.from_time:
        clauses.append("block_time >= ?")
        values.append(args.from_time)
    if args.to_time:
        clauses.append("block_time < ?")
        values.append(args.to_time)
    return (" WHERE " + " AND ".join(clauses) if clauses else "", values)


def to_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def transform(row: sqlite3.Row) -> dict[str, object]:
    item: dict[str, object] = {
        "platform": row["platform"],
        "program_id": row["program_id"],
        "signature": row["signature"],
        "slot": int(row["slot"]),
        "block_time": to_utc(row["block_time"]),
        "outer_instruction_index": int(row["outer_instruction_index"]),
        "inner_instruction_index": int(row["inner_instruction_index"]),
        "event_name": row["event_name"],
        "event_discriminator": row["event_discriminator"],
        "order_key": row["order_key"],
        "request_key": row["request_key"],
        "position_key": row["position_key"],
        "address": row["address"],
        "pair": row["pair"],
        "market_address": row["market_address"],
        "collateral_address": row["collateral_address"],
        "operation": row["operation"],
        "close_reason": row["close_reason"],
        "data_quality": row["data_quality"],
        "is_long": bool(row["is_long"]),
        "liquidation": bool(row["liquidation"]),
    }
    for output_name, source_name in DECIMAL_COLUMNS.items():
        item[output_name] = Decimal(str(row[source_name])) / E6
    return item


def main() -> int:
    args = parse_args()
    database = Path(args.database).resolve()
    output = Path(args.output).resolve()
    if not database.exists():
        raise SystemExit(f"SQLite database does not exist: {database}")
    output.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    where, values = conditions(args)
    partitions = connection.execute(
        "SELECT DISTINCT platform, substr(block_time, 1, 7) AS year_month "
        f"FROM event_logs{where} ORDER BY platform, year_month",
        values,
    ).fetchall()

    total_rows = 0
    files: list[dict[str, object]] = []
    for partition in partitions:
        platform = str(partition["platform"])
        year_month = str(partition["year_month"])
        year, month = year_month.split("-", 1)
        directory = output / f"platform={platform}" / f"year={year}" / f"month={month}"
        if args.overwrite and directory.exists():
            shutil.rmtree(directory)
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / "canonical-actions.parquet"
        if target.exists() and not args.overwrite:
            raise SystemExit(f"Parquet partition already exists: {target}; pass --overwrite")

        clauses = ["platform = ?", "substr(block_time, 1, 7) = ?"]
        params: list[object] = [platform, year_month]
        if args.from_time:
            clauses.append("block_time >= ?")
            params.append(args.from_time)
        if args.to_time:
            clauses.append("block_time < ?")
            params.append(args.to_time)
        sql = (
            f"SELECT {', '.join(SELECT_COLUMNS)} FROM event_logs "
            f"WHERE {' AND '.join(clauses)} "
            "ORDER BY block_time, slot, outer_instruction_index, inner_instruction_index"
        )
        cursor = connection.execute(sql, params)
        writer = pq.ParquetWriter(
            target,
            SCHEMA,
            compression="zstd",
            use_dictionary=True,
            write_statistics=True,
        )
        partition_rows = 0
        try:
            while True:
                batch = cursor.fetchmany(max(1, args.batch_size))
                if not batch:
                    break
                table = pa.Table.from_pylist([transform(row) for row in batch], schema=SCHEMA)
                writer.write_table(table)
                partition_rows += len(batch)
        finally:
            writer.close()
        total_rows += partition_rows
        files.append(
            {
                "path": str(target),
                "rows": partition_rows,
                "bytes": target.stat().st_size,
            }
        )

    connection.close()
    print(
        json.dumps(
            {
                "database": str(database),
                "output": str(output),
                "rows": total_rows,
                "files": files,
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
