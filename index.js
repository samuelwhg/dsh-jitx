/**
 * dsh-jitx host plugin.
 *
 * Registers four model-visible tools that share one contract: work on the
 * project's uv-managed environment, never on a system Python. The matching
 * stdio MCP server (`mcp/jitx-mcp.mjs`) exposes the same environment to sessions
 * that prefer MCP tools, and the bundle's patch adds the `jitx` agent preset.
 *
 * @module dsh-jitx
 */

import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_JITX_VERSION,
  MCP_SERVER_NAME,
  checkProject,
  configureGlobalMcp,
  detectWorkspaceMcp,
  globalMcpStatus,
  installSkills,
  mcpServerEntry,
  readProjectMcp,
  removeProjectMcp,
  requireUv,
  setupProject,
  writeProjectMcp,
} from './lib/jitx.js'
import { expandHome } from './lib/run.js'

/** Cordis plugin name used in loader diagnostics. */
export const name = 'jitx'

/** The tool registry is the only hard service dependency. */
export const inject = ['tools']

/**
 * Resolve the tool's target directory: the explicit argument, else the
 * owning session's working directory, else the Host's directory.
 * @param {{directory?: string}} args - validated tool input.
 * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - execution context.
 * @returns {string} absolute directory.
 */
function targetDirectory(args, exec) {
  const base = exec.agent?.session?.header?.cwd || process.cwd()
  const raw = args.directory?.trim()
  const value = raw ? expandHome(raw) : base
  return isAbsolute(value) ? value : resolve(base, value)
}

/** Resolve the active profile directory for the scope decision. */
function resolveProfileDir(ctx) {
  try {
    const profile = ctx.get('profileContext', false)
    if (profile?.dir) return profile.dir
  } catch {
    // fall through to the config location and the environment
  }
  if (typeof ctx.baseUrl === 'string' && ctx.baseUrl.startsWith('file:')) {
    try {
      return dirname(fileURLToPath(ctx.baseUrl))
    } catch {
      // fall through to the environment
    }
  }
  return process.env.DSH_PROFILE_DIR
}

/** Ensure a project directory exists before writing into it. */
function ensureDirectory(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      report: { type: 'string', required: true },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.report }],
}

/** One-line PASS/FAIL step rendering. */
function renderSteps(steps) {
  return steps.map((step) => `[${step.ok ? 'PASS' : 'FAIL'}] ${step.name}: ${step.detail}`).join('\n')
}

/** Format a setup result for the model. */
function formatSetup(result) {
  const lines = [
    `JITx environment for ${result.directory}`,
    `Platform: ${result.platform}`,
    `uv: ${result.uvVersion || 'unknown'}`,
    `Python: ${result.python || 'unknown'}`,
    `JITx CLI: ${result.jitx || 'unknown'}`,
    '',
    renderSteps(result.steps),
  ]
  if (result.reused) lines.push('', 'Environment already current; no install step ran.')
  lines.push(
    '',
    `Runtime: ${result.runtime.installed ? `installed${result.runtime.version ? ` (${result.runtime.version})` : ''}, ${result.runtime.running ? 'running' : 'not running'}; target ${result.runtime.target}` : 'not installed'}`,
    `Auth: ${result.auth.authorized ? `authorized${result.auth.server ? ` (${result.auth.server})` : ''}` : 'not authorized'}`,
  )
  if (!result.auth.authorized) {
    lines.push('Run `uv run jitx auth login` in a terminal; the tool does not perform interactive login.')
  }
  lines.push('', 'Next: run jitx_skills_install, then jitx_mcp_setup.')
  return lines.join('\n')
}

/** Format a read-only check result for the model. */
function formatCheck(result, mcp, projectServer) {
  const lines = [
    `JITx project check: ${result.directory}`,
    `Platform: ${result.platform}`,
    '',
    result.checks
      .map((check) => `[${check.ok ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}${check.fix ? `\n       fix: ${check.fix}` : ''}`)
      .join('\n'),
  ]
  const scope = mcp.active || projectServer ? 'project (.dsh/mcp.json)' : 'global (mcp-manager)'
  lines.push('', `MCP scope: ${scope}${projectServer ? '; jitx entry present in the project file' : ''} — ${mcp.reason}`)
  if (result.ok) lines.push('', 'Environment is complete.')
  else lines.push('', 'Fix the FAIL lines, then re-run jitx_check. jitx_env_setup repairs the environment; jitx_skills_install installs the skills.')
  return lines.join('\n')
}

/** Format an MCP setup/status result for the model. */
function formatMcp(report) {
  const lines = [
    `JITx MCP scope: ${report.mode}`,
    `Detection: ${report.detection.reason}`,
  ]
  if (report.detection.profileDir) lines.push(`Profile: ${report.detection.profileDir}`)
  lines.push(`Project file: ${report.projectFile}${report.projectExists ? ' (exists)' : ' (absent)'}`)
  if (report.projectServer) lines.push(`Project entry: ${MCP_SERVER_NAME} present`)
  if (report.global) {
    lines.push(`Global manager: ${report.global.available ? (report.global.registered ? `registered (${report.global.state ?? 'unknown'})` : 'not registered') : 'unavailable'}`)
  }
  if (report.action === 'configure') {
    lines.push('', report.message)
    if (report.mode === 'project') lines.push('Start a new session for this project so workspace-mcp mounts the server.')
    else lines.push('New agent sessions pick up the global registration; existing sessions keep their tool catalog.')
  }
  if (report.action === 'remove') lines.push('', report.message)
  return lines.join('\n')
}

/**
 * Register the JITx tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const register = (definition) => ctx.effect(() => ctx.tools.register(definition))

  register(defineTool({
    name: 'jitx_env_setup',
    timeoutMs: 1_800_000,
    description:
      'Create or repair the uv-managed JITx environment of a project: scaffold a JITx project when pyproject.toml is missing, pin jitx and jitxlib-standard with uv, sync .venv and uv.lock, install the JITx runtime, and report license state. '
      + 'Use for a new JITx board project or when jitx_check reports a missing or stale environment. Works on Windows and Linux; the AI runtime target is chosen automatically and can be overridden.',
    parameters: {
      directory: { type: 'string', description: 'Project directory (default: the session working directory).' },
      projectName: { type: 'string', description: 'Python package name used when scaffolding a new project (default: the directory name).' },
      jitxVersion: { type: 'string', description: `JITx release to pin (default: ${DEFAULT_JITX_VERSION}).` },
      installRuntime: { type: 'boolean', description: 'Install the JITx runtime when it is missing or stale (default: true).' },
      runtimeTarget: {
        type: 'string',
        enum: ['auto', 'ubuntu', 'macos', 'windows'],
        description: 'Runtime build to install; auto picks the host build and falls back to ubuntu on unsupported Linux and WSL.',
      },
    },
    output: textOutput,
    async execute(args, exec) {
      const dir = ensureDirectory(targetDirectory(args, exec))
      const result = await setupProject({
        dir,
        projectName: args.projectName,
        jitxVersion: args.jitxVersion,
        installRuntime: args.installRuntime ?? true,
        runtimeTarget: args.runtimeTarget,
        signal: exec.signal,
      })
      const ok = result.runtime.installed && result.steps.every((step) => step.name === 'auth' || step.ok)
      return { ok, report: formatSetup(result) }
    },
  }))

  register(defineTool({
    name: 'jitx_check',
    description:
      'Read-only health check of a JITx project: uv, pyproject.toml, uv.lock, .venv, Python 3.12+, the pinned jitx CLI, the installed runtime, license state, and the official skills. '
      + 'Also reports whether MCP is wired at project or global scope. Use before JITx work and after changing the environment; it never installs anything.',
    parameters: {
      directory: { type: 'string', description: 'Project directory (default: the session working directory).' },
    },
    output: textOutput,
    async execute(args, exec) {
      const dir = targetDirectory(args, exec)
      const mcp = detectWorkspaceMcp(resolveProfileDir(ctx))
      const project = readProjectMcp(dir)
      const projectServer = Boolean(project.data?.mcpServers && Object.hasOwn(project.data.mcpServers, MCP_SERVER_NAME))
      const result = await checkProject({ dir, signal: exec.signal })
      return { ok: result.ok, report: formatCheck(result, mcp, projectServer) }
    },
  }))

  register(defineTool({
    name: 'jitx_skills_install',
    timeoutMs: 600_000,
    description:
      'Install the official JITx skills from github.com/JITx-Inc/jitx-skills, project scope first: .dsh/skills in the project is preferred and a user-level root is used only when the project is not writable or scope=user is asked for. '
      + 'Project skills win over user skills, so a project can override individual skills. Idempotent; pass force to refresh. Uses git, with a curl+tar fallback, and honours HTTPS_PROXY.',
    parameters: {
      directory: { type: 'string', description: 'Project directory (default: the session working directory).' },
      scope: {
        type: 'string',
        enum: ['auto', 'project', 'user'],
        description: 'auto (default) prefers the project root and falls back to $DSH_HOME/skills; project or user forces one.',
      },
      ref: { type: 'string', description: 'Git branch or tag to install (default: main).' },
      force: { type: 'boolean', description: 'Reinstall even when a previous install marker exists.' },
    },
    output: textOutput,
    async execute(args, exec) {
      const dir = targetDirectory(args, exec)
      const result = await installSkills({ dir, scope: args.scope, ref: args.ref, force: args.force ?? false, signal: exec.signal })
      const lines = result.already
        ? [
            `JITx skills are already installed in ${result.destination} (${result.scope ?? 'project'} scope).`,
            `Source: ${result.repo}@${result.ref}${result.commit ? ` (${result.commit.slice(0, 12)})` : ''}`,
            `Skills (${result.skills.length}): ${result.skills.join(', ')}`,
            'Pass force: true to refresh.',
          ]
        : [
            `Installed ${result.skills.length} JITx skills in ${result.destination} (${result.scope} scope${result.fellBack ? ', project root was not writable' : ''})`,
            `Source: ${result.repo}@${result.ref}${result.commit ? ` (${result.commit.slice(0, 12)})` : ''} via ${result.source}`,
            `Skills: ${result.skills.join(', ')}`,
            result.scope === 'user'
              ? 'These skills apply to every project; `<project>/.dsh/skills` still overrides them per skill.'
              : 'Project skills take precedence over user-level skills of the same name.',
            'Start a new session (or reload skills) before the `jitx` skill becomes visible in the catalog.',
          ]
      return { ok: true, report: lines.join('\n') }
    },
  }))

  register(defineTool({
    name: 'jitx_mcp_setup',
    timeoutMs: 120_000,
    description:
      'Wire the bundled JITx stdio MCP server, choosing the scope automatically: when the dsh-workspace-mcp bundle is active it writes <project>/.dsh/mcp.json (project scope); otherwise it registers the server once with the profile\'s mcp-manager (global scope). '
      + 'action=status only reports the current wiring; action=remove deletes the project entry.',
    parameters: {
      directory: { type: 'string', description: 'Project directory the MCP server should use (default: the session working directory).' },
      action: {
        type: 'string',
        enum: ['configure', 'status', 'remove'],
        description: 'configure (default), status, or remove the project-scope entry.',
      },
    },
    output: textOutput,
    async execute(args, exec) {
      const dir = targetDirectory(args, exec)
      const action = args.action ?? 'configure'
      const detection = detectWorkspaceMcp(resolveProfileDir(ctx))
      const profileDir = detection.profileDir
      const project = readProjectMcp(dir)
      const projectServer = Boolean(project.data?.mcpServers && Object.hasOwn(project.data.mcpServers, MCP_SERVER_NAME))
      const report = {
        action,
        mode: detection.active || projectServer ? 'project' : 'global',
        detection,
        projectFile: project.file,
        projectExists: project.exists,
        projectServer,
        global: globalMcpStatus(ctx),
        message: '',
      }

      if (action === 'status') {
        report.message = project.error ? `Project file problem: ${project.error}` : ''
        if (!detection.active && !report.global.registered) {
          report.message += (report.message ? '\n' : '') + 'JITx MCP is not configured; run action=configure.'
        }
        return { ok: !project.error, report: formatMcp(report) }
      }

      if (action === 'remove') {
        const removed = removeProjectMcp(dir)
        report.message = removed.removed
          ? `Removed ${MCP_SERVER_NAME} from ${removed.file}. Start a new session for the change to take effect.`
          : `No ${MCP_SERVER_NAME} entry in ${project.file}.`
        return { ok: true, report: formatMcp(report) }
      }

      const uv = (() => {
        try { return requireUv() } catch { return undefined }
      })()
      const entry = mcpServerEntry(dir, uv, profileDir)

      if (report.mode === 'project') {
        const written = writeProjectMcp(dir, entry)
        report.projectExists = true
        report.projectServer = true
        report.message = `${written.replaced ? 'Updated' : 'Added'} the ${MCP_SERVER_NAME} stdio server in ${written.file} (servers: ${written.servers.join(', ')}).`
        return { ok: true, report: formatMcp(report) }
      }

      const global = await configureGlobalMcp(ctx, entry)
      report.global = globalMcpStatus(ctx)
      if (!global.ok) {
        return {
          ok: false,
          report: formatMcp({ ...report, action: 'configure', message: `Could not register the global server: ${global.reason}. Install dsh-workspace-mcp or the mcp-manager service, then retry.` }),
        }
      }
      report.message = global.already
        ? `Updated the ${MCP_SERVER_NAME} server in the profile's mcp-manager configuration for ${dir}.`
        : global.persisted
          ? `Added the ${MCP_SERVER_NAME} stdio server to the profile's mcp-manager configuration for ${dir}.`
          : `Registered the ${MCP_SERVER_NAME} stdio server with mcp-manager for ${dir} (this session only).`
      return { ok: true, report: formatMcp(report) }
    },
  }))
}
