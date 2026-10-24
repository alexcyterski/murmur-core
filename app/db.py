"""SQLite persistence for nodes, readings and settings."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    location    TEXT NOT NULL DEFAULT '',
    sensor      TEXT,
    fw          TEXT,
    ip          TEXT,
    mac         TEXT,
    model       TEXT,
    interval    INTEGER,
    led         INTEGER NOT NULL DEFAULT 1,
    rssi        INTEGER,
    uptime      INTEGER,
    status      TEXT NOT NULL DEFAULT 'unknown',
    error       TEXT,
    first_seen  REAL,
    last_seen   REAL,
    t_off       REAL NOT NULL DEFAULT 0,
    h_off       REAL NOT NULL DEFAULT 0,
    p_off       REAL NOT NULL DEFAULT 0,
    t_min       REAL,
    t_max       REAL,
    h_min       REAL,
    h_max       REAL,
    last_t      REAL,
    last_h      REAL,
    last_p      REAL,
    last_ts     REAL,
    last_stored INTEGER
);
CREATE TABLE IF NOT EXISTS readings (
    node_id TEXT    NOT NULL,
    ts      INTEGER NOT NULL,
    t       REAL,
    h       REAL,
    p       REAL
);
CREATE INDEX IF NOT EXISTS idx_readings_node_ts ON readings (node_id, ts);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS node_config (
    node_id TEXT PRIMARY KEY,
    desired TEXT NOT NULL
);
"""

DEFAULT_SETTINGS: dict = {
    "temp_unit": "C",          # C | F
    "pressure_unit": "hPa",    # hPa | inHg | mmHg | kPa
    "theme": "dark",           # dark | light | system
    "accent": "#3e6ae1",
    "time_format": "24h",      # 24h | 12h
    "spark_range": "6h",       # sparkline window on dashboard cards
    "sort_by": "name",         # name | location | temperature | recent
    "retention_days": 90,      # 0 = keep forever
    "resolution": 0,           # min seconds between stored points (0 = store every reading)
    "offline_after": 180,      # seconds without data before a node is considered offline
}

NODE_COLUMNS = {
    "name", "location", "sensor", "fw", "ip", "mac", "model", "interval", "led", "rssi",
    "uptime", "status", "error", "first_seen", "last_seen", "t_off", "h_off", "p_off",
    "t_min", "t_max", "h_min", "h_max", "last_t", "last_h", "last_p", "last_ts", "last_stored",
}


class Database:
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(SCHEMA)

    # -- primitives -------------------------------------------------------
    def _all(self, sql: str, args=()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, args).fetchall()

    def _one(self, sql: str, args=()) -> sqlite3.Row | None:
        with self._lock:
            return self._conn.execute(sql, args).fetchone()

    def _exec(self, sql: str, args=()) -> None:
        with self._lock:
            self._conn.execute(sql, args)

    # -- nodes ------------------------------------------------------------
    def nodes(self) -> list[dict]:
        return [dict(r) for r in self._all("SELECT * FROM nodes ORDER BY name COLLATE NOCASE")]

    def node(self, node_id: str) -> dict | None:
        row = self._one("SELECT * FROM nodes WHERE id = ?", (node_id,))
        return dict(row) if row else None

    def create_node(self, node_id: str, name: str, now: float) -> None:
        self._exec(
            "INSERT OR IGNORE INTO nodes (id, name, first_seen) VALUES (?, ?, ?)",
            (node_id, name, now),
        )

    def update_node(self, node_id: str, **fields) -> None:
        cols = [c for c in fields if c in NODE_COLUMNS]
        if not cols:
            return
        sql = f"UPDATE nodes SET {', '.join(f'{c} = ?' for c in cols)} WHERE id = ?"
        self._exec(sql, [fields[c] for c in cols] + [node_id])

    def delete_node(self, node_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM node_config WHERE node_id = ?", (node_id,))
            self._conn.execute("DELETE FROM readings WHERE node_id = ?", (node_id,))
            self._conn.execute("DELETE FROM nodes WHERE id = ?", (node_id,))

    def desired_config(self, node_id: str) -> dict:
        row = self._one("SELECT desired FROM node_config WHERE node_id = ?", (node_id,))
        return json.loads(row[0]) if row else {}

    def patch_node(self, node_id: str, **fields) -> None:
        """Save dashboard edits and their MQTT overrides together, before publishing."""
        overrides = {k: v for k, v in fields.items() if k in ("name", "interval", "led")}
        with self._lock:
            self._conn.execute("BEGIN")
            try:
                if overrides:
                    desired = {**self.desired_config(node_id), **overrides}
                    if "led" in desired:
                        desired["led"] = bool(desired["led"])
                    self._conn.execute(
                        "INSERT INTO node_config (node_id, desired) VALUES (?, ?) "
                        "ON CONFLICT(node_id) DO UPDATE SET desired = excluded.desired",
                        (node_id, json.dumps(desired)),
                    )
                self.update_node(node_id, **fields)
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    # -- readings ---------------------------------------------------------
    def add_reading(self, node_id: str, ts: int, t, h, p) -> None:
        self._exec(
            "INSERT INTO readings (node_id, ts, t, h, p) VALUES (?, ?, ?, ?, ?)",
            (node_id, ts, t, h, p),
        )

    def add_readings(self, rows: list[tuple]) -> None:
        with self._lock:
            self._conn.execute("BEGIN")
            self._conn.executemany(
                "INSERT INTO readings (node_id, ts, t, h, p) VALUES (?, ?, ?, ?, ?)", rows
            )
            self._conn.execute("COMMIT")

    def history(self, node_id: str, since: int, bucket: int) -> list[list]:
        rows = self._all(
            """
            SELECT (ts / ?) * ? AS b, AVG(t), AVG(h), AVG(p)
            FROM readings WHERE node_id = ? AND ts >= ?
            GROUP BY b ORDER BY b
            """,
            (bucket, bucket, node_id, since),
        )
        return [[r[0], _r(r[1]), _r(r[2]), _r(r[3])] for r in rows]

    def stats(self, node_id: str, since: int) -> dict:
        r = self._one(
            """
            SELECT COUNT(*), MIN(t), AVG(t), MAX(t), MIN(h), AVG(h), MAX(h), MIN(p), AVG(p), MAX(p)
            FROM readings WHERE node_id = ? AND ts >= ?
            """,
            (node_id, since),
        )
        def trio(i):
            return {"min": _r(r[i]), "avg": _r(r[i + 1]), "max": _r(r[i + 2])}
        return {"count": r[0], "t": trio(1), "h": trio(4), "p": trio(7)}

    def iter_readings(self, node_id: str, since: int):
        with self._lock:
            rows = self._conn.execute(
                "SELECT ts, t, h, p FROM readings WHERE node_id = ? AND ts >= ? ORDER BY ts",
                (node_id, since),
            ).fetchall()
        yield from rows

    def purge(self, before: int) -> int:
        with self._lock:
            cur = self._conn.execute("DELETE FROM readings WHERE ts < ?", (before,))
            return cur.rowcount

    def summary(self) -> dict:
        r = self._one("SELECT COUNT(*), MIN(ts) FROM readings")
        size = 0
        for suffix in ("", "-wal"):
            try:
                size += os.path.getsize(self.path + suffix)
            except OSError:
                pass
        return {"readings": r[0], "oldest": r[1], "db_bytes": size}

    # -- settings ---------------------------------------------------------
    def settings(self) -> dict:
        out = dict(DEFAULT_SETTINGS)
        for row in self._all("SELECT key, value FROM settings"):
            if row["key"] in DEFAULT_SETTINGS:
                out[row["key"]] = json.loads(row["value"])
        return out

    def save_settings(self, values: dict) -> dict:
        with self._lock:
            for k, v in values.items():
                if k in DEFAULT_SETTINGS:
                    self._conn.execute(
                        "INSERT INTO settings (key, value) VALUES (?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (k, json.dumps(v)),
                    )
        return self.settings()


def _r(v, nd: int = 2):
    return None if v is None else round(v, nd)
