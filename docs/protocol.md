# MQTT protocol

These are the topics and messages that murmur-core and [murmur-node](https://github.com/alexcyterski/murmur-node)
use to talk to each other. Any device that follows them shows up on the dashboard.

`<base>` is the topic root (default `murmur`); nested roots such as `home/murmur` are supported. Leading/trailing slashes are removed during configuration. Roots cannot contain MQTT wildcards (`+`, `#`) or NUL. `<id>` is the node ID, for example `murmur-a1b2c3`, made from the last three bytes of the node's MAC address. IDs contain 1–48 ASCII letters, digits, underscores or hyphens.

| Topic | Direction | Retained | Payload |
|---|---|:-:|---|
| `<base>/<id>/state` | node → core | | `{"t":21.42,"h":44.10,"p":1012.61,"rssi":-58,"up":3600,"heap":181234}` |
| `<base>/<id>/status` | node → core | ✓ | `online` / `sleeping` / `offline` (last will is `offline`) |
| `<base>/<id>/info` | node → core | ✓ | `{"name","sensor","fw","model","ip","mac","ssid","interval","led","battery"}` |
| `<base>/<id>/config` | core → node | ✓ | `{"interval":300,"led":true,"name":"Bedroom","battery":true}` |
| `<base>/<id>/cmd` | core → node | | `{"action":"identify" \| "read" \| "reboot"}` |

- **State fields:**
  - Units are always °C (`t`), %RH (`h`) and hPa (`p`). Leave out any value the sensor doesn't measure.
  - When a read fails, include `"err": "<reason>"`.
  - Core applies unit conversion and calibration offsets. It drops values outside -60–125 °C, 0–100 %RH or 300–1200 hPa.
- **Config:**
  - All fields are optional. A node leaves omitted settings unchanged.
  - Core persists dashboard edits as desired overrides in SQLite before publishing. Only edited fields become core-owned; other fields continue to follow the node's `info` reports.
  - Because `config` is retained, a node gets its overrides every time it connects. Core republishes them whenever it reconnects to the broker, and when `info` reports different values. This also recovers from broker persistence loss.
  - Nodes publish updated `info` after applying a change. Matching reports need no further config publish. There are no revision numbers or separate acknowledgment topics.
  - `name` is at most 48 Unicode characters (UTF-8 on the wire); firmware truncates longer names at a character boundary. Older firmware may still truncate names to 32 bytes.
  - `interval` is in seconds, from 2 to 3600.
  - `led` is a JSON boolean.
  - `battery` is a JSON boolean, default `false`. Firmware supporting battery mode always includes this field in `info`, even when disabled. Core leaves the control unavailable for nodes that have not advertised it.
  - A successful API `pushed` result means the broker accepted the config, not that the node has already applied it. Command success likewise confirms publication, not execution.
- **Battery mode:**
  - The node wakes, receives retained config, reports, publishes retained `sleeping`, then gracefully disconnects and deep-sleeps for `interval` seconds. Wake/connect time adds to report spacing. Automatic failed wake cycles return to sleep; the failure retry delay is at least 300 seconds.
  - `sleeping` describes intentional unavailability, not a fault. Core's `online` API field continues to indicate fresh reports; `sleeping` is true only while that freshness check passes. Neither retained `sleeping` nor retained `online` refreshes `last_seen`.
  - Core uses the larger of desired and last reported intervals for freshness, so a queued interval reduction does not mark the node overdue prematurely. Battery/sleeping nodes receive 75 seconds of wake overhead in addition to the usual three-interval allowance, or the configured `offline_after`, whichever is longer.
  - Commands stay non-retained; core rejects them with HTTP 409 while the last reported status is `sleeping`. Configuration remains retained and applies at a later wake. Pressing RESET opens a five-minute awake maintenance window; BOOT extends it while awake.
- **Forgetting a node:** core deletes the node's history and clears its retained `config`, `info` and `status` topics.
  A node that is still powered will register again the next time it reports.

Core creates its desired-config table automatically on upgrade. Overrides are recorded by dashboard/API edits made with this version; previously saved settings are not retroactively marked as core-owned.
