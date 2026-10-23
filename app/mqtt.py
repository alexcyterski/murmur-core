"""MQTT bridge: keeps a persistent broker connection and feeds the hub."""
from __future__ import annotations

import asyncio
import logging

import aiomqtt

from .hub import Hub

log = logging.getLogger("murmur.mqtt")


class MqttBridge:
    def __init__(self, hub: Hub, host: str, port: int, username: str | None, password: str | None):
        self.hub = hub
        self.host = host
        self.port = port
        self.username = username or None
        self.password = password or None
        self._client: aiomqtt.Client | None = None
        hub.publisher = self.publish

    async def publish(self, topic: str, payload: str, retain: bool = False) -> None:
        if self._client is None:
            raise RuntimeError("MQTT broker not connected")
        await self._client.publish(topic, payload, qos=1, retain=retain)

    async def run(self) -> None:
        base = self.hub.base
        backoff = 2
        while True:
            try:
                async with aiomqtt.Client(
                    hostname=self.host,
                    port=self.port,
                    username=self.username,
                    password=self.password,
                    identifier="murmur-core",
                    keepalive=30,
                ) as client:
                    self._client = client
                    backoff = 2
                    log.info("connected to mqtt://%s:%d", self.host, self.port)
                    await self.hub.set_mqtt_state(True)
                    for kind in ("state", "status", "info"):
                        await client.subscribe(f"{base}/+/{kind}", qos=1)
                    async for msg in client.messages:
                        try:
                            await self.hub.on_message(msg.topic.value, bytes(msg.payload or b""))
                        except Exception:
                            log.exception("failed to handle %s", msg.topic.value)
            except aiomqtt.MqttError as exc:
                log.warning("mqtt connection lost (%s); retrying in %ds", exc, backoff)
            finally:
                if self._client is not None:
                    self._client = None
                    await self.hub.set_mqtt_state(False)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)
