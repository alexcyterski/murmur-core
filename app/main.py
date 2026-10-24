"""Murmur server - HTTP API, websocket live feed and static dashboard."""
from __future__ import annotations

import asyncio
import csv
import io
import logging
import math
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .db import DEFAULT_SETTINGS, Database
from .hub import INTERVAL_MAX, INTERVAL_MIN, Hub

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("murmur")

DATA_DIR = os.getenv("DATA_DIR", "/data")
MQTT_HOST = os.getenv("MQTT_HOST", "mosquitto")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_USER = os.getenv("MQTT_USERNAME", "")
MQTT_PASS = os.getenv("MQTT_PASSWORD", "")
BASE_TOPIC = os.getenv("MQTT_BASE_TOPIC", "murmur")
DEMO = os.getenv("MURMUR_DEMO", "0").lower() in ("1", "true", "yes")

RANGES = {
    "1h": 3600, "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400,
    "30d": 30 * 86400, "90d": 90 * 86400, "1y": 365 * 86400,
}

db = Database(str(Path(DATA_DIR) / "murmur.db"))
hub = Hub(db, BASE_TOPIC)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    tasks = [asyncio.create_task(hub.watchdog()), asyncio.create_task(hub.retention())]
    if DEMO:
        from .demo import run_demo
        log.info("demo mode enabled - simulating nodes")
        tasks.append(asyncio.create_task(run_demo(hub)))
    if MQTT_HOST and not (DEMO and MQTT_HOST == "none"):
        from .mqtt import MqttBridge
        tasks.append(asyncio.create_task(MqttBridge(hub, MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASS).run()))
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Murmur", version=__version__, lifespan=lifespan, docs_url="/api/docs", redoc_url=None)


# -- models -------------------------------------------------------------------
class NodePatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=48)
    location: Optional[str] = Field(None, max_length=48)
    interval: Optional[int] = Field(None, ge=INTERVAL_MIN, le=INTERVAL_MAX)
    led: Optional[bool] = None
    t_off: Optional[float] = Field(None, ge=-20, le=20)
    h_off: Optional[float] = Field(None, ge=-30, le=30)
    p_off: Optional[float] = Field(None, ge=-100, le=100)
    t_min: Optional[float] = None
    t_max: Optional[float] = None
    h_min: Optional[float] = None
    h_max: Optional[float] = None


class Command(BaseModel):
    action: Literal["identify", "reboot", "read"]


class SettingsPatch(BaseModel):
    temp_unit: Optional[Literal["C", "F"]] = None
    pressure_unit: Optional[Literal["hPa", "inHg", "mmHg", "kPa"]] = None
    theme: Optional[Literal["dark", "light", "system"]] = None
    accent: Optional[str] = Field(None, pattern=r"^#[0-9a-fA-F]{6}$")
    time_format: Optional[Literal["24h", "12h"]] = None
    spark_range: Optional[Literal["1h", "6h", "24h"]] = None
    sort_by: Optional[Literal["name", "location", "temperature", "recent"]] = None
    retention_days: Optional[int] = Field(None, ge=0, le=3650)
    resolution: Optional[int] = Field(None, ge=0, le=3600)
    offline_after: Optional[int] = Field(None, ge=30, le=86400)


def _node_or_404(node_id: str) -> dict:
    node = db.node(node_id)
    if not node:
        raise HTTPException(404, "Node not found")
    return node


def _range(r: str) -> int:
    if r not in RANGES:
        raise HTTPException(400, f"range must be one of {', '.join(RANGES)}")
    return RANGES[r]


# -- API ----------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__, "mqtt": hub.mqtt_connected}


@app.get("/api/meta")
def meta():
    return {"version": __version__, "demo": DEMO, "mqtt_host": MQTT_HOST, "mqtt_port": MQTT_PORT, **hub.meta()}


@app.get("/api/nodes")
def list_nodes():
    return hub.views()


@app.get("/api/nodes/{node_id}")
def get_node(node_id: str):
    return hub.view(_node_or_404(node_id))


@app.patch("/api/nodes/{node_id}")
async def patch_node(node_id: str, patch: NodePatch):
    node = _node_or_404(node_id)
    fields = patch.model_dump(exclude_unset=True)
    for k in ("name", "interval", "led", "t_off", "h_off", "p_off"):
        if k in fields and fields[k] is None:
            fields.pop(k)  # these cannot be cleared, only changed
    if "name" in fields:
        fields["name"] = fields["name"].strip() or node["name"]
    if "led" in fields:
        fields["led"] = 1 if fields["led"] else 0
    db.patch_node(node_id, **fields)
    pushed = None
    if {"name", "interval", "led"} & fields.keys():
        pushed = await hub.push_config(node_id)
    await hub.broadcast_node(node_id)
    return {"node": hub.view(db.node(node_id)), "pushed": pushed}


@app.delete("/api/nodes/{node_id}")
async def delete_node(node_id: str):
    _node_or_404(node_id)
    await hub.forget(node_id)
    return {"ok": True}


@app.post("/api/nodes/{node_id}/command")
async def node_command(node_id: str, cmd: Command):
    _node_or_404(node_id)
    if not await hub.command(node_id, cmd.action):
        raise HTTPException(503, "MQTT broker is not connected")
    return {"ok": True}


@app.get("/api/nodes/{node_id}/history")
async def node_history(node_id: str, range: str = "24h", points: int = Query(320, ge=20, le=2000)):
    _node_or_404(node_id)
    span = _range(range)
    now = int(time.time())
    since = now - span
    bucket = max(1, math.ceil(span / points))
    data, stats = await asyncio.gather(
        asyncio.to_thread(db.history, node_id, since, bucket),
        asyncio.to_thread(db.stats, node_id, since),
    )
    return {"range": range, "since": since, "until": now, "bucket": bucket, "points": data, "stats": stats}


@app.get("/api/nodes/{node_id}/export.csv")
def export_csv(node_id: str, range: str = "30d"):
    node = _node_or_404(node_id)
    since = int(time.time()) - _range(range)

    def rows():
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["timestamp_utc", "epoch", "temperature_c", "humidity_pct", "pressure_hpa"])
        for ts, t, h, p in db.iter_readings(node_id, since):
            w.writerow([datetime.fromtimestamp(ts, timezone.utc).isoformat(), ts, t, h, p])
            if buf.tell() > 32_768:
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate()
        yield buf.getvalue()

    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in node["name"]).strip("-") or node_id
    return StreamingResponse(
        rows(), media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{safe}-{range}.csv"'},
    )


@app.get("/api/settings")
def get_settings():
    return db.settings()


@app.put("/api/settings")
async def put_settings(patch: SettingsPatch):
    values = {k: v for k, v in patch.model_dump(exclude_unset=True).items() if v is not None}
    settings = db.save_settings(values)
    await hub.broadcast({"type": "settings", "settings": settings})
    return settings


@app.post("/api/settings/reset")
async def reset_settings():
    settings = db.save_settings(DEFAULT_SETTINGS)
    await hub.broadcast({"type": "settings", "settings": settings})
    return settings


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    hub.clients.add(websocket)
    try:
        await websocket.send_json({
            "type": "hello", "nodes": hub.views(), "settings": db.settings(), "meta": hub.meta(),
        })
        while True:
            await websocket.receive_text()  # keepalive pings from the client
    except WebSocketDisconnect:
        pass
    finally:
        hub.clients.discard(websocket)


app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
