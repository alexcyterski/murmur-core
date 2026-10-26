"""Core logic: ingest MQTT messages, track node state, fan out to websocket clients."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import time
from typing import Awaitable, Callable

from fastapi import WebSocket

from .db import Database

log = logging.getLogger("murmur.hub")

NODE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,48}$")
INTERVAL_MIN, INTERVAL_MAX = 2, 3600

# Plausibility windows - anything outside is treated as a sensor glitch and dropped.
LIMITS = {"t": (-60.0, 125.0), "h": (0.0, 100.0), "p": (300.0, 1200.0)}

# A reading further than this from the node's previous one is ignored as a spike (e.g. a DHT22 returning
# 41 °F between 67 and 69). Skipped if the previous reading is older than 3 report intervals, and a second
# reading that agrees with the ignored one is accepted so a genuine step change can't lock a node out.
MAX_JUMP = {"t": 10.0, "h": 25.0, "p": 20.0}

Publisher = Callable[[str, str, bool], Awaitable[None]]


class Hub:
    def __init__(self, db: Database, base_topic: str):
        self.db = db
        self.base = base_topic.strip().strip("/")
        if not self.base or any(c in self.base for c in ("+", "#", "\x00")):
            raise ValueError("MQTT base topic must be nonempty and contain no wildcards or NUL")
        self.clients: set[WebSocket] = set()
        self.publisher: Publisher | None = None
        self.mqtt_connected = False
        self._online_cache: dict[str, bool] = {}
        # Spike filter state per (node, channel): last accepted value with its time, and an ignored value awaiting
        # confirmation. Kept apart from the node row so a report that omits a channel doesn't erase the baseline.
        self._last_good: dict[tuple[str, str], tuple[float, float]] = {}
        self._suspect: dict[tuple[str, str], float] = {}
        self._config_lock = asyncio.Lock()

    # -- views ------------------------------------------------------------
    def offline_threshold(self, node: dict, settings: dict) -> float:
        # A queued interval change must not make a sleeping node overdue early.
        interval = max(node.get("interval") or 30, node.get("reported_interval") or 0)
        grace = 75 if node.get("battery") or node.get("status") == "sleeping" else 15
        return max(float(settings["offline_after"]), interval * 3 + grace)

    def is_online(self, node: dict, settings: dict, now: float | None = None) -> bool:
        now = now or time.time()
        if node.get("status") == "offline" or not node.get("last_seen"):
            return False
        return now - node["last_seen"] <= self.offline_threshold(node, settings)

    def view(self, node: dict, settings: dict | None = None) -> dict:
        settings = settings or self.db.settings()
        return {
            "id": node["id"],
            "name": node["name"],
            "location": node["location"],
            "sensor": node["sensor"],
            "fw": node["fw"],
            "ip": node["ip"],
            "mac": node["mac"],
            "model": node["model"],
            "interval": node["interval"],
            "led": bool(node["led"]),
            "battery": None if node["battery"] is None else bool(node["battery"]),
            "sleeping": node["status"] == "sleeping" and self.is_online(node, settings),
            "rssi": node["rssi"],
            "uptime": node["uptime"],
            "error": node["error"],
            "online": self.is_online(node, settings),
            "first_seen": node["first_seen"],
            "last_seen": node["last_seen"],
            "offsets": {"t": node["t_off"], "h": node["h_off"], "p": node["p_off"]},
            "alerts": {
                "t_min": node["t_min"], "t_max": node["t_max"],
                "h_min": node["h_min"], "h_max": node["h_max"],
            },
            "reports": {"total": node["n_reports"], "ignored": node["n_ignored"]},
            "last": {
                "t": node["last_t"], "h": node["last_h"], "p": node["last_p"], "ts": node["last_ts"],
            },
        }

    def views(self) -> list[dict]:
        settings = self.db.settings()
        return [self.view(n, settings) for n in self.db.nodes()]

    def meta(self) -> dict:
        return {"mqtt": self.mqtt_connected, "base_topic": self.base, **self.db.summary()}

    # -- websocket fan-out ------------------------------------------------
    async def broadcast(self, message: dict) -> None:
        if not self.clients:
            return
        data = json.dumps(message)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def broadcast_node(self, node_id: str) -> None:
        node = self.db.node(node_id)
        if node:
            v = self.view(node)
            self._online_cache[node_id] = v["online"]
            await self.broadcast({"type": "node", "node": v})

    async def set_mqtt_state(self, connected: bool) -> None:
        self.mqtt_connected = connected
        if connected:
            # Also restores retained config if the broker lost its persistence.
            for node in self.db.nodes():
                await self.push_config(node["id"])
        await self.broadcast({"type": "meta", "meta": self.meta()})

    # -- MQTT ingest ------------------------------------------------------
    async def on_message(self, topic: str, payload: bytes) -> None:
        prefix = self.base + "/"
        if not topic.startswith(prefix):
            return
        parts = topic[len(prefix):].split("/")
        if len(parts) != 2:
            return
        node_id, kind = parts
        if not NODE_ID_RE.fullmatch(node_id):
            return
        text = payload.decode("utf-8", "replace").strip()
        if kind == "status":
            await self.handle_status(node_id, text)
            return
        if not text:
            return
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            log.warning("bad JSON on %s: %r", topic, text[:120])
            return
        if not isinstance(data, dict):
            return
        if kind == "state":
            await self.handle_state(node_id, data)
        elif kind == "info":
            await self.handle_info(node_id, data)

    def _ensure_node(self, node_id: str, name: str | None, now: float) -> dict:
        node = self.db.node(node_id)
        if node is None:
            log.info("discovered node %s", node_id)
            self.db.create_node(node_id, (_str(name) or node_id)[:48], now)
            node = self.db.node(node_id)
        return node

    async def handle_state(self, node_id: str, data: dict, now: float | None = None) -> None:
        now = now or time.time()
        node = self._ensure_node(node_id, data.get("name"), now)
        settings = self.db.settings()

        vals = {}
        ignored = set()
        for key, off in (("t", node["t_off"]), ("h", node["h_off"]), ("p", node["p_off"])):
            v = _num(data.get(key))
            lo, hi = LIMITS[key]
            if v is not None and lo <= v <= hi:
                v = v + (off or 0)
                if key == "h":
                    v = min(100.0, max(0.0, v))
                v = round(v, 2)
                if self._is_spike(node, key, v, now):
                    ignored.add(key)
                    v = None
                vals[key] = v
            else:
                vals[key] = None

        has_data = any(v is not None for v in vals.values())
        update = {
            "last_seen": now,
            "status": "online",
            "rssi": _int(data.get("rssi")),
            "uptime": _int(data.get("up")),
            "error": str(data["err"])[:64] if data.get("err") else None,
        }
        if has_data or ignored:
            update["n_reports"] = node["n_reports"] + 1
            if ignored:
                update["n_ignored"] = node["n_ignored"] + 1
        if has_data:
            # An ignored channel keeps its previous value on the node card.
            shown = {k: node[f"last_{k}"] if k in ignored else vals[k] for k in vals}
            update.update(last_t=shown["t"], last_h=shown["h"], last_p=shown["p"], last_ts=now)
            ts = int(now)
            resolution = int(settings["resolution"] or 0)
            last_stored = node["last_stored"] or 0
            if resolution <= 0 or ts - last_stored >= resolution:
                self.db.add_reading(node_id, ts, vals["t"], vals["h"], vals["p"])
                update["last_stored"] = ts
        self.db.update_node(node_id, **update)

        node = self.db.node(node_id)
        v = self.view(node, settings)
        self._online_cache[node_id] = v["online"]
        await self.broadcast({"type": "reading", "node": v})

    def _is_spike(self, node: dict, key: str, value: float, now: float) -> bool:
        slot = (node["id"], key)
        base = self._last_good.get(slot)
        if base is None and node[f"last_{key}"] is not None and node["last_ts"]:
            base = (node[f"last_{key}"], node["last_ts"])  # after a restart
        # Three intervals, so a missed wake of a slow node doesn't disable the check.
        interval = max(node["interval"] or 30, node["reported_interval"] or 0)
        if base is not None and now - base[1] <= 3 * interval:
            limit = MAX_JUMP[key]
            if abs(value - base[0]) > limit:
                earlier = self._suspect.get(slot)
                if earlier is None or abs(value - earlier) > limit:  # else two readings agree: the change is real
                    self._suspect[slot] = value
                    log.info("%s: ignoring %s=%s (previous %s)", node["id"], key, value, base[0])
                    return True
        self._suspect.pop(slot, None)
        self._last_good[slot] = (value, now)
        return False

    async def handle_status(self, node_id: str, text: str) -> None:
        if text.lower() not in ("online", "offline", "sleeping"):
            return
        status = text.lower()
        now = time.time()
        self._ensure_node(node_id, None, now)
        # last_seen only moves on real data: a retained "online" from a node that
        # died uncleanly must not make it look alive after a server restart.
        self.db.update_node(node_id, status=status)
        await self.broadcast_node(node_id)

    async def handle_info(self, node_id: str, data: dict) -> None:
        now = time.time()
        self._ensure_node(node_id, data.get("name"), now)
        fields = {
            "sensor": _str(data.get("sensor")),
            "fw": _str(data.get("fw")),
            "ip": _str(data.get("ip")),
            "mac": _str(data.get("mac")),
            "model": _str(data.get("model")),
        }
        desired = self.db.desired_config(node_id)
        # Only dashboard-edited fields are core-owned; the rest follow the node.
        if isinstance(data.get("name"), str) and data["name"]:
            fields["name"] = data["name"][:48]
        interval = _int(data.get("interval"))
        if interval is not None and INTERVAL_MIN <= interval <= INTERVAL_MAX:
            fields["interval"] = interval
            fields["reported_interval"] = interval
        if isinstance(data.get("led"), bool):
            fields["led"] = 1 if data["led"] else 0
        if isinstance(data.get("battery"), bool):
            fields["battery"] = 1 if data["battery"] else 0
        self.db.update_node(node_id, **{k: v for k, v in fields.items() if v is not None and k not in desired})
        if desired and any(data.get(k) != v for k, v in desired.items()):
            await self.push_config(node_id)
        await self.broadcast_node(node_id)

    # -- outbound ---------------------------------------------------------
    async def publish(self, topic: str, payload: str, retain: bool = False) -> bool:
        if not self.publisher:
            return False
        try:
            await self.publisher(topic, payload, retain)
            return True
        except Exception as exc:  # broker unavailable
            log.warning("publish to %s failed: %s", topic, exc)
            return False

    async def push_config(self, node_id: str) -> bool:
        # Serialize sends and read inside the lock so an older edit cannot win.
        async with self._config_lock:
            cfg = self.db.desired_config(node_id)
            if not cfg:
                return False
            return await self.publish(f"{self.base}/{node_id}/config", json.dumps(cfg), retain=True)

    async def command(self, node_id: str, action: str) -> bool:
        return await self.publish(f"{self.base}/{node_id}/cmd", json.dumps({"action": action}))

    async def forget(self, node_id: str) -> None:
        async with self._config_lock:
            for kind in ("config", "info", "status"):
                await self.publish(f"{self.base}/{node_id}/{kind}", "", retain=True)
            self.db.delete_node(node_id)
        self._online_cache.pop(node_id, None)
        for key in MAX_JUMP:
            self._suspect.pop((node_id, key), None)
            self._last_good.pop((node_id, key), None)
        await self.broadcast({"type": "removed", "id": node_id})

    # -- background loops -------------------------------------------------
    async def watchdog(self) -> None:
        """Broadcast online -> offline transitions for nodes that stop reporting."""
        while True:
            await asyncio.sleep(10)
            try:
                settings = self.db.settings()
                now = time.time()
                for node in self.db.nodes():
                    online = self.is_online(node, settings, now)
                    if self._online_cache.get(node["id"]) != online:
                        self._online_cache[node["id"]] = online
                        await self.broadcast({"type": "node", "node": self.view(node, settings)})
            except Exception:
                log.exception("watchdog failed")

    async def retention(self) -> None:
        while True:
            try:
                days = int(self.db.settings()["retention_days"] or 0)
                if days > 0:
                    removed = await asyncio.to_thread(self.db.purge, int(time.time()) - days * 86400)
                    if removed:
                        log.info("retention: purged %d readings older than %d days", removed, days)
            except Exception:
                log.exception("retention failed")
            await asyncio.sleep(3600)


def _num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        try:
            return float(v) if math.isfinite(v) else None
        except OverflowError:
            return None
    if isinstance(v, str):
        try:
            return _num(float(v))
        except ValueError:
            return None
    return None


def _int(v):
    n = _num(v)
    return int(n) if n is not None else None


def _str(v):
    return str(v)[:64] if v not in (None, "") else None
