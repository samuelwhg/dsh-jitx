# dsh-jitx

[English](README.md) | **简体中文**

给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 加上 JITx 硬件开发能力：
用 uv 管好项目环境，装好官方 JITx 技能，按正确的范围挂上 JITx MCP，再配一个
**JITx硬件** 预设。

## 它做什么

| 组成 | 位置 | 作用 |
| --- | --- | --- |
| `jitx_env_setup` 工具 | Host | 生成 JITx 项目骨架，用 uv 钉住 `jitx` + `jitxlib-standard`，同步 `.venv` / `uv.lock`，安装 JITx 运行时 |
| `jitx_check` 工具 | Host | 只读体检：uv、Python 3.12+、CLI、运行时、许可证、技能、MCP 范围 |
| `jitx_skills_install` 工具 | Host | 把 [JITx-Inc/jitx-skills](https://github.com/JITx-Inc/jitx-skills) 的 13 个官方技能复制到 `<project>/.dsh/skills`；项目目录不可写时退回 `$DSH_HOME/skills` |
| `jitx_mcp_setup` 工具 | Host | `dsh-workspace-mcp` 生效时写 `<project>/.dsh/mcp.json`，否则把服务器持久化进 profile 的 `mcp-manager` 配置 |
| `jitx-mcp.mjs` | `<project>` 或 profile | stdio MCP 服务器，提供 `jitx_status` 和 `jitx_cli`（通过 uv 调项目自己的 JITx CLI） |
| `preset-jitx` | Profile | 智能体预设：JITx 角色设定、标准工具集、计划模式、JITx 专门指引 |

不碰系统 Python。所有 JITx 命令都走 `uv run --project <dir> jitx ...`。

## 环境要求

* Node 22+，DSH 0.2.2+
* PATH 里有 [`uv`](https://docs.astral.sh/uv/)：`curl -LsSf https://astral.sh/uv/install.sh | sh`，
  Windows 用 PowerShell 安装脚本
* JITx 许可证（`jitx auth login` 是交互式的，需要你自己在终端跑）

## 安装

npm 包发布后，和普通 DSH bundle 一样：

```sh
dsh plugin --profile web add dsh-jitx
```

用源码目录安装也可以（两种都行）：

```sh
plugin_manager install_bundle /path/to/dsh-jitx   # 在 DSH 里
dsh plugin --profile web add /path/to/dsh-jitx
```

bundle 的 patch 会在同一步里装好四个工具和 **JITx硬件** 预设，重启后预设直接出现在
会话选择器里。不需要额外的配置命令：项目级还是用户级，`jitx_skills_install` 和
`jitx_mcp_setup` 运行时自己判断。

装完要重启 DSH（安装的行和它的 Host 代码在启动时加载），然后新建会话。

## 典型流程

```text
jitx_env_setup       directory=~/boards/myboard
jitx_check           directory=~/boards/myboard
jitx_skills_install  directory=~/boards/myboard
jitx_mcp_setup       directory=~/boards/myboard
```

跑完 `jitx_skills_install` 和 `jitx_mcp_setup` 后，在项目里新开一个会话，DSH 才会
发现 `.dsh/skills`，workspace-mcp 才会挂载新服务器。

## MCP 范围怎么选

`jitx_mcp_setup` 读当前 profile（`$DSH_PROFILE_DIR`，或 `profileContext` 服务）：

* profile 的 `package.json` 在 `dsh.profile.bundles` 里选了 `dsh-workspace-mcp`，
  **并且** `cordis.patch.yml` 没有禁掉它的行
  → 项目级：把 `jitx` 服务器合并进 `<project>/.dsh/mcp.json`，不动里面已有的其他服务器。
* 否则 → 全局级：通过 `config-editor` 把 stdio 服务器持久化进 profile 的
  `mcp-manager` 配置，重启后仍在。config-editor 拒绝时，退回当前会话的 mcp-manager
  注册，并在结果里说明只是本会话有效。

`action=status` 只看不写。`action=remove` 只删项目里的条目；全局条目到「设置 → MCP」里删。

## 技能范围

技能和 MCP 一样：项目优先。

* `scope=auto`（默认）：`<project>/.dsh/skills`，只有项目目录不可写时才退回 `$DSH_HOME/skills`。
* `scope=project` / `scope=user`：强制指定。

用户级安装所有项目共享；因为技能注册表把 `<project>/.dsh/skills` 排在
`$DSH_HOME/skills` 前面，项目仍然可以单独覆盖任意一个技能。

技能是运行时下载的，不打进包里：它们是 JITx 的专有软件，不随这个 MIT 包再分发。

## 平台说明

* Linux：Ubuntu 主机自动选 Ubuntu 运行时。其他发行版和 WSL 默认带 `--target ubuntu`
  （JITx 文档的要求），需要别的就传 `runtimeTarget`。
* Windows：运行时安装器可能弹出 MSI 对话框。uv 会给环境设 `PYTHONUTF8=1`，和 JITx 文档一致。
* 网络：技能下载认 `HTTPS_PROXY` / `HTTP_PROXY`；git 和 curl 两种方式都会试。
* `jitx auth login` 是交互式的，工具不会替你跑。体检会报许可证状态，并提示你去终端登录。

## 目录

```text
dsh-jitx/
  index.js            Host 插件，四个工具
  lib/run.js          进程/路径辅助（spawn、PATH 查找、平台判断）
  lib/jitx.js         环境、技能、MCP 范围逻辑
  mcp/jitx-mcp.mjs    stdio MCP 服务器
  cordis.patch.yml    插件行 + 预设行
  locale/{en,zh}.json bundle 元数据
  docs/DETAIL.md      设计与排障
```

## 排障

详见 [docs/DETAIL.md](docs/DETAIL.md)。常见的几个：

* `uv: command not found` → 先装 uv，再跑一次 `jitx_env_setup`。
* 该用 workspace-mcp 的项目却报 `MCP scope: global` → profile 的 bundle 列表没选
  `dsh-workspace-mcp`，或者它的行被禁了；`jitx_check` 会把原因打出来。
* 升级后工具还是老行为 → 重启 DSH；Host 模块在启动时加载。

## 许可证

插件代码 MIT。JITx CLI、运行时和官方技能是 JITx 的专有软件，按它们自己的条款使用。
