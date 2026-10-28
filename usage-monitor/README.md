# usage-monitor API

Local service that stores usage events sent by the `usage-monitor` Claude Code mod
([install it from its README](https://github.com/jommar/mods/blob/master/usage-monitor/README.md)) in SQLite and serves a small
web dashboard. To set it up go to [Prerequisites](#prerequisites) and [Install](#install); when something stays
quiet, see [Troubleshooting](#troubleshooting).

The mod POSTs events and never reads anything back. The mod's own pane and status
line keep working with the API off, down or unconfigured.

## Run

```bash
node src/server.ts          # Node >= 24 runs .ts directly; node:sqlite is built in; no dependencies
npm test                    # tests; a bare `node --test` also collects web/'s own test files and exits 1
```

| Env | Default | Meaning |
| --- | --- | --- |
| `USAGE_MONITOR_SOCKET` | `$XDG_RUNTIME_DIR/usage-monitor.sock` | Unix socket the API listens on, mode `0600`. It serves everything, and it is the only place that accepts ingest. Its directory must be one only you can write to, such as `$XDG_RUNTIME_DIR`: owned by you, not writable by group or others (a shared one like `/tmp` would let another user bind the path first and receive every event). Otherwise the API refuses to start, with a one-line message, before it opens the database. With neither this nor `XDG_RUNTIME_DIR` set it stops with a one-line message too. |
| `USAGE_MONITOR_PORT` | unset (no TCP listener) | Opt-in loopback TCP port, an integer from 1 to 65535, so a browser can reach the dashboard. It listens on `127.0.0.1` only and serves the dashboard and the read API with `GET`/`HEAD` (everything else, `POST /events` included, is `404`). Any other value stops the start with a one-line error; a port that is already taken only logs a warning and the socket keeps serving. |
| `USAGE_MONITOR_DB` | `<project>/data/usage.db` | SQLite file (WAL, busy timeout 5 s), set to mode `0600` when opened. Only the API opens it. |

## Ingest contract (v1): the mod and the API both implement this

`POST /events`, `Content-Type: application/json`, body at most 1 MiB:

```json
{ "events": [ { "...": "Event" } ] }
```

1 to 500 events per batch. `201 {"accepted": n, "duplicates": m}` on success.
`400 {"error": "..."}` if any event is invalid: the whole batch is rejected and nothing is stored.
`413` over the size limit.

Every event has: `id` (string, 1-64 chars, unique per event; an `id` already stored is ignored and
counted as a duplicate, so a retried batch is safe), `v` (the number `1`), `type`, `session`
(string, 1-64 chars), `ts` (integer from 0 to 253402300799999, milliseconds since epoch: 1970-01-01 to the end of year 9999, the range of the UTC `day` the summary reports).

| `type` | extra fields |
| --- | --- |
| `usage` (one per model request) | `agent` (string 1-64; `"main"` for the main thread, else the subagent id), `model` (string 1-100), `input`, `output`, `cacheRead`, `cacheWrite` (non-negative integers), `costUsd` (number >= 0, or `null` when the model has no list price) |
| `tool` (one per tool call) | `agent`, `tool` (string 1-200) |
| `agent` (a subagent was spawned or labelled) | `agent`, `label` (string 0-300), `model` (string 0-100, optional) |
| `session` | `state` (`"start"`, `"end"` or `"clear"`), `cwd` (string 0-4096, optional) |

Unknown `type`, a missing field or a wrong type is invalid. Unknown extra fields are ignored.

## Read API (used by the dashboard)

| Route | Answers |
| --- | --- |
| `GET /health` | `200 ok` |
| `GET /api/sessions?limit=50` | `[{ session, startedTs, lastTs, cwd, requests, tools, input, output, cacheRead, cacheWrite, costUsd, models }]` (`models`: the models its requests used, most requests first), ordered by `lastTs` (last activity), newest first, ties by `startedTs`, then `session` (`limit` 1-500, default 50) |
| `GET /api/sessions/:id` | the same totals except `tools`, plus `agents: [{ agent, label, model, requests, tools, input, output, cacheRead, cacheWrite, costUsd }]` and `tools: [{ tool, count }]` (here `tools` is the list; the total is the sum of its counts); `404` if unknown |
| `GET /api/summary?from=<ms>&to=<ms>` | `{ byDay: [{ day, requests, tools, input, output, cacheRead, cacheWrite, costUsd }], byModel: [{ model, requests, input, output, cacheRead, cacheWrite, costUsd }] }`; `day` is a UTC `YYYY-MM-DD`; `from`/`to` optional |
| `GET /api/tools?from=<ms>&to=<ms>&limit=200` | `{ byTool: [{ tool, count }], calls: [{ ts, tool, session, agent, label, cwd, detail }] }`: calls per tool (most first, ties by name) and each call newest first (`limit` 1-1000 caps `calls` only, default 200); `detail` is the mod's short, redacted summary of the call's input (null when none was sent) |
| `GET /` and any other file of the build | the dashboard, served from `web/dist/` (see Install) |

`costUsd` is the sum of the events' non-null `costUsd`, or `null` when none of them has one. That holds for every total that carries it (a session, an agent, a day, a model), so a session that has no usage events at all has `costUsd: null`, and a total of `0` means the requests were priced at zero.

## Prerequisites

- **Node.js 24 or later** (`node --version`). It runs the `.ts` files directly and provides `node:sqlite`; the API
  itself has no dependencies.
- **npm**, only to build the dashboard in `web/`.
- **Linux with a systemd user session** (`systemctl --user status` works), to run it as a service. A user service
  starts at login; to start it at boot with nobody logged in, run `loginctl enable-linger $USER` once.
- **The mod**, installed with `/plugin install usage-monitor --marketplace jommar/mods` ([its README](https://github.com/jommar/mods/blob/master/usage-monitor/README.md)).

## Install

The unit expects the code at `~/.claude/api/usage-monitor` (its `ExecStart` uses `%h/.claude/api/usage-monitor`).
Clone this repository into `~/.claude/api` to put it there (`git clone https://github.com/jommar/api ~/.claude/api`);
if it lives somewhere else, change that path in `deploy/usage-monitor.service` as well. Then, from the `usage-monitor`
folder:

1. **Build the dashboard.** It is a separate app in `web/` (its own `package.json`); the API serves its build output
   from `web/dist/`. Without a build, `GET /` answers with a short "Dashboard not built yet" page and the rest of
   the API still works.

   ```bash
   cd ~/.claude/api/usage-monitor
   (cd web && npm install && npm run build)
   ```

2. **Point the unit at your Node.** `ExecStart` holds an absolute path to `node` (a systemd user service does not
   see nvm's `PATH`), and the copy in this folder has the path of the machine it was written on. Set it to yours
   before the first start; otherwise the service fails with `status=203/EXEC` and nothing else shows it:

   ```bash
   sed -i "s#^ExecStart=[^ ]*#ExecStart=$(command -v node)#" deploy/usage-monitor.service
   ```

3. **Install and start the service.**

   ```bash
   mkdir -p ~/.config/systemd/user
   ln -s ~/.claude/api/usage-monitor/deploy/usage-monitor.service ~/.config/systemd/user/usage-monitor.service
   systemctl --user daemon-reload && systemctl --user enable --now usage-monitor
   ```

4. **Check it.** `curl --unix-socket "$XDG_RUNTIME_DIR/usage-monitor.sock" http://usage-monitor/health` prints `ok`, and
   the dashboard is at http://127.0.0.1:7842/ (the unit sets `USAGE_MONITOR_PORT=7842`). The socket is
   `$XDG_RUNTIME_DIR/usage-monitor.sock` (the unit sets it through `%t`) and the database is `data/usage.db` in
   this folder.

5. **Turn the mod on** ([below](#turn-the-mod-on)). Until then the dashboard says "No usage recorded yet".

### After a node upgrade

The `ExecStart` path points at one specific node version. After an upgrade, or when you switch versions with nvm,
repeat the `sed` line from step 2, then run `systemctl --user daemon-reload && systemctl --user restart usage-monitor`
and check `systemctl --user status usage-monitor`: with a path that no longer exists the unit fails with `status=203/EXEC`,
and nothing else shows it (the mod drops what it cannot send, without an error).

### The unit's hardening

The unit sets `UMask=0077` (new files are owner-only), `NoNewPrivileges=yes`, `LockPersonality=yes` and
`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` (the socket and the loopback port are all it uses). It deliberately
does not set `ProtectSystem`, `PrivateTmp` or `MemoryMax`: whether this user manager supports them is not established,
and a unit that fails to start takes the running service down. Add them only after trying them on a copy of the unit.

### Turn the mod on

The service alone receives nothing: the mod reports only once it is given the socket, and until then it stays silent.
Give the mod the **absolute** socket path, `/run/user/<uid>/usage-monitor.sock` (`id -u` prints your uid; environment
variables such as `$XDG_RUNTIME_DIR` are not expanded there). For a mod installed from the marketplace, run
`/plugin configure usage-monitor@jommar-mods` in Claude Code; it is stored as
`pluginConfigs["usage-monitor@jommar-mods"].options.apiSocket` in `settings.json`. A mod loaded from a folder
(`--plugin-dir`) has it in the `/config` menu as "API socket", under the key `usage-monitor@inline`.
The mod loads the new value when it reloads, so start a new session after changing it.

Check it: send one prompt in that new session, then

```bash
curl --unix-socket /run/user/$(id -u)/usage-monitor.sock http://usage-monitor/api/sessions
```

lists the session (and it shows up on the dashboard). If the session is not there, the setting did not take: check the path and that the session started after the change.

## Updating

| You changed | Do |
| --- | --- |
| the API (`src/`, `schema.sql`) | `systemctl --user restart usage-monitor` (the mod retries what it could not send meanwhile) |
| the dashboard (`web/`) | `cd web && npm install && npm run build`; the API serves the new files at once, no restart |
| the unit (`deploy/usage-monitor.service`) | `systemctl --user daemon-reload && systemctl --user restart usage-monitor` |
| the mod | it takes effect when the mod reloads: start a new session |

The schema is version 1 and there is no migration step yet (see [Known limits](#known-limits)).

## Uninstall

```bash
systemctl --user disable --now usage-monitor
rm ~/.config/systemd/user/usage-monitor.service && systemctl --user daemon-reload
```

Then clear the mod's "API socket" setting; the mod keeps working without it. The recorded history lives in `data/`;
delete it (`rm -r ~/.claude/api/usage-monitor/data`) only if you want to drop it.

## Troubleshooting

Start with `systemctl --user status usage-monitor` and `journalctl --user -u usage-monitor -n 50`.

| Symptom | Cause and fix |
| --- | --- |
| Service fails with `status=203/EXEC` | The Node path in the unit does not exist: step 2 of [Install](#install). |
| Log: `the socket directory ... is owned by uid ... with mode ...` | The socket must live in a folder only you can write to (owned by you, not writable by group or others). Use the default under `$XDG_RUNTIME_DIR`, or a private folder of your own. |
| Log: `... is already in use by another process` | Another copy holds the socket, for example a `node src/server.ts` started by hand beside the service. Stop it. |
| Log: `cannot listen on 127.0.0.1:<port>` | The dashboard port is taken. Ingest keeps working, but the dashboard is down: change `USAGE_MONITOR_PORT` in the unit, then `daemon-reload` and restart. |
| Browser: "Dashboard not built yet" | Step 1 of [Install](#install). |
| Browser: "Can't reach the usage API" | The service is down, or the unit has no `USAGE_MONITOR_PORT` line (then there is no TCP listener at all). |
| Browser: `403` or `421` | Open exactly `http://127.0.0.1:7842/` or `http://localhost:7842/`. Another host name or a proxy fails the Host check, and requests a browser marks as coming from another site are refused. |
| Dashboard: "No usage recorded yet" | The mod is off or has not reloaded: [Turn the mod on](#turn-the-mod-on). |
| A session shows 0 requests and `—` as cost | It has started but has made no model request since reporting began. It fills in as the session is used. |
| Events missing after an outage | The mod keeps at most 2000 events in memory and drops the oldest; events queued when a session ends or the mod reloads are lost. |

## Security

Ingest is socket-only, and the socket is owner-only (`0600`): that is its authentication. The TCP port is
loopback-only and read-only, and a `Host` check (`127.0.0.1:<port>` or `localhost:<port>`, anything else is
`421`) keeps a web page on another origin from reaching it through DNS rebinding. A request the browser marks
`Sec-Fetch-Site: cross-site` or `same-site` (a page on another site, or on another `localhost` port, firing `fetch` or
`<img>` requests at the port, which would make the API run its queries even though the page cannot read the answer) is
`403` with a short plain-text body. The one exception is a `GET` document load of `/` (`Sec-Fetch-Mode: navigate`),
so a link into the dashboard keeps working. Requests with no such header (`curl`), `same-origin` ones (the dashboard
itself) and `none` (a typed URL) pass untouched. This guard is on the TCP port only; the socket is protected by its mode.
Every response from either listener carries `X-Content-Type-Options: nosniff`,
`Cross-Origin-Resource-Policy: same-origin` and `Content-Security-Policy: frame-ancestors 'none'`. Any local user account on the
machine can still read usage data through that port, so leave `USAGE_MONITOR_PORT` unset on a shared machine
(remove the `Environment=USAGE_MONITOR_PORT` line from the unit).

## Layout

```
schema.sql          tables and indexes; applied once, while PRAGMA user_version is 0
src/config.ts       settings: socket, db and the optional TCP port from the env vars, web/dist, schema.sql; ConfigError; the socket-directory check
src/db.ts           opens the database (mode 0600, WAL, busy timeout 5 s), applies the schema, inTransaction()
src/events.ts       strict validation of an ingest batch; ValidationError names the event index and field
src/routes.ts       request handler: ingest, read routes, static files from web/dist/ (createHandler(db, { distDir, readOnly }); readOnly drops ingest and every method but GET/HEAD)
src/listeners.ts    startListeners(): the Unix socket (mode 0600, removes a stale socket first) and, when a port is given, the loopback TCP listener (read-only handler, Host check, cross-site check)
src/server.ts       entry point: reads the env and checks the socket directory, opens the database, starts the listeners, cleans up on SIGTERM/SIGINT
test/               node:test suites on in-memory databases (HTTP tests use a Unix socket in a temp dir, the TCP ones also an ephemeral loopback port)
                    run with `npm test`; a bare `node --test` also collects web/'s own test files
deploy/             systemd user unit (test/deploy.test.ts pins its hardening lines)
web/                the dashboard app (not part of the API); web/dist/ is what gets served
```

Behaviour the contract leaves open:

- Sessions are ordered by `lastTs` (last activity), newest first, ties by `startedTs` (later start first) and then by
  `session`. The list picks its `limit` sessions first and totals usage and tool calls for those only, so the work
  follows the page, not the whole history of events. `limit` outside 1-500, and a `from`/`to` that is not an integer (a negative one
  included), answer `400`. `from` and `to` are inclusive.
- `session` and `agent` events keep no row of their own, so their ids are stored in `state_event`; that is
  what lets a retried batch report them as duplicates like `usage` and `tool` events.
- A duplicate event changes nothing (it does not touch the session or agent rows).
- An `agent` event never blanks a label or model that is already set; a `usage` event sets an agent's model
  only while it is empty.
- Static files: a request path maps to a file in `web/dist/` only if every segment starts with a letter,
  digit or `_` and the extension is a known type (html, js, css, json, map, svg, png, ico, woff2). Anything
  else is `404`; there is no single-page-app fallback. `/assets/*` is cached as immutable, the rest is `no-store`.

## Known limits

- **No retention.** Nothing deletes old events, so the database grows without bound. Measured on a fresh database
  after 100,000 events sent through `POST /events` (checkpointed): about 240 bytes per event, 23 MiB, for a mix of one
  `usage` event to two `tool` events (22 MiB if all were `tool`, 26 MiB if all were `usage`), plus the WAL file while the
  service runs.
- **No schema migration path.** The schema is version 1 (`PRAGMA user_version`) and is applied only to an empty
  database. The next schema change needs a migration step that upgrades an existing database; without one the new code
  would fail against the old tables at start.
- **After `/clear`, no session start.** The mod does not send a `session` start for the new session, so a session that
  begins that way has no directory (`cwd` is `null`).
- **Costs are estimates.** The mod computes `costUsd` from list prices; a model it has no price for gets `null`.

## Desktop widget

`desktop/` is a [Tauri](https://tauri.app) app that floats a small always-on-top card (today's cost, tokens and
requests, plus the latest session's model and cost) over every window and workspace, without the browser. It
loads the dashboard's `#/widget` page from `http://127.0.0.1:7842/` (or `USAGE_MONITOR_PORT`), so the API must be
running and `web/dist/` built. Drag the card to move it (the position is remembered); the tray icon has Show / hide, Reload, Open
dashboard, Start at login and Quit.

Needs Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (on Linux,
`webkit2gtk-4.1`; the transparent corners need a compositing window manager).

```sh
cd ~/.claude/api/usage-monitor/desktop
npm install
npm run dev     # run it
npm run build   # installer for this OS under src-tauri/target/release/bundle/ (.app/.dmg, .msi/.exe, .deb/.rpm/.AppImage)
```

Tauri builds only for the OS it runs on: build the Windows and Linux installers on those systems (or in CI).
