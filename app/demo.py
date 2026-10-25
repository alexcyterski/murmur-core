"""Demo mode: simulated nodes so the dashboard can be explored without hardware."""
from __future__ import annotations

import asyncio
import math
import random
import time

from .hub import Hub

DEMO_NODES = [
    # id (also the default node name, like real firmware), location, sensor, base temp, base humidity, has pressure
    ("murmur-3fa21c", "Living Room", "aht20+bmp280", 21.8, 44.0, True),
    ("murmur-8b0e47", "Bedroom", "dht22", 19.6, 51.0, False),
    ("murmur-c41d90", "Garage", "bme280", 12.4, 63.0, True),
    ("murmur-e7720a", "Greenhouse", "dht11", 26.5, 72.0, False),
]


def _sample(base_t: float, base_h: float, has_p: bool, ts: float, seed: int) -> dict:
    day = 2 * math.pi * ((ts % 86400) / 86400)
    t = base_t + 2.2 * math.sin(day - 2.0) + 0.6 * math.sin(ts / 5400 + seed) + random.gauss(0, 0.08)
    h = base_h - 6.0 * math.sin(day - 2.0) + 2.0 * math.sin(ts / 7200 + seed) + random.gauss(0, 0.3)
    out = {"t": round(t, 2), "h": round(max(0, min(100, h)), 2)}
    if has_p:
        out["p"] = round(1013.0 + 6.0 * math.sin(ts / 190000 + seed) + random.gauss(0, 0.15), 2)
    return out


async def run_demo(hub: Hub, interval: int = 5) -> None:
    db = hub.db
    now = time.time()
    if not db.nodes():
        rows = []
        for i, (nid, loc, sensor, bt, bh, hp) in enumerate(DEMO_NODES):
            db.create_node(nid, nid, now - 30 * 86400)
            db.update_node(nid, location=loc, sensor=sensor, fw="1.1.0", model="ESP32-C3",
                           ip=f"192.168.1.{40 + i}", mac=f"A0:76:4E:{nid[-6:-4]}:{nid[-4:-2]}:{nid[-2:]}".upper(),
                           interval=interval, status="online")
            ts = int(now - 30 * 86400)
            while ts < now:
                s = _sample(bt, bh, hp, ts, i)
                rows.append((nid, ts, s["t"], s["h"], s.get("p")))
                age = now - ts  # denser history for the recent past, like a real node
                ts += interval if age < 7200 else 60 if age < 86400 else 600
        db.update_node("murmur-c41d90", t_min=10.0)
        db.update_node("murmur-e7720a", h_max=70.0)
        db.add_readings(rows)

    up0 = time.monotonic()
    while True:
        for i, (nid, _l, _s, bt, bh, hp) in enumerate(DEMO_NODES):
            if db.node(nid) is None:
                continue
            data = _sample(bt, bh, hp, time.time(), i)
            data.update(rssi=random.randint(-72, -48), up=int(time.monotonic() - up0) + 86400 * (i + 1))
            await hub.handle_state(nid, data)
        await asyncio.sleep(interval)
