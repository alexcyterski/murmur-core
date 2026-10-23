# MQTT protocol

These are the topics and messages that murmur-core and [murmur-node](https://github.com/alexcyterski/murmur-node)
use to talk to each other. Any device that follows them shows up on the dashboard.

`<base>` is the topic root (default `murmur`). `<id>` is the node ID, for example `murmur-a1b2c3`, made from the last three bytes of the node's MAC address.

| Topic | Direction | Retained | Payload |
|---|---|:-:|---|
| `<base>/<id>/state` | node → core | | `{"t":21.42,"h":44.10,"p":1012.61,"rssi":-58,"up":3600,"heap":181234}` |
| `<base>/<id>/status` | node → core | ✓ | `online` / `offline` (also the MQTT last will) |
| `<base>/<id>/info` | node → core | ✓ | `{"name","sensor","fw","model","ip","mac","ssid","interval","led"}` |
| `<base>/<id>/config` | core → node | ✓ | `{"interval":30,"led":true,"name":"Bedroom"}` |
| `<base>/<id>/cmd` | core → node | | `{"action":"identify" \| "read" \| "reboot"}` |

- **State fields:**
  - Units are always °C (`t`), %RH (`h`) and hPa (`p`). Leave out any value the sensor doesn't measure.
  - When a read fails, include `"err": "<reason>"`.
  - Core applies unit conversion and calibration offsets. It drops values outside -60–125 °C, 0–100 %RH or 300–1200 hPa.
- **Config:**
  - Because `config` is retained, a node gets its current settings every time it connects.
  - `interval` is in seconds, from 2 to 3600.
- **Forgetting a node:** core deletes the node's history and clears its retained `config`, `info` and `status` topics.
  A node that is still powered will register again the next time it reports.
