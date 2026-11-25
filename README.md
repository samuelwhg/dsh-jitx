# dsh-jitx

**English** | [简体中文](README.zh.md)

JITx hardware development for [DeepSeek Harness](https://github.com/deepseek-ai/dsh):
a uv-managed project environment, the official JITx skills, a JITx MCP server
wired at the right scope, and a dedicated **JITx hardware** agent preset.

## What it does

| Piece | Where | What it gives you |
| --- | --- | --- |
| `jitx_env_setup` tool | Host | Scaffolds a JITx project, pins `jitx` + `jitxlib-standard` with uv, syncs `.venv`/`uv.lock`, installs the JITx runtime; reuses an environment that already matches instead of rebuilding it |
| `jitx_check` tool | Host | Read-only health check (uv, Python 3.12+, CLI, runtime, license, skills, MCP scope) |
| `jitx_skills_install` tool | Host | Copies the 13 official skills from [JITx-Inc/jitx-skills](https://github.com/JITx-Inc/jitx-skills) into `<project>/.dsh/skills`; falls back to `$DSH_HOME/skills` when the project is not writable |
| `jitx_mcp_setup` tool | Host | Writes `<project>/.dsh/mcp.json` when `dsh-workspace-mcp` is active, otherwise persists the server in the profile's `mcp-manager` config |
| `jitx-mcp.mjs` | `<project>` or profile | Stdio MCP server exposing `jitx_status` and `jitx_cli` (runs the project JITx CLI through uv) |
| `preset-jitx` | Profile | Agent preset with the JITx persona, the standard tool set, plan mode, and JITx-specific guidance |

No system Python is touched. Every JITx command runs through
`uv run --project <dir> jitx ...`.

## Requirements

* Node 22+, DSH 0.2.2+
* [`uv`](https://docs.astral.sh/uv/) on PATH — `curl -LsSf https://astral.sh/uv/install.sh | sh`, or the
  PowerShell installer on Windows
* A JITx license (`jitx auth login`, interactive, run it yourself)

## Install

From npm, like any DSH bundle:

```sh
dsh plugin --profile web add dsh-jitx
```

From a checkout, either of these works:

```sh
plugin_manager install_bundle /path/to/dsh-jitx   # inside DSH
dsh plugin --profile web add /path/to/dsh-jitx
```

The bundle patch installs the four tools and the **JITx hardware** preset in
one step, so the preset is in the session picker after the restart. No extra
configuration command is needed: `jitx_skills_install` and `jitx_mcp_setup`
decide project vs user scope at run time.

Restart DSH afterwards — the installed row and its Host code are loaded at
boot — then start a new session.

## Typical flow

```text
jitx_env_setup       directory=~/boards/myboard
jitx_check           directory=~/boards/myboard
jitx_skills_install  directory=~/boards/myboard
jitx_mcp_setup       directory=~/boards/myboard
```

After `jitx_skills_install` and `jitx_mcp_setup`, start a new session in the
project so DSH discovers `.dsh/skills` and workspace-mcp mounts the new server.

## MCP scope selection

`jitx_mcp_setup` reads the active profile (`$DSH_PROFILE_DIR`, or the
`profileContext` service):

* profile `package.json` selects `dsh-workspace-mcp` in `dsh.profile.bundles`
  **and** `cordis.patch.yml` does not disable its row
  → project scope: merges a `jitx` server into `<project>/.dsh/mcp.json`,
  preserving any other servers there.
* otherwise → global scope: persists one stdio server in the profile's
  `mcp-manager` configuration (through `config-editor`, so it survives a
  restart). If the config editor refuses, it registers with the live
  mcp-manager for the current session and says so.

`action=status` reports both without writing. `action=remove` deletes only the
project entry; remove a global entry in Settings → MCP.

## Skills scope

Skills follow the same preference as MCP: the project first.

* `scope=auto` (default): `<project>/.dsh/skills`, falling back to
  `$DSH_HOME/skills` only when the project is not writable.
* `scope=project` / `scope=user` force one.

A user-level install is shared by every project, and because the skill
registry ranks `<project>/.dsh/skills` above `$DSH_HOME/skills`, a project can
still override any single skill.

The skills are downloaded at run time, not bundled: they are proprietary JITx
software and are not redistributed with this MIT package.

## Platform notes

* Linux: Ubuntu hosts get the Ubuntu runtime automatically. Other
  distributions and WSL default to `--target ubuntu`, which the JITx docs
  require; override with `runtimeTarget`.
* Windows: the runtime installer may open an MSI dialog. uv sets
  `PYTHONUTF8=1` for the environment, matching the JITx docs.
* Network: the skills download honours `HTTPS_PROXY`/`HTTP_PROXY`; git and
  curl are both tried.
* `jitx auth login` is interactive and is never run by the tools. The check
  reports the license state and tells the user to log in in a terminal.

## Layout

```text
dsh-jitx/
  index.js            host plugin, four tools
  lib/run.js          process/path helpers (spawn, PATH lookup, platform)
  lib/jitx.js         environment, skills, MCP scope logic
  mcp/jitx-mcp.mjs    stdio MCP server
  cordis.patch.yml    plugin row + preset row
  locale/{en,zh}.json bundle metadata
  docs/DETAIL.md      design and troubleshooting
```

## Troubleshooting

See [docs/DETAIL.md](docs/DETAIL.md). The short version:

* `uv: command not found` → install uv, then run `jitx_env_setup` again.
* `MCP scope: global` in a project that should use workspace-mcp → the
  profile's bundle list does not select `dsh-workspace-mcp`, or its row is
  disabled; `jitx_check` prints the reason.
* Tools still behave like the old version after an upgrade → restart DSH; Host
  modules are loaded at boot.

## License

MIT for the plugin code. The JITx CLI, runtime, and the official skills are
proprietary JITx software under their own terms.
