"""Core logic: ingest MQTT messages, track node state, fan out to websocket clients."""
from __future__ import annotations

import asyncio
import json
import logging
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

Publisher = Callable[[str, str, bool], Awaitable[None]]


class Hub:
    def __init__(self, db: Database, base_topic: str):
        self.db = db
        self.base = base_topic.strip("/")
        self.clients: set[WebSocket] = set()
        self.publisher: Publisher | None = None
        self.mqtt_connected = False
        self._online_cache: dict[str, bool] = {}

    # -- views ------------------------------------------------------------
    def offline_threshold(self, node: dict, settings: dict) -> float:
        interval = node.get("interval") or 30
        return max(float(settings["offline_after"]), interval * 3 + 15)

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
        await self.broadcast({"type": "meta", "meta": self.meta()})

    # -- MQTT ingest ------------------------------------------------------
    async def on_message(self, topic: str, payload: bytes) -> None:
        parts = topic.split("/")
        if len(parts) != 3 or parts[0] != self.base:
            return
        _, node_id, kind = parts
        if not NODE_ID_RE.match(node_id):
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
            self.db.create_node(node_id, (name or node_id)[:48], now)
            node = self.db.node(node_id)
        return node

    async def handle_state(self, node_id: str, data: dict, now: float | None = None) -> None:
        now = now or time.time()
        node = self._ensure_node(node_id, data.get("name"), now)
        settings = self.db.settings()

        vals = {}
        for key, off in (("t", node["t_off"]), ("h", node["h_off"]), ("p", node["p_off"])):
            v = _num(data.get(key))
            lo, hi = LIMITS[key]
            if v is not None and lo <= v <= hi:
                v = v + (off or 0)
                if key == "h":
                    v = min(100.0, max(0.0, v))
                vals[key] = round(v, 2)
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
        if has_data:
            update.update(last_t=vals["t"], last_h=vals["h"], last_p=vals["p"], last_ts=now)
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

    async def handle_status(self, node_id: str, text: str) -> None:
        if not text:  # retained status cleared
            return
        status = "online" if text.lower() == "online" else "offline"
        now = time.time()
        self._ensure_node(node_id, None, now)
        # last_seen only moves on real data: a retained "online" from a node that
        # died uncleanly must not make it look alive after a server restart.
        self.db.update_node(node_id, status=status)
        await self.broadcast_node(node_id)

    async def handle_info(self, node_id: str, data: dict) -> None:
        now = time.time()
        node = self._ensure_node(node_id, data.get("name"), now)
        fields = {
            "sensor": _str(data.get("sensor")),
            "fw": _str(data.get("fw")),
            "ip": _str(data.get("ip")),
            "mac": _str(data.get("mac")),
            "model": _str(data.get("model")),
        }
        # Adopt the node's own name until a user renames it on the dashboard.
        if node["name"] == node_id and _str(data.get("name")):
            fields["name"] = _str(data["name"])[:48]
        interval = _int(data.get("interval"))
        if interval:
            fields["interval"] = interval
        if "led" in data:
            fields["led"] = 1 if data["led"] else 0
        self.db.update_node(node_id, **{k: v for k, v in fields.items() if v is not None})
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
        node = self.db.node(node_id)
        if not node:
            return False
        cfg = {"name": node["name"], "led": bool(node["led"])}
        if node["interval"]:
            cfg["interval"] = node["interval"]
        return await self.publish(f"{self.base}/{node_id}/config", json.dumps(cfg), retain=True)

    async def command(self, node_id: str, action: str) -> bool:
        return await self.publish(f"{self.base}/{node_id}/cmd", json.dumps({"action": action}))

    async def forget(self, node_id: str) -> None:
        for kind in ("config", "info", "status"):
            await self.publish(f"{self.base}/{node_id}/{kind}", "", retain=True)
        self.db.delete_node(node_id)
        self._online_cache.pop(node_id, None)
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
        return float(v) if v == v else None  # filter NaN
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
