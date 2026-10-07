#!/usr/bin/env python3
"""Fetch VARUS operating data from Databricks and publish static report files."""

import csv
import json
import os
from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

from databricks import sql as dbsql

ROOT = Path(__file__).parent
START_DATE = os.getenv("DATA_START", "2026-07-01")
KYIV = ZoneInfo("Europe/Kyiv")

QUERY = """
WITH providers AS (
    SELECT provider_id, provider_name, city_name
    FROM main.ng_delivery.dim_provider_v2
    WHERE country_code = 'ua' AND group_name = 'VARUS'
),
orders AS (
    SELECT
        f.order_created_date AS date,
        f.provider_id,
        SUM(CASE WHEN f.order_state = 'delivered' THEN f.order_gmv_eur ELSE 0 END) AS gmv,
        COUNT(*) AS placed,
        SUM(CASE WHEN f.order_state = 'delivered' THEN 1 ELSE 0 END) AS orders,
        SUM(CASE WHEN f.order_state = 'delivered' AND f.is_bad_order THEN 1 ELSE 0 END) AS bad_orders,
        SUM(CASE WHEN f.order_state IN ('failed', 'rejected') THEN 1 ELSE 0 END) AS failed_orders
    FROM main.ng_delivery.fact_order_delivery f
    JOIN providers p ON p.provider_id = f.provider_id
    WHERE f.order_created_date >= '{start_date}'
      AND f.order_created_date < '{through_date}'
    GROUP BY 1, 2
),
availability AS (
    SELECT
        d.observation_date AS date,
        d.provider_id,
        d.provider_active_time_minutes AS active_time,
        d.provider_working_time_minutes AS working_time
    FROM main.ng_delivery.fact_provider_daily d
    JOIN providers p ON p.provider_id = d.provider_id
    WHERE d.observation_date >= '{start_date}'
      AND d.observation_date < '{through_date}'
)
SELECT
    COALESCE(a.date, o.date) AS date,
    CAST(COALESCE(a.provider_id, o.provider_id) AS STRING) AS store_id,
    p.provider_name AS store_name,
    p.city_name AS city,
    COALESCE(o.gmv, 0) AS gmv,
    COALESCE(o.placed, 0) AS placed,
    COALESCE(o.orders, 0) AS orders,
    COALESCE(o.bad_orders, 0) AS bad_orders,
    COALESCE(o.failed_orders, 0) AS failed_orders,
    a.active_time,
    a.working_time,
    CASE WHEN a.active_time IS NOT NULL AND a.working_time IS NOT NULL THEN 1 ELSE 0 END AS availability_observations
FROM availability a
FULL OUTER JOIN orders o ON a.date = o.date AND a.provider_id = o.provider_id
JOIN providers p ON p.provider_id = COALESCE(a.provider_id, o.provider_id)
ORDER BY 1, 3, 2
"""


def connection():
    host = os.environ["DATABRICKS_HOST"]
    token = os.environ["DATABRICKS_TOKEN"]
    http_path = os.getenv("DATABRICKS_HTTP_PATH") or f"/sql/1.0/warehouses/{os.environ['DATABRICKS_WAREHOUSE_ID']}"
    return dbsql.connect(server_hostname=host, http_path=http_path, access_token=token)


def number(value):
    if isinstance(value, Decimal):
        return float(value)
    return value


def fetch_rows(through_date):
    with connection() as conn:
        with conn.cursor() as cursor:
            cursor.execute(QUERY.format(start_date=START_DATE, through_date=through_date))
            names = [column[0] for column in cursor.description]
            return [{name: number(value) for name, value in zip(names, values)} for values in cursor.fetchall()]


def as_daily(rows):
    daily = []
    for row in rows:
        active, working = row["active_time"], row["working_time"]
        record = {
            **row,
            "date": row["date"].isoformat() if isinstance(row["date"], date) else str(row["date"]),
            "gmv": round(float(row["gmv"]), 6),
            "active_time": float(active) if active is not None else None,
            "working_time": float(working) if working is not None else None,
            "online_hours": round(float(active) / 60, 4) if active is not None else None,
            "scheduled_hours": round(float(working) / 60, 4) if working is not None else None,
            "availability_pct": round(float(active) / float(working) * 100, 2) if working and active is not None else None,
            "bad_order_rate_pct": round(float(row["bad_orders"]) / float(row["orders"]) * 100, 2) if row["orders"] else None,
            "failed_order_rate_pct": round(float(row["failed_orders"]) / float(row["placed"]) * 100, 2) if row["placed"] else None,
            "currency": "EUR",
        }
        daily.append(record)
    return daily


def aggregate(rows, dimensions):
    grouped = defaultdict(list)
    for row in rows:
        grouped[tuple(row[key] for key in dimensions)].append(row)
    result = []
    for key, group in sorted(grouped.items()):
        active = [r["active_time"] for r in group if r["active_time"] is not None and r["working_time"] is not None]
        working = [r["working_time"] for r in group if r["active_time"] is not None and r["working_time"] is not None]
        item = dict(zip(dimensions, key))
        for metric in ("gmv", "placed", "orders", "bad_orders", "failed_orders"):
            item[metric] = sum(float(r[metric]) for r in group)
        item["active_time"] = sum(active) if active else None
        item["working_time"] = sum(working) if working else None
        item["availability_observations"] = len(active)
        item["online_hours"] = item["active_time"] / 60 if active else None
        item["scheduled_hours"] = item["working_time"] / 60 if working else None
        item["availability_pct"] = item["active_time"] / item["working_time"] * 100 if item["working_time"] else None
        item["bad_order_rate_pct"] = item["bad_orders"] / item["orders"] * 100 if item["orders"] else None
        item["failed_order_rate_pct"] = item["failed_orders"] / item["placed"] * 100 if item["placed"] else None
        item["currency"] = "EUR"
        result.append(item)
    return result


def week_start(value):
    return (datetime.strptime(value, "%Y-%m-%d").date() - timedelta(days=datetime.strptime(value, "%Y-%m-%d").weekday())).isoformat()


def write_csv(path, rows):
    if not rows:
        return
    with path.open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def main():
    # At 09:00 Kyiv the fully completed reporting day is yesterday.
    through = datetime.now(KYIV).date().isoformat()
    daily = as_daily(fetch_rows(through))
    if not daily:
        raise RuntimeError("Databricks returned no VARUS rows; report files were not replaced.")

    for row in daily:
        row["week"] = week_start(row["date"])
    weekly = aggregate(daily, ["store_id", "store_name", "city", "week"])
    for row in weekly:
        row["elapsed_days"] = 7
        row["gmv_weekly_rr"] = row["gmv"]
        row["orders_weekly_rr"] = row["orders"]
        row["complete_week"] = True
    cities = aggregate(daily, ["date", "city"])
    network = aggregate(daily, ["date"])
    updated_at = datetime.now(KYIV).isoformat()
    payload = {
        "schema_version": 2,
        "currency": "EUR",
        "updated_at": updated_at,
        "through": daily[-1]["date"],
        "daily": daily,
        "network": network,
    }
    (ROOT / "data.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    write_csv(ROOT / "daily.csv", daily)
    write_csv(ROOT / "weekly.csv", weekly)
    write_csv(ROOT / "cities.csv", cities)
    print(f"Published {len(daily)} daily rows through {payload['through']}.")


if __name__ == "__main__":
    main()
