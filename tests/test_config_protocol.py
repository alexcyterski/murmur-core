"""Regression checks for configuration recovery and the firmware's MQTT contract."""
import asyncio
import importlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx

from app.db import Database
from app.hub import Hub


class ConfigProtocolTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        with patch.dict(os.environ, {"DATA_DIR": cls.temp.name}):
            cls.main = importlib.import_module("app.main")
        cls.main.db._conn.close()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    async def asyncSetUp(self):
        self.db = Database(":memory:")
        self.addCleanup(self.db._conn.close)
        self.hub = Hub(self.db, "home/murmur")
        self.sent = []
        self.patches = patch.multiple(self.main, db=self.db, hub=self.hub)
        self.patches.start()
        self.addCleanup(self.patches.stop)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.main.app), base_url="http://test"
        )
        self.addAsyncCleanup(self.client.aclose)
        await self.info(name="Bedroom", interval=30, led=True)

    async def info(self, **data):
        await self.hub.on_message("home/murmur/test/info", json.dumps(data).encode())

    async def publish(self, topic, payload, retain):
        self.sent.append((topic, json.loads(payload) if payload else None, retain))

    async def edit(self, **data):
        response = await self.client.patch("/api/nodes/test", json=data)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_offline_edit_survives_restart_and_stale_info(self):
        result = await self.edit(interval=60, led=False, name="New name")
        self.assertFalse(result["pushed"])
        # Reopen the persisted database, not merely a new Hub using the same connection.
        path = str(Path(self.temp.name) / "restart.db")
        disk = Database(path)
        self.db._conn.backup(disk._conn)
        disk._conn.close()
        disk = Database(path)
        self.addCleanup(disk._conn.close)
        restarted = Hub(disk, "home/murmur")
        await restarted.handle_info("test", {"name": "Bedroom", "interval": 30, "led": True})
        self.assertEqual(disk.node("test")["interval"], 60)
        self.assertEqual(disk.node("test")["name"], "New name")
        self.assertEqual(disk.node("test")["led"], 0)
        restarted.publisher = self.publish
        await restarted.set_mqtt_state(True)
        self.assertEqual(self.sent, [
            ("home/murmur/test/config", {"interval": 60, "led": False, "name": "New name"}, True)
        ])
        self.sent.clear()
        await restarted.handle_info("test", {"name": "New name", "interval": 60, "led": False})
        self.assertEqual(self.sent, [])  # a matching report doesn't create a publish loop

    async def test_failed_publish_retries_and_edits_merge(self):
        async def unavailable(*args):
            raise OSError("broker unavailable")
        self.hub.publisher = unavailable
        self.assertFalse((await self.edit(interval=60))["pushed"])
        await self.edit(led=False)
        self.hub.publisher = self.publish
        await self.hub.set_mqtt_state(True)
        self.assertEqual(self.sent[-1][1], {"interval": 60, "led": False})
        self.assertIs(self.sent[-1][1]["led"], False)

    async def test_only_edited_fields_are_core_owned(self):
        await self.edit(interval=60)
        self.hub.publisher = self.publish
        await self.info(name="Locally renamed", interval=30, led=False, ip="192.168.1.20")
        node = self.db.node("test")
        self.assertEqual(node["name"], "Locally renamed")
        self.assertEqual(node["led"], 0)
        self.assertEqual(node["ip"], "192.168.1.20")
        self.assertEqual(node["interval"], 60)
        self.assertEqual(self.sent[-1], ("home/murmur/test/config", {"interval": 60}, True))

    async def test_local_settings_do_not_create_mqtt_overrides(self):
        self.assertIsNone((await self.edit(location="Upstairs", t_off=1))["pushed"])
        self.hub.publisher = self.publish
        await self.hub.set_mqtt_state(True)
        self.assertEqual(self.sent, [])
        self.assertEqual(self.db.desired_config("test"), {})

    async def test_overlapping_edits_publish_latest_config_last(self):
        started, release = asyncio.Event(), asyncio.Event()

        async def slow_publish(*args):
            if not started.is_set():
                started.set()
                await release.wait()
            await self.publish(*args)

        self.hub.publisher = slow_publish
        first = asyncio.create_task(self.edit(interval=60))
        await asyncio.wait_for(started.wait(), 2)
        second = asyncio.create_task(self.edit(interval=120))
        release.set()
        await asyncio.wait_for(asyncio.gather(first, second), 2)
        self.assertEqual(self.sent[-1][1], {"interval": 120})

    async def test_forgetting_removes_overrides(self):
        await self.edit(interval=60)
        self.hub.publisher = self.publish
        response = await self.client.delete("/api/nodes/test")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.db.desired_config("test"), {})
        self.assertEqual([topic.rsplit("/", 1)[1] for topic, _, _ in self.sent], ["config", "info", "status"])
        self.sent.clear()
        await self.info(name="Fresh", interval=30, led=True)
        await self.hub.set_mqtt_state(True)
        self.assertEqual(self.db.node("test")["interval"], 30)
        self.assertEqual(self.sent, [])

    async def test_forget_waits_for_inflight_config_before_clearing_retained(self):
        started, release = asyncio.Event(), asyncio.Event()

        async def slow_publish(topic, payload, retain):
            if payload:
                started.set()
                await release.wait()
            await self.publish(topic, payload, retain)

        self.hub.publisher = slow_publish
        edit = asyncio.create_task(self.edit(interval=60))
        await asyncio.wait_for(started.wait(), 2)
        forget = asyncio.create_task(self.hub.forget("test"))
        release.set()
        await asyncio.wait_for(asyncio.gather(edit, forget), 2)
        configs = [payload for topic, payload, _ in self.sent if topic.endswith("/config")]
        self.assertEqual(configs, [{"interval": 60}, None])
        self.assertIsNone(self.db.node("test"))

    async def test_nested_topic_and_firmware_payloads(self):
        await self.hub.on_message("home/murmur/test/state", b'{"t":21.42,"h":44.1,"p":1012.61,"rssi":-58,"up":3600,"heap":181234}')
        node = self.db.node("test")
        self.assertEqual((node["last_t"], node["last_h"], node["last_p"]), (21.42, 44.1, 1012.61))
        await self.hub.on_message("home/murmur/test/status", b"offline")
        self.assertFalse(self.hub.view(self.db.node("test"))["online"])
        await self.hub.on_message("home/murmur/test/status", b"online")
        self.assertTrue(self.hub.view(self.db.node("test"))["online"])

    async def test_bad_topics_and_payloads_do_not_discover_nodes(self):
        for topic in ("home/murmur-other/bad/info", "home/murmur/bad/info/extra", "home/murmur//info", "home/murmur/bad\n/info"):
            await self.hub.on_message(topic, b'{"name":"Bad"}')
        for payload in (b"", b"{", b"[]", b"null"):
            await self.hub.on_message("home/murmur/bad/info", payload)
        await self.hub.on_message("home/murmur/bad/status", b"unexpected")
        self.assertEqual([n["id"] for n in self.db.nodes()], ["test"])
        # Non-finite metadata must not abort processing subsequent messages.
        await self.info(interval="inf", led="false")
        self.assertEqual(self.db.node("test")["interval"], 30)
        self.assertEqual(self.db.node("test")["led"], 1)

    async def test_names_and_interval_boundaries(self):
        self.hub.publisher = self.publish
        for name in ("A" * 48, "é" * 48, "🐦" * 48):
            result = await self.edit(name=name)
            self.assertEqual(result["node"]["name"], name)
            self.assertEqual(self.sent[-1][1]["name"], name)
        for interval in (2, 3600):
            await self.edit(interval=interval)
            self.assertEqual(self.sent[-1][1]["interval"], interval)
        for data in ({"name": "A" * 49}, {"name": "é" * 49}, {"interval": 1}, {"interval": 3601}):
            response = await self.client.patch("/api/nodes/test", json=data)
            self.assertEqual(response.status_code, 422)

    async def test_commands_are_not_retained(self):
        self.hub.publisher = self.publish
        for action in ("identify", "read", "reboot"):
            response = await self.client.post("/api/nodes/test/command", json={"action": action})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.sent[-1], ("home/murmur/test/cmd", {"action": action}, False))

    def test_base_topic_validation_and_normalization(self):
        self.assertEqual(Hub(self.db, " /home/murmur/ ").base, "home/murmur")
        for base in ("", "/", "home/+", "home/#", "home/\x00"):
            with self.assertRaises(ValueError):
                Hub(self.db, base)

    def test_existing_database_upgrade_preserves_nodes_and_history(self):
        path = str(Path(self.temp.name) / "upgrade.db")
        old = Database(path)
        old.create_node("legacy", "Bedroom", 100)
        old.add_reading("legacy", 100, 21, 40, None)
        old._conn.execute("DROP TABLE node_config")
        old._conn.close()
        upgraded = Database(path)
        self.addCleanup(upgraded._conn.close)
        self.assertEqual(upgraded.node("legacy")["name"], "Bedroom")
        self.assertEqual(upgraded.stats("legacy", 0)["count"], 1)
        upgraded.patch_node("legacy", interval=60)
        self.assertEqual(upgraded.desired_config("legacy"), {"interval": 60})


if __name__ == "__main__":
    unittest.main()
