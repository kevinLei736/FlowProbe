<div align="center">

# FlowProbe

**A multi-protocol network and serial debugging console**

English · [简体中文](README.md)

[![Download latest](https://img.shields.io/github/v/release/kevinLei736/FlowProbeClient?label=download%20latest&style=flat-square)](https://github.com/kevinLei736/FlowProbeClient/releases/latest)

</div>

FlowProbe pulls the connections, send/receive loops, mock servers and API testing you reach for every day into a single desktop app, all following one workflow: **connect → send → receive → observe**.
No more one tool for TCP, another for serial, a third for mocking — and no more lining up timestamps by eye across three windows.

The name says what the tool does: packets **flow** along a link, and the tool drops a **probe** into the middle of it so you can see every frame that passes.

> This repository only publishes installers. **The application UI is in Simplified Chinese.**

---

## Download and install

Grab the newest build from [Releases](https://github.com/kevinLei736/FlowProbeClient/releases/latest):

| Platform | Download | Notes |
|----------|----------|-------|
| Windows x64 | `FlowProbe-Setup-x.y.z.exe` | Installer wizard; pick your own directory, desktop and Start menu shortcuts created automatically |
| macOS (Apple Silicon) | `FlowProbe-x.y.z-arm64.dmg` | Open it and drag the app into **Applications** |
| macOS (Intel) | `FlowProbe-x.y.z-x64.dmg` | Same as above |

`latest.yml` and the `.blockmap` files are the manifest and delta index used by in-app auto-update — **you never need to download them by hand**.

**Already have it installed?** No need to come back here. Open the app and go to **Help → Check for updates**; the new version comes to you.

> If macOS says the developer cannot be verified on first launch, open **System Settings → Privacy & Security** and click **Open Anyway** once. The app ships with an ad-hoc signature — there is no paid Apple Developer certificate behind it.

---

## Modules and available capabilities

Each connection is its own session, and several can run at once without interfering. The tables below list what each module **actually offers**; details follow further down.

### Connection modules

| Module | Transport / role | Send & receive | Timed send | Terminator | Framing | Heartbeat | Auto-reconnect | Multiple peers |
|--------|------------------|:--------------:|:----------:|:----------:|:-------:|:---------:|:--------------:|:--------------:|
| TCP client | Outbound TCP | ✅ | ✅ | ✅ | ✅ | ✅ timed | ✅ exponential backoff | — |
| TCP server | TCP listener | ✅ | ✅ | ✅ | ✅ | — | — | ✅ broadcast / unicast / kick |
| UDP client | Connectionless UDP | ✅ | ✅ | — | — | — | — | ✅ directed / broadcast / multicast |
| UDP server | Bound UDP port | ✅ | ✅ | — | — | — | — | ✅ peers derived from source |
| WebSocket client | ws / wss | ✅ text + binary | ✅ | — | — | ✅ ping/pong | ✅ exponential backoff | — |
| WebSocket server | ws listener, per path | ✅ | ✅ | — | — | ✅ | — | ✅ broadcast / unicast / kick |
| Serial port | Local serial | ✅ | ✅ | ✅ | ✅ | — | ✅ recovers on replug | — |
| MQTT client | mqtt / mqtts / ws / wss | ✅ publish + subscribe | ✅ | — | — | ✅ keep-alive | ✅ | ✅ many subscriptions |
| Modbus master | TCP / RTU / RTU over TCP | ✅ read + write | ✅ polling | — | protocol-defined | — | ✅ | — |
| Modbus slave simulator | TCP / RTU / RTU over TCP | ✅ responds | ✅ values drift | — | protocol-defined | — | — | ✅ many masters |

A dash means the protocol does not offer that item rather than that it is missing: UDP has neither a connection nor packet coalescing, so reconnect and framing do not apply, and WebSocket and MQTT carry their own message boundaries, so appending a terminator would only corrupt the payload.

### Service and testing modules

| Module | Core capability | Available features |
|--------|-----------------|--------------------|
| HTTP mock server | A real local HTTP(S) server standing in for your backend | 8 methods · 4 path matching styles · Query/Header refinement · static / template / script responses · per-route latency · scenario library · proxy pass-through · recording to routes · self-signed HTTPS |
| HTTP API testing | A full API client | Query/Header tables · 4 body types · 3 auth schemes · environment variables · 4 assertion kinds · ordered collection runs · variable chaining · test reports · scheduled monitoring · HAR export · Postman / OpenAPI interop · CLI / CI |

### Analysis and observation modules

| Module | Core capability | Available features |
|--------|-----------------|--------------------|
| Packet timeline | The send/receive stream | 50,000-entry buffer · virtualised rendering · TX/RX colour separation · UTF-8 / HEX / Base64 · keyword filter · connection lifecycle log filterable on its own |
| Protocol parsing templates | Raw bytes to a field table | Field type and length · word order · scale conversion · enum mapping · checksum verification · templates scoped per module |
| Value charts | Fields plotted over time | Line chart · min/max statistics · CSV export |
| Packet diff | Two packets compared | Byte-level HEX annotation · field-level "which field changed" |
| Annotations and bookmarks | Traceable records | Self-contained snapshots (readable even after the session is deleted) · jump back to context · filter by session · Markdown export |
| Record and replay | Reproduce an incident | Save to file · replay with original timing · 0.25×–10× speed |
| Packet history | Local SQLite | Cross-restart search · paging · filter by session and time · CSV export · size and retention policy |
| Global search | One keyword across everything | Packets plus HTTP requests · text and HEX match interchangeably · expand context around a hit |
| Dashboard | Global picture | Throughput · packet-size distribution · session states · mock error rate · response percentiles |
| HAR export | Hand off to other tools | Standard HAR 1.2 from API history, mock logs, or the history database |
| Alerting | Field threshold evaluation | Numeric / status-word / checksum rules · system notifications · disconnect on hit · cooldown debouncing · alert centre timeline · CSV export |

---

## Feature details

### TCP and UDP

Four roles sharing one send area and timeline.

| Role | What you fill in | What it does |
|------|------------------|--------------|
| TCP client | Target host + port | Connect, exchange data, reconnect with exponential backoff, send timed heartbeats |
| TCP server | Listen port (optionally a specific interface) | Accept many clients, unicast per connection or broadcast to all, kick a specific connection |
| UDP client | Target host + port, optional fixed local port | Directed sends, `255` broadcast, multicast join |
| UDP server | Bound port | Derive peers from source addresses on arrival, reply to all or to one, retire idle peers |

**Send area settings**

| Setting | Options | Notes |
|---------|---------|-------|
| Input encoding | UTF-8 / HEX / Base64 | With HEX you can type `AA 01 02`; spaces and newlines are ignored |
| Append terminator | none / CR / LF / CRLF | Offered only for byte-stream protocols |
| Timed send | Millisecond interval | For load testing or keeping a link alive |

**Receiving and framing**: TCP is a byte stream, so what arrives is not necessarily one message as sent. You can frame by **terminator**, **fixed length**, or a **length field**. The rule lives in the session advanced settings and takes effect immediately, with no disconnect required. UDP already has packet boundaries, so no framing is needed.

When a server fails to listen because the port is taken, it does **not** back off and retry — that is usually a configuration problem, and retrying only hides the real reason.

### WebSocket

| Client feature | Notes |
|----------------|-------|
| Address | Full URL, `ws://host:port/path` or `wss://…` |
| Subprotocols | `Sec-WebSocket-Protocol`, comma-separated |
| Custom headers | One `Key: Value` per line; auth tokens usually go here |
| Ping interval | Anything above 0 enables heartbeats, useful for gateways that cut idle connections |
| Auto-reconnect | Exponential backoff, with each failure reason recorded in the connection lifecycle log |
| Frame type | UTF-8 input sends text frames; HEX / Base64 sends binary frames |

The server binds a **port plus a path** (for example `/ws`) and rejects handshakes on other paths; the client list supports unicast, broadcast, and kicking a connection.

### Serial port

| Feature | Options |
|---------|---------|
| Port | Enumerates every available serial port; hit refresh after plugging or unplugging, no restart needed |
| Baud rate | Common presets plus any custom value |
| Data / stop bits | 5/6/7/8 · 1/1.5/2 |
| Parity | none / odd / even / mark / space |
| Flow control | none / RTS-CTS / XON-XOFF |
| Line levels | Explicit RTS / DTR control, which some devices use to reset or enter download mode |
| Recovery | An unplugged cable triggers backoff reconnect, and replugging recovers on its own |

If everything arrives as garbage, switch the display encoding to HEX before deciding whether the baud rate or parity is wrong.

### MQTT client

| Feature | Notes |
|---------|-------|
| Protocol version | 3.1.1 and 5.0 |
| Transports | `mqtt://` · `mqtts://` · `ws://` · `wss://` |
| Connection | Broker address, client ID, username and password, keep-alive seconds, clean session |
| Subscriptions | Wildcards `+` for one level and `#` for many; per-subscription QoS, and each can be paused without deleting it |
| Publishing | Topic, QoS 0/1/2, retain flag |
| Last will | Sent by the broker on an abnormal disconnect, useful for presence detection |

Every message on the timeline carries its topic, so you can filter by topic.

### Modbus master

Three link types: **Modbus TCP**, **Modbus RTU** (serial), and **RTU over TCP** (serial gateway). The point table is independent of the link, so switching transport does not mean re-entering it.

| Point table column | Options / notes |
|--------------------|-----------------|
| Name | For display, e.g. "Unit 1 temperature" |
| Data area | Holding 4x / input 3x registers, coils 0x, discrete inputs 1x |
| Address | Zero-based, matched against the device manual |
| Data type | uint16 / int16 / uint32 / int32 / float32 / float64 / bit |
| Word order | Big-endian / little-endian / word-swapped — get this wrong on multi-word types and you read astronomical numbers |
| Scale and offset | Engineering value = raw × scale + offset, shown with its unit |
| Polling toggle | Disable a single point without deleting it |
| Writing | In-place writes supported |

On link reliability: requests are **queued serially** with a minimum gap so the slave is not overwhelmed; the response timeout is configurable with a retry count; responses whose transaction id does not match are dropped and logged; **adjacent points are merged into batch reads** with a configurable merge window; and exception responses are decoded into a code with a plain-language explanation, tagged on the timeline with a red `E<code>` badge.

### Modbus slave simulator

A master panel can prove what request you sent, but not whether the point table is right — get word order, address offset or scale wrong and you still read a number, just the wrong one. That calls for a slave whose true values you fully control.

| Data area setting | Options / notes |
|-------------------|-----------------|
| Area / start / count | Declares which addresses this device *has*, zero-based |
| Initial value | Filled at startup; bit areas are clamped to 0/1 |
| Read-only | Makes even holding registers and coils reject writes, to exercise the master error path |
| Auto-drift | Ramp / sine / random / bit toggle, with configurable period, bounds and step |
| Unit ID | A mismatch is dropped silently rather than answered with an exception; you can also accept any unit id so one session impersonates a whole bus |

| Fault injection | What it verifies |
|-----------------|------------------|
| Response delay | Whether the master timeout and retry path really works |
| Drop rate | Whether random silence makes the master hang or wrongly mark the device offline |
| Forced exception code | Returns 0x01 / 0x02 / 0x03 / 0x04 / 0x06 to check the master exception message and recovery |

Only declared addresses exist: reading an undeclared address returns exception `0x02 illegal data address` instead of quietly returning 0 — if out-of-range reads answered 0, the classic off-by-one address mistake would be perfectly hidden.

Live values are editable in place (click a bit to flip it, open a register to change it), and values written by the master show up immediately. Editing a data area takes effect at once without dropping connected masters; only link parameters require restarting the listener. The send box also accepts manual writes in the form `holding 5 1234`.
### HTTP mock server

Starts a **real** HTTP(S) server on your machine that answers according to rules you define. Once running, browsers, Postman and real apps can all hit it directly.

| Matching dimension | Options |
|--------------------|---------|
| Method | GET / POST / PUT / DELETE / PATCH / OPTIONS / HEAD / ANY |
| Path | Exact `/api/health` · placeholder `/api/users/:id` · wildcard `/files/*` · regex `re:^/v[0-9]+/ping$` |
| Query | For example `status=ok` |
| Header | For example `x-token: abc` |
| Priority | Rules are ordered and the first match wins |

| Response mode | What it does |
|---------------|--------------|
| Static | Fixed status code, headers and body |
| Template | Placeholders in the body echo request data or generate dynamic values |
| Script | Runs JS in a sandbox for branching, auth checks and stateful counters, returning `{ status, headers, body }` |

Template placeholders:

```
{{path.id}}       path parameter
{{query.page}}    query parameter
{{body.userId}}   request body JSON field (supports a.b.c)
{{header.token}}  request header
{{now}} {{ts}} {{uuid}} {{sequence}} {{randomInt}}
```

**Scenario library**: keep several response sets for the same routes (normal / slow / 500 / auth failure) and switch between them from one dropdown instead of editing each route back and forth — this is the shortcut when the frontend needs to reproduce "what happens on timeout".

**Proxy pass-through and recording to routes**, in four steps:

1. Turn on proxy pass-through and point it at the real backend; unmatched requests are forwarded
2. Exercise the app normally so the request log captures real requests and responses
3. Open "recording to routes", tick the entries worth freezing, and generate routes in bulk — numeric ids in the path become `:id` parameters automatically
4. Turn the proxy off; from now on those endpoints are served locally and development continues even when the backend is down

**HTTPS**: ticking it generates a self-signed certificate, or you can supply your own pair; the certificate panel shows validity dates, SANs and whether the private key matches. Trusting a self-signed certificate on a phone still requires installing a root certificate, which is an OS-level constraint.

Also available: a fixed delay per route to reproduce slow endpoints; a request log filterable by path, method and status code with HAR export; and a listen panel where the address and port can be changed at any time without recreating the session. It defaults to `0.0.0.0` (reachable from the machine and the LAN); switch to `127.0.0.1` for local-only access. The panel lists the machine's LAN addresses, and a firewall hint appears when remote access still fails.

### HTTP API testing

| Request feature | Options |
|-----------------|---------|
| Method and URL | All common methods |
| Query / headers | Key-value tables with per-row enable |
| Body | JSON / form / raw text / none |
| Auth | Bearer token · Basic · API key (header or query) |
| Variables | Extract `baseUrl` and `token` into variables referenced as `{{baseUrl}}`; switching environment swaps the whole set |
| Response view | Body (with JSON formatting) · headers · duration · size |
| History | Every request and response summary is kept and can be refilled and resent in one click |

| Assertion type | Notes |
|----------------|-------|
| Status code | Equals, or belongs to a set |
| Response time | Below a threshold |
| JSON field value | Compared by path |
| Contains text | Body contains a given string |

**Collections and batch runs**: store a group of requests as an ordered collection and run it in one click; fields from an earlier response can be extracted into variables for later steps (log in, take the token, then call business endpoints); the run produces a report with each assertion result, timing and failure reason, which you can export.

**Scheduled monitoring**: a collection can run on a schedule and raise a system notification when an assertion fails. The scheduler lives in the app shell, so it **keeps running after you close the panel**.

**Collection interop**: Postman Collection v2.1 and OpenAPI 3.x in both directions. Importing Postman keeps nested folders, query and header tables, the three auth schemes, and JSON or form bodies. Importing OpenAPI turns `paths` into requests, converts path parameters to `{{variables}}`, and generates a sendable JSON example from the schema. Export produces either a Postman collection or an OpenAPI 3.0 contract skeleton. Imports append to the current collection and never overwrite requests you have already tuned.

**CLI / CI**: run a collection headlessly and report the result through the exit code.

```bash
FlowProbe.exe --run-collection ./collection.json \
  --env ./env.json --env-name local \
  --report ./report.json --delay 200 --stop-on-fail
```

| Option | Meaning |
|--------|---------|
| `--run-collection` | Collection file: FlowProbe JSON, a bare array, Postman, or OpenAPI |
| `--env` / `--env-name` | Environment file and the environment to pick; a flat `{ "baseUrl": "..." }` object also works |
| `--report` | Write a machine-readable JSON report with status, timing, assertions and extracted values |
| `--delay` | Delay between steps in milliseconds |
| `--stop-on-fail` | Skip remaining steps after a failure |

Exit codes: `0` all passed, `1` at least one failure, `2` bad arguments or files.

> The packaged Windows build is a GUI executable, so some terminals show no live output. Trust the exit code and always pass `--report` to read the full result.

### Packet analysis

| Capability | Available features |
|------------|--------------------|
| Protocol parsing templates | Declare field name, type, length and word order in order and packets expand into a field table; supports scale conversion, enum mapping (`0=stopped 1=running`) and checksum verification; templates are scoped per module, so address-oriented templates only appear under Modbus |
| Value charts | Plot parsed numeric fields over time with min/max statistics and CSV export |
| Packet diff | Tick two packets for a byte-level diff: the HEX view marks differing byte positions, and the field view tells you outright which field changed |
| Annotations and bookmarks | Star any timeline row and add a note about *why* it is suspicious; the entry stores a self-contained snapshot (time, direction, bytes, HEX excerpt, your note) that still makes sense after clearing, restarting, or deleting the session; while the session still exists you can jump back for context; filter by session and export as Markdown |
| Record and replay | Save a stretch of traffic to a file and replay it with the original timing at 0.25×–10× speed, turning a once-in-a-while incident into a repeatable case |

### Alerting and monitoring

| Feature | Notes |
|---------|-------|
| Rule targets | Fields produced by parsing templates: temperature > 80, status word ≠ 0, checksum mismatch… |
| On hit | Highlights the packet row and raises a system notification |
| Disconnect on hit | Optionally drop the session so the scene is preserved and later packets do not flush the buffer |
| Cooldown | Each rule has a cooldown so dozens of frames per second do not spam notifications |
| Alert centre | Packet alerts and failed monitoring runs merge into one timeline with source session, trigger explanation and the packet snapshot from that moment; exportable as CSV |

Rules load at application startup rather than when you first open the alert centre — otherwise the first packets after a restart would be silently skipped against an empty rule table.

### History, search and dashboard

| Feature | Notes |
|---------|-------|
| Packet history | Packets and HTTP requests land in a local database that outlives the app; page through them, filter by session and time, export CSV |
| Global search | One keyword sweeps every stored packet and request, matching text and HEX interchangeably (searching `4142` also finds `AB`) |
| Context view | A hit can expand the packets around it without jumping back to the session first |
| Dashboard | Global throughput, packet-size distribution, session states, mock error rate and response percentiles on one screen |
| Size management | The history database has a cap and retention policy, adjustable in settings, plus manual per-session clearing |

### Workspace and data

| Feature | Notes |
|---------|-------|
| Auto-save | Sessions, groups and tags, layout, theme and templates all save themselves and return as they were |
| Import and export | **File → Export configuration** writes the whole workspace to one file for moving machines or sharing with a colleague |
| Open data directory | Jump straight to the workspace and history database directories for backup or migration |
| Groups and tags | Collapse sessions into groups and filter across multiple tags, from the left pane or the command palette |
| Auto-connect | A session can connect itself when the app starts |
| Single instance | Launching again activates the existing window instead of opening a second one — two processes would fight over the same database and the same ports |
| Small tools | Checksums, radix conversion, timestamp conversion |
| Built-in manual | `F1` opens a seventeen-chapter manual (in Chinese) with full-text search, chapter navigation and Markdown export, fully offline |

### Auto-update

Found under **Help → Check for updates**. There is no server address to fill in: the update endpoint is fixed at build time inside the installer, so it works the moment you install, and downloads are anonymous with no account or token involved.

| Switch | Default | Notes |
|--------|---------|-------|
| Check once after launch | On | Checks in the background about 8 seconds in, so it does not compete with restoring sessions and opening listen ports |
| Download automatically when found | Off | Installing requires a restart, and a restart drops live connections, so the timing is left to you |

When an update exists the **Help** menu item itself reads "new version available", and "ready to install" once downloaded, so you do not have to open the panel to find out. Failures are classified in plain language: the publisher has no release yet, the manifest is missing, or this machine cannot reach the update server.

---

## Handy shortcuts

| Keys | Action |
|------|--------|
| `Ctrl+K` | Command palette (search sessions and commands) |
| `Ctrl+N` | New connection |
| `Ctrl+Enter` | Send the current packet |
| `Ctrl+F` | Global search across stored packets |
| `Ctrl+H` / `Ctrl+D` / `Ctrl+M` | Packet history / dashboard / annotations |
| `Ctrl+B` / `Ctrl+J` | Show or hide the left / right pane |
| `Ctrl+\` | Side-by-side split |
| `Ctrl+Shift+D` | Packet diff |
| `Ctrl+R` / `Ctrl+L` | Reconnect the current session / clear the timeline |
| `Ctrl+Tab` | Switch tabs (add `Shift` to go backwards) |
| `F1` / `Ctrl+/` | Manual / shortcut reference |

On macOS, read `Ctrl` as `⌘`. The full list lives under **Help → Shortcuts** in the app.

---

## Where your data lives

Everything stays on your machine. Nothing is uploaded to any server.

| Platform | Location |
|----------|----------|
| Windows | `%APPDATA%\flowprobe\` |
| macOS | `~/Library/Application Support/flowprobe/` |

That directory holds the workspace config `workspace.json`, the packet history database `history.db`, and generated self-signed certificates.
**File → Open workspace directory** jumps you straight there for backup or migration.

Upgrading from 1.18.0 or earlier copies the data directory from `debug-toolbox` to `flowprobe`. It is a copy, not a move, so the old directory stays intact and you can reinstall the old version if you need to.

---

## Troubleshooting

| Symptom | Check this first |
|---------|------------------|
| TCP / WebSocket will not connect | Wrong host or port, nothing listening on the other end, or the local firewall blocking it. The connection lifecycle log records the failure reason for every attempt |
| A server fails to start | The port is taken by another program, or it is a privileged port below 1024. Pick a higher one |
| Everything arrives as garbage | Switch the display encoding to HEX. On serial, suspect baud rate and parity first; on network links, suspect that the peer speaks a binary protocol |
| No devices in the serial port list | Hit refresh next to the port dropdown to re-enumerate; confirm the driver is installed, the cable is seated, and no other serial tool holds the port |
| A phone cannot reach the local mock | Open "Listen settings" and confirm the address is `0.0.0.0` rather than `127.0.0.1`. The same panel lists the LAN address to use, and a firewall rule must allow the port |
| Modbus readings are astronomically large | Almost always a word-order or data-type mismatch. Use the slave simulator to serve a known value and reconcile against it |
| Update check says the publisher has not enabled updates | You are on 1.20.0 or earlier, which shipped without an update endpoint. Install the new version manually once and auto-update takes over from there |

Press `F1` in the app for the full manual.
