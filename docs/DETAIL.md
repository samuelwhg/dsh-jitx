# dsh-jitx — design and operations

## Why the plugin manages the environment itself

The JITx CLI documentation offers two bootstraps: a pip install or uv. This
plugin standardises on uv because uv gives one reproducible toolchain per
project (`pyproject.toml` + `uv.lock` + `.venv`), works identically on Windows
and Linux, and never depends on the Harness's own Node or the system Python.

The plugin pins exactly the versions the official guide recommends
(`jitx==4.6.0`, `jitxlib-standard==4.6.0` by default) and can be pointed at a
newer pair with `jitxVersion`. Scaffolding goes through
`uv tool run --from jitx==<version> jitx project layout init`, so even the first
step does not require a global JITx install.

## Tools

### `jitx_env_setup`

1. `uv --version` (missing → actionable install hint, no partial writes)
2. Reuse fast path, before any write: when `pyproject.toml` already pins both
   `jitx==<v>` and `jitxlib-standard==<v>`, `.venv` exists, the probes answer,
   and the requested runtime is already installed, the tool returns that
   verified state (`reused: true`) and runs none of steps 3–7. This is the
   normal case on an already set-up project and skips the expensive `uv sync`.
3. Scaffold only when `pyproject.toml` is absent:
   `uv tool run --from jitx==<v> jitx project layout init . --name <name>`
4. `uv add --project <dir> jitx==<v> jitxlib-standard==<v>`
5. `uv sync --project <dir>`
6. `uv run --project <dir> python -V` and `jitx --version`, probed concurrently
7. `uv run --project <dir> jitx runtime install --prod [--target <t>]`
   (skipped when `installRuntime: false`)
8. `jitx runtime introspect` + `jitx runtime status` + `jitx auth show` for the
   final report (introspect and status run concurrently)

Each step is recorded as `{name, ok, detail}` and the whole run throws only
when a step makes the environment unusable (missing uv, failed scaffold, failed
`uv add`). Runtime or license problems are reported, not thrown, because a
license is a human action and the runtime can be installed later.

`runtimeTarget` defaults to `auto`: Windows/macOS/Ubuntu use their native
build; WSL and other Linux distributions pass `--target ubuntu`, which the JITx
documentation requires outside the officially detected platforms.

### `jitx_check`

Read-only. Checks uv, `pyproject.toml`, `uv.lock`, `.venv`, Python ≥ 3.12, the
project `jitx` CLI, the runtime directory (`<jitx_root>/<version>`), the license
(`Authorized: yes` in `jitx auth show`), and the skills marker. It also reports
the MCP scope decision so a stale global registration is visible before it
surprises the user. Nothing is installed and no file is written.

Independent probes run concurrently (Python and CLI versions; runtime and
license), so one check costs roughly its slowest probe. Passing file checks
report `found` instead of an absolute path — the header already names the
project, and the detailed evidence stays on disk. Run it once per environment
state, not before every JITx command.

### `jitx_skills_install`

Downloads `https://github.com/JITx-Inc/jitx-skills` (branch/tag selectable),
then copies every directory containing a `SKILL.md` into
`<project>/.dsh/skills/<skill>`. DSH discovers project skills at rank 100, so
they are available in the next session without touching the user's global skill
directory. `scope: user` writes `$DSH_HOME/skills` (rank 400) for projects that
share one install; `scope: auto` only falls back there when the project root is
not writable.

The skills are downloaded rather than vendored into this package on purpose:
the upstream repository is proprietary, so shipping its text inside a
published MIT package would redistribute it. The user's machine fetches it from
JITx directly.

* Primary transport: `git clone --depth 1 --branch <ref>`.
* Fallback: `curl` of the GitHub tarball + `tar -xzf` (in case git is missing).
* Both honour `HTTPS_PROXY`/`HTTP_PROXY`.
* A marker `.dsh/skills/.jitx-skills.json` records repo, ref, commit, source,
  timestamp, and the installed skill names. Without `force` an existing marker
  short-circuits the download.

The official skills expect a JITx 4.6 environment; the plugin does not import
them, it only installs files.

### `jitx_mcp_setup`

The scope decision is deterministic and inspectable:

```text
profile package.json → dsh.profile.bundles includes "dsh-workspace-mcp"
profile cordis.patch.yml → row id "workspace-mcp" with disabled: true
                            or enabled: false
active = selected && !disabled
(a dependency without the bundle entry means installed-but-not-started)
```

* **active** → write `<project>/.dsh/mcp.json`, merging
  `{ "mcpServers": { "jitx": { type: "stdio", command: <node>, args: [<mcp/jitx-mcp.mjs>], cwd: <project>, env: { JITX_PROJECT } } } }`
  into whatever is already there. The write is atomic (temp file + rename) and
  preserves other servers.
* **inactive** → persist the server in the profile's `mcp-manager` configuration
  through `ctx.get('configEditor').edit(...)`: the entry is validated against the
  live manager schema and written to `cordis.patch.yml`, so it survives a
  restart. When `config-editor` is absent the code falls back to
  `ctx.get('mcpManager').register(...)`, which lasts only for the manager's
  lifetime; the report says so.
* **remove** → deletes only the project entry.

Skills use the same preference. `installSkills` writes
`<project>/.dsh/skills` for `scope: auto` and only falls back to
`$DSH_HOME/skills` when the project root is not writable (`EACCES`/`EPERM`/
`EROFS`); `scope: project` and `scope: user` force one root. The skill registry
ranks project roots (100) above user roots (400), so a user-level install never
shadows a project one.

The project file is read once by `workspace-mcp` at session creation, and global
registrations appear in new agent sessions. Both cases tell the user to start a
new session.

Environment passed to the server: `JITX_PROJECT=<project>`, `JITX_UV=<uv path
when discovered>`. On Electron-packaged DSH, `ELECTRON_RUN_AS_NODE=1` is added
so `process.execPath` behaves as Node.

## Layout and routing gates

The `jitx` preset carries four rules that decide whether a layout is
electrically sound. They bind the agent, not the tools: the plugin cannot
inspect a design, so the gates have to live where the model reads them (the
persona prefix in `cordis.patch.yml`).

1. Rules before geometry. JITX routes to the rules it is given, so a board that
   builds clean can still arc across an isolation gap, overheat a power trace,
   or couple a switch node into a receiver. List what the layout must hold
   (current, working voltage and isolation, impedance, return path, coupling,
   assembly) and write the matching `design_constraint` rules and net-class
   tags first — `jitx-layout-constraints`.
2. No invented numbers. A value comes from the prompt, an existing rule, a
   fab-sheet row, a datasheet, or a quoted standard; otherwise it is an open
   item for the user, never a guess.
3. Assign pins before routing. The router works with the `provide`/`require`
   pin assignment it is given — `jitx-pin-assignment`.
4. Read the geometry back. `status: ok` is not routed copper: verify from
   Python introspection, `rd.issues()`, and skew margin — `jitx-code-layout`,
   `jitx-interactive-layout`.
5. One layout. Script edits to the open layout are ordinary editable objects;
   a `Route` in the design's Python is not. Do not maintain both, and commit
   `designs/<design>/design-info/` with the source.

Priority is part of the rule set: at equal priority the more specific
condition wins, so a permissive rule can silently beat a protection rule added
later. Keep one commented ladder and put protections above every permissive
rule that can match their copper.

## MCP server

`mcp/jitx-mcp.mjs` is a newline-delimited JSON-RPC 2.0 server on stdio.

| Method | Behaviour |
| --- | --- |
| `initialize` | Echoes the client's `protocolVersion` (default `2025-06-18`), advertises `tools` |
| `notifications/initialized` | Ignored (no response for notifications) |
| `ping` | `{}` |
| `tools/list` | `jitx_status`, `jitx_cli` |
| `tools/call` | Executes a tool; tool failures return `{content, isError: true}` |

`jitx_status` reuses the same check logic as the Host tool (no duplication of
probes). `jitx_cli` runs `uv run --project <dir> jitx <args>` and refuses to run
anything whose first token is not one of `project`, `design`, `runtime`,
`auth`, `support`, `ui`. The timeout is clamped to 1–1800 seconds.

It deliberately does not expose install actions: environment changes go through
the Host tools, which have cancellation, step reporting, and the repository's
own policy. The server has no network code.

## Data flow

```text
user / model
   │
   ├── Host tool jitx_env_setup ──► uv (scaffold/add/sync) ──► jitx runtime install
   ├── Host tool jitx_check ─────► uv run jitx ... (read-only)
   ├── Host tool jitx_skills_install ──► git/curl ──► <project>/.dsh/skills
   └── Host tool jitx_mcp_setup
           ├─ workspace-mcp active ──► <project>/.dsh/mcp.json
           └─ otherwise ────────────► mcp-manager (profile)
                                          │
                                          ▼
                                  mcp/jitx-mcp.mjs ──► uv run jitx <args>
```

`jitx_env_setup` short-circuits to the same read-only probes when the pins and
runtime already match, so the common call performs no writes.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `uv is not on PATH` | uv installed to `~/.local/bin` but the Harness process has an older PATH | install per hint, then restart DSH |
| `uv add` fails at resolve | network/proxy, or Python < 3.12 on PATH | set `HTTPS_PROXY`; uv downloads its own Python if allowed |
| Runtime install fails on non-Ubuntu Linux | JITx only auto-detects Ubuntu/macOS/Windows | `runtimeTarget: "ubuntu"` |
| `WinError 32` during an upgrade | a `jitx.exe` is running | close JITx, then re-run `jitx_env_setup` (its `uv add` replaces the pinned `jitx`; do not pip-install into `.venv`) |
| Skills clone fails with `GnuTLS recv error` | no proxy in the Harness environment | set `HTTPS_PROXY=http://127.0.0.1:10808` (or the user's proxy) |
| MCP tools do not appear | project file is read at session start | start a new session |
| `Configuration for "mcp-manager" is overridden by a home patch` | the profile cannot own this value | put the server in the home patch instead, or use project scope |
| `mcp-manager: server "jitx" is already configured` | a registered (not persisted) entry exists | restart DSH, or configure the profile patch directly |

## Security notes

* No credentials are read or written. `jitx auth login` stays a manual action.
* The skills are copied as files; the plugin never executes them.
* Project MCP entries point at this plugin's own `mcp/jitx-mcp.mjs`; the server
  only runs the project's `uv`/`jitx`, with a command allowlist.
* The project file write merges rather than replaces, so unrelated servers in
  `.dsh/mcp.json` survive.
