/**
 * JITx environment, skills, and MCP plumbing used by the dsh-jitx tools.
 *
 * Everything runs through the project's uv environment: `uv add` pins the JITx
 * packages, `uv run` executes the CLI, and no system Python is touched. The
 * module is deliberately plain JavaScript so the same file serves the Host
 * tools and the stdio MCP server.
 *
 * @module dsh-jitx/jitx
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultRuntimeTarget,
  describeRun,
  findExecutable,
  platformLabel,
  readText,
  run,
  tail,
} from './run.js'

/** Default JITx release pinned by the official installation guide. */
export const DEFAULT_JITX_VERSION = '4.6.0'

/** Official JITx skills repository. */
export const SKILLS_REPO = 'https://github.com/JITx-Inc/jitx-skills.git'

/** Directory name of the project-level MCP server entry. */
export const MCP_SERVER_NAME = 'jitx'

/** Absolute path of the bundled stdio MCP server. */
export const MCP_SERVER_PATH = fileURLToPath(new URL('../mcp/jitx-mcp.mjs', import.meta.url))

/** Honest installation hint used when uv is missing. */
export const UV_MISSING_HINT = [
  'uv is not on PATH.',
  'Install it, then re-run jitx_env_setup:',
  '  Linux/macOS: curl -LsSf https://astral.sh/uv/install.sh | sh',
  '  Windows:     powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
  'If uv is installed but the Harness cannot see it, add ~/.local/bin to PATH and restart DSH.',
].join('\n')

/** Locate uv, or throw with the platform-specific installation hint. */
export function requireUv() {
  const uv = findExecutable('uv')
  if (!uv) throw new Error(UV_MISSING_HINT)
  return uv
}

/** Run one uv subcommand with the project as its working directory. */
function uvRun(uv, args, options) {
  return run(uv, args, { cwd: options.dir, env: options.env, timeoutMs: options.timeoutMs ?? 600_000, signal: options.signal })
}

/** Parse JSON text, returning undefined instead of throwing. */
function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Collect steps for a setup report without aborting on the first check. */
function makeRecorder() {
  const steps = []
  return {
    steps,
    add(name, ok, detail) {
      steps.push({ name, ok, detail })
      return ok
    },
  }
}

/**
 * Install or refresh the uv-managed JITx environment for one project.
 *
 * @param {{dir: string, projectName?: string, jitxVersion?: string, installRuntime?: boolean, runtimeTarget?: string, signal?: AbortSignal}} options
 * @returns {Promise<object>} structured step report.
 */
export async function setupProject(options) {
  const { dir, signal } = options
  const jitxVersion = options.jitxVersion?.trim() || DEFAULT_JITX_VERSION
  const uv = requireUv()
  const recorder = makeRecorder()
  const env = process.env

  const uvVersion = await run(uv, ['--version'], { timeoutMs: 20_000, signal })
  recorder.add('uv', uvVersion.code === 0, uvVersion.stdout.trim() || describeRun(uvVersion))

  if (!existsSync(join(dir, 'pyproject.toml'))) {
    const name = options.projectName?.trim() || basename(dir)
    const scaffold = await uvRun(uv, ['tool', 'run', '--from', `jitx==${jitxVersion}`, 'jitx', 'project', 'layout', 'init', '.', '--name', name], {
      dir,
      env,
      timeoutMs: 600_000,
      signal,
    })
    if (!recorder.add('scaffold', scaffold.code === 0, scaffold.code === 0 ? `created project ${name}` : tail(scaffold.stderr || scaffold.stdout))) {
      throw new Error(`Failed to scaffold a JITx project in ${dir}:\n${tail(scaffold.stderr || scaffold.stdout, 12)}`)
    }
  }

  const add = await uvRun(uv, ['add', '--project', dir, `jitx==${jitxVersion}`, `jitxlib-standard==${jitxVersion}`], {
    dir,
    env,
    timeoutMs: 900_000,
    signal,
  })
  if (!recorder.add('pin', add.code === 0, add.code === 0 ? `jitx==${jitxVersion}, jitxlib-standard==${jitxVersion}` : tail(add.stderr, 10))) {
    throw new Error(`uv add failed in ${dir}:\n${tail(add.stderr || add.stdout, 12)}`)
  }

  const sync = await uvRun(uv, ['sync', '--project', dir], { dir, env, timeoutMs: 600_000, signal })
  recorder.add('sync', sync.code === 0, sync.code === 0 ? 'uv.lock and .venv are current' : tail(sync.stderr, 8))

  const python = await uvRun(uv, ['run', '--project', dir, 'python', '-V'], { dir, env, timeoutMs: 120_000, signal })
  const pythonVersion = (python.stdout || python.stderr).trim()
  recorder.add('python', python.code === 0 && /3\.(1[2-9]|[2-9]\d)/.test(pythonVersion), pythonVersion || 'not found')

  const jitx = await uvRun(uv, ['run', '--project', dir, 'jitx', '--version'], { dir, env, timeoutMs: 120_000, signal })
  const jitxCliVersion = (jitx.stdout || jitx.stderr).trim()
  recorder.add('jitx', jitx.code === 0, jitxCliVersion || describeRun(jitx))

  let runtime = { installed: false, running: false, target: undefined, version: undefined, detail: 'not checked' }
  if (options.installRuntime !== false) {
    const target = options.runtimeTarget && options.runtimeTarget !== 'auto' ? options.runtimeTarget : defaultRuntimeTarget()
    const args = ['run', '--project', dir, 'jitx', 'runtime', 'install', '--prod']
    if (target) args.push('--target', target)
    const install = await run(uv, args, { cwd: dir, env, timeoutMs: 1_800_000, signal })
    recorder.add('runtime-install', install.code === 0, install.code === 0 ? `installed${target ? ` (${target} build)` : ''}` : tail(install.stderr || install.stdout, 12))
    runtime = await inspectRuntime(dir, uv, signal)
  } else {
    runtime = await inspectRuntime(dir, uv, signal)
  }

  const auth = await inspectAuth(dir, uv, signal)
  recorder.add('auth', true, auth.authorized ? 'authorized' : auth.detail)

  return {
    directory: dir,
    platform: platformLabel(),
    uv,
    uvVersion: uvVersion.stdout.trim(),
    python: pythonVersion,
    jitx: jitxCliVersion,
    jitxVersion,
    runtime,
    auth,
    steps: recorder.steps,
  }
}

/** Read the runtime's resolved state for one project. */
async function inspectRuntime(dir, uv, signal) {
  const status = await run(uv, ['run', '--project', dir, 'jitx', 'runtime', 'status'], { cwd: dir, timeoutMs: 120_000, signal })
  const introspect = await run(uv, ['run', '--project', dir, 'jitx', 'runtime', 'introspect'], { cwd: dir, timeoutMs: 180_000, signal })
  const info = introspect.code === 0 ? parseJson(introspect.stdout) : undefined
  const root = info?.jitx_root?.path
  const version = info?.version
  const installed = Boolean(root && version && existsSync(join(root, String(version))))
  return {
    installed,
    running: /^Runtime:\s*running/im.test(status.stdout) && !/not running/i.test(status.stdout),
    target: defaultRuntimeTarget() ?? 'auto',
    version: version ?? undefined,
    detail: installed ? '' : tail(introspect.stderr || introspect.stdout, 6),
  }
}

/** Read the JITx license state for one project. */
async function inspectAuth(dir, uv, signal) {
  const result = await run(uv, ['run', '--project', dir, 'jitx', 'auth', 'show'], { cwd: dir, timeoutMs: 120_000, signal })
  const detail = (result.stdout || result.stderr).trim()
  const authorized = /Authorized:\s*yes/i.test(detail)
  const server = /Server:\s*(\S+)/i.exec(detail)?.[1]
  return { authorized, server, detail: tail(detail, 6) }
}

/**
 * Read-only health check for a project environment.
 * @param {{dir: string, signal?: AbortSignal}} options
 * @returns {Promise<object>} check results; never throws for a missing tool.
 */
export async function checkProject(options) {
  const { dir, signal } = options
  const checks = []
  const push = (name, ok, detail, fix) => checks.push({ name, ok, detail, ...(fix && !ok ? { fix } : {}) })
  const env = process.env

  const uv = findExecutable('uv')
  if (!uv) {
    push('uv', false, 'not found on PATH', UV_MISSING_HINT)
  } else {
    const version = await run(uv, ['--version'], { timeoutMs: 20_000, signal })
    push('uv', version.code === 0, version.stdout.trim() || describeRun(version))
  }

  const pyproject = join(dir, 'pyproject.toml')
  const lock = join(dir, 'uv.lock')
  const venv = join(dir, '.venv')
  push('pyproject', existsSync(pyproject), existsSync(pyproject) ? pyproject : 'missing; run jitx_env_setup')
  push('uv.lock', existsSync(lock), existsSync(lock) ? lock : 'missing; run jitx_env_setup')
  push('venv', existsSync(venv), existsSync(venv) ? venv : 'missing; run jitx_env_setup')

  let pythonVersion = ''
  let jitxVersion = ''
  if (uv && existsSync(pyproject)) {
    const python = await run(uv, ['run', '--project', dir, 'python', '-V'], { cwd: dir, timeoutMs: 120_000, signal })
    pythonVersion = (python.stdout || python.stderr).trim()
    push('python', python.code === 0 && /3\.(1[2-9]|[2-9]\d)/.test(pythonVersion), pythonVersion || 'not runnable', 'needs Python 3.12+')
    const jitx = await run(uv, ['run', '--project', dir, 'jitx', '--version'], { cwd: dir, timeoutMs: 120_000, signal })
    jitxVersion = (jitx.stdout || jitx.stderr).trim()
    push('jitx', jitx.code === 0, jitxVersion || 'jitx is not installed in the environment', 'run jitx_env_setup')
  }

  let runtime = { installed: false, running: false, target: defaultRuntimeTarget() ?? 'auto', version: undefined, detail: 'not checked' }
  if (uv && existsSync(pyproject) && jitxVersion) {
    runtime = await inspectRuntime(dir, uv, signal)
    push('runtime', runtime.installed, runtime.installed ? `JITx ${runtime.version ?? ''} runtime installed${runtime.running ? ', running' : ''}` : 'runtime not installed', 'run jitx_env_setup with installRuntime: true')
  }

  let auth = { authorized: false, server: undefined, detail: 'not checked' }
  if (uv && existsSync(pyproject) && jitxVersion) {
    auth = await inspectAuth(dir, uv, signal)
    push('auth', auth.authorized, auth.authorized ? `authorized for ${auth.server ?? 'JITx'}` : 'no license on disk; run jitx auth login in a terminal')
  }

  const skills = readSkillsMarker(dir)
  push('skills', Boolean(skills), skills ? `${skills.skills.length} skills at ${skills.root ?? join(dir, '.dsh', 'skills')}` : 'not installed; run jitx_skills_install')

  return {
    directory: dir,
    platform: platformLabel(),
    checks,
    ok: checks.every((check) => check.ok),
    python: pythonVersion,
    jitx: jitxVersion,
    runtime,
    auth,
    skills,
  }
}

/** Candidate roots for installed skills, project first and user-level second. */
export function skillsRoots(dir) {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return { project: join(dir, '.dsh', 'skills'), user: join(dshHome, 'skills') }
}

/** Read one skills marker file, or undefined when absent. */
function readSkillsMarkerAt(root) {
  const text = readText(join(root, '.jitx-skills.json'))
  const data = text ? parseJson(text) : undefined
  return data && Array.isArray(data.skills) ? data : undefined
}

/**
 * Read the skills install marker, preferring the project root over the user root.
 *
 * @param {string} dir project directory.
 * @returns {object|undefined} marker with `root` and `scope` attached.
 */
export function readSkillsMarker(dir) {
  const roots = skillsRoots(dir)
  for (const scope of ['project', 'user']) {
    const marker = readSkillsMarkerAt(roots[scope])
    if (marker) return { ...marker, root: roots[scope], scope }
  }
  return undefined
}

/**
 * Install the official JITx skills into the project, or the user root.
 *
 * `scope: 'auto'` (default) writes `<project>/.dsh/skills` and only falls back
 * to `$DSH_HOME/skills` when the project root is not writable. Project skills
 * win over user skills because the skill registry ranks project roots above
 * bundled and user roots.
 *
 * A fresh clone is downloaded with git, falling back to the GitHub tarball
 * (curl + tar) when git is unavailable. The install is idempotent: an existing
 * marker short-circuits unless `force` is set.
 *
 * @param {{dir: string, scope?: 'auto'|'project'|'user', ref?: string, force?: boolean, signal?: AbortSignal}} options
 * @returns {Promise<object>} install summary.
 */
export async function installSkills(options) {
  const { dir, signal } = options
  const ref = options.ref?.trim() || 'main'
  const requested = options.scope === 'project' || options.scope === 'user' ? options.scope : 'auto'
  const roots = skillsRoots(dir)
  const existing = readSkillsMarker(dir)
  const destination = requested === 'user' ? roots.user : roots.project
  if (existing && !options.force && (requested === 'auto' || existing.scope === requested)) {
    return { installed: false, already: true, destination: existing.root, ...existing }
  }

  const temporary = mkdtempSync(join(tmpdir(), 'dsh-jitx-skills-'))
  let sourceDirectory
  let commit
  let source = 'git'
  try {
    const clone = await run('git', ['clone', '--depth', '1', '--branch', ref, SKILLS_REPO, temporary], {
      timeoutMs: 300_000,
      signal,
    })
    if (clone.code !== 0) {
      const tarball = await downloadTarball(ref, temporary, signal)
      source = tarball.source
      sourceDirectory = tarball.sourceDirectory
    } else {
      commit = await gitCommit(temporary)
    }
  } catch (error) {
    throw new Error(`Could not download ${SKILLS_REPO}: ${error.message}`)
  }
  sourceDirectory ??= join(temporary, 'skills')

  const skillsRoot = existsSync(sourceDirectory) ? sourceDirectory : findSkillsDirectory(temporary)
  if (!skillsRoot) {
    throw new Error(`The JITx skills archive did not contain a skills directory (${source}).`)
  }

  const names = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort()
  if (names.length === 0) throw new Error(`No SKILL.md files found under ${skillsRoot}.`)

  let scope = requested
  let root = destination
  try {
    mkdirSync(root, { recursive: true })
  } catch (error) {
    const deny = ['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'ENOENT'].includes(error.code)
    if (requested !== 'auto' || !deny) throw error
    scope = 'user'
    root = roots.user
    mkdirSync(root, { recursive: true })
  }
  for (const name of names) {
    const target = join(root, name)
    rmSync(target, { recursive: true, force: true })
    cpSync(join(skillsRoot, name), target, { recursive: true })
  }

  const marker = {
    repo: 'https://github.com/JITx-Inc/jitx-skills',
    ref,
    commit: commit ?? null,
    source,
    installedAt: new Date().toISOString(),
    skills: names,
  }
  writeFileSync(join(root, '.jitx-skills.json'), `${JSON.stringify(marker, null, 2)}\n`)
  rmSync(temporary, { recursive: true, force: true })

  return { installed: true, already: false, destination: root, scope, fellBack: scope !== requested && requested === 'auto', ...marker }
}

/** Download and extract the repository tarball when git is unavailable. */
async function downloadTarball(ref, directory, signal) {
  const url = `https://codeload.github.com/JITx-Inc/jitx-skills/tar.gz/refs/heads/${encodeURIComponent(ref)}`
  const archive = join(directory, 'skills.tar.gz')
  const curl = findExecutable('curl')
  if (!curl) throw new Error('git clone failed and curl is not available for the tarball fallback.')
  const download = await run(curl, ['-fsSL', '--retry', '2', '-o', archive, url], { timeoutMs: 300_000, signal })
  if (download.code !== 0) {
    throw new Error(`git clone and tarball download both failed:\n${tail(download.stderr, 8)}\nSet HTTPS_PROXY if the network requires a proxy.`)
  }
  const extract = await run('tar', ['-xzf', archive, '-C', directory], { timeoutMs: 180_000, signal })
  if (extract.code !== 0) throw new Error(`Could not extract the skills tarball:\n${tail(extract.stderr, 8)}`)
  const prefixes = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('jitx-skills-'))
    .map((entry) => entry.name)
  const root = prefixes.length === 1 ? join(directory, prefixes[0]) : undefined
  return {
    source: 'tarball',
    sourceDirectory: root ? join(root, 'skills') : undefined,
  }
}

/** Find a nested `skills` directory inside an extracted archive. */
function findSkillsDirectory(root) {
  const candidates = [join(root, 'skills')]
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'skills') candidates.push(join(root, entry.name, 'skills'))
  }
  return candidates.find((candidate) => existsSync(candidate))
}

/** Read the cloned repository's HEAD commit. */
async function gitCommit(directory) {
  const result = await run('git', ['-C', directory, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 })
  return result.code === 0 ? result.stdout.trim() : undefined
}

/**
 * Decide whether the profile composes the dsh-workspace-mcp bundle.
 *
 * The profile manifest is the source of truth: the bundle must be selected,
 * and an explicit row override may still disable it or set enabled: false.
 *
 * @param {string} [profileDir] - defaults to $DSH_PROFILE_DIR.
 * @returns {{active: boolean, installed: boolean, disabled: boolean, profileDir?: string, reason: string}}
 */
export function detectWorkspaceMcp(profileDir = process.env.DSH_PROFILE_DIR) {
  if (!profileDir) {
    return { active: false, installed: false, disabled: false, reason: 'DSH_PROFILE_DIR is not set; treating the profile as unknown' }
  }
  const manifestText = readText(join(profileDir, 'package.json'))
  const manifest = manifestText ? parseJson(manifestText) : undefined
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  const dependencies = manifest?.dependencies ?? {}
  const declared = bundles.includes('dsh-workspace-mcp')
  const present = Object.hasOwn(dependencies, 'dsh-workspace-mcp')
  const installed = declared
  const patch = readText(join(profileDir, 'cordis.patch.yml')) ?? ''
  const row = findPatchRow(patch, 'workspace-mcp')
  const disabled = row ? /(^|\n)\s*disabled:\s*true/.test(row) || /(^|\n)\s*enabled:\s*false/.test(row) : false
  const active = installed && !disabled
  return {
    active,
    installed,
    disabled,
    profileDir,
    reason: active
      ? 'dsh-workspace-mcp is selected; project .dsh/mcp.json is the correct scope'
      : !manifest
        ? 'profile package.json is unreadable; cannot prove workspace-mcp is active'
        : !declared
          ? present
            ? 'dsh-workspace-mcp is installed but not selected in the profile bundle list'
            : 'dsh-workspace-mcp is not selected in the profile bundle list'
          : 'the workspace-mcp row is disabled in cordis.patch.yml',
  }
}

/** Extract the YAML text of one top-level row id (enough for a disabled flag). */
function findPatchRow(patch, id) {
  const matcher = new RegExp(`(^|\\n)\\s*-\\s*id:\\s*${id}\\s*(\\n|$)`)
  const match = matcher.exec(patch)
  if (!match) return undefined
  const start = match.index + (match[1] ? 1 : 0)
  const rest = patch.slice(start + 1)
  const next = /\n\s*-?\s*id:/.exec(rest)
  return patch.slice(start, next ? start + 1 + next.index : patch.length)
}

/** Absolute path of the project MCP configuration file workspace-mcp reads. */
export function projectMcpFile(dir) {
  return join(dir, '.dsh', 'mcp.json')
}

/**
 * Read a project MCP file without inventing one.
 * @param {string} dir - project root.
 * @returns {{file: string, exists: boolean, data?: object, error?: string}}
 */
export function readProjectMcp(dir) {
  const file = projectMcpFile(dir)
  const text = readText(file)
  if (text === undefined) return { file, exists: false }
  try {
    const data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { file, exists: true, error: 'top level must be a JSON object' }
    }
    return { file, exists: true, data }
  } catch (error) {
    return { file, exists: true, error: `invalid JSON: ${error.message}` }
  }
}

/**
 * Build the stdio launch declaration for the bundled JITx MCP server.
 * @param {string} dir - project root the server is bound to.
 * @param {string} [uv] - absolute uv path discovered during setup.
 * @param {string} [profileDir] - profile directory, so the server can report scope.
 * @returns {object} project-file / mcp-manager compatible entry.
 */
export function mcpServerEntry(dir, uv, profileDir) {
  const env = { JITX_PROJECT: dir }
  if (uv) env.JITX_UV = uv
  if (profileDir) env.DSH_PROFILE_DIR = profileDir
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return {
    type: 'stdio',
    command: process.execPath,
    args: [MCP_SERVER_PATH],
    cwd: dir,
    env,
  }
}

/**
 * Merge the JITx server into `<project>/.dsh/mcp.json`, preserving other servers.
 * @param {string} dir - project root.
 * @param {object} entry - declaration from {@link mcpServerEntry}.
 * @returns {{file: string, created: boolean, replaced: boolean, servers: string[]}}
 */
export function writeProjectMcp(dir, entry) {
  const current = readProjectMcp(dir)
  if (current.error) throw new Error(`${current.file} ${current.error}; fix it before configuring JITx MCP.`)
  const data = current.data ?? {}
  const servers = data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers) ? data.mcpServers : {}
  const replaced = Object.hasOwn(servers, MCP_SERVER_NAME)
  servers[MCP_SERVER_NAME] = entry
  data.mcpServers = servers
  const file = projectMcpFile(dir)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`)
  renameSync(temporary, file)
  return { file, created: !current.exists, replaced, servers: Object.keys(servers) }
}

/** Remove the JITx server from the project file, if present. */
export function removeProjectMcp(dir) {
  const current = readProjectMcp(dir)
  if (!current.exists) return { removed: false, file: current.file }
  if (current.error) throw new Error(`${current.file} ${current.error}`)
  const servers = current.data?.mcpServers
  if (!servers || !Object.hasOwn(servers, MCP_SERVER_NAME)) return { removed: false, file: current.file }
  delete servers[MCP_SERVER_NAME]
  writeFileSync(current.file, `${JSON.stringify(current.data, null, 2)}\n`)
  return { removed: true, file: current.file }
}

/**
 * Persist a profile-wide JITx server into the mcp-manager configuration.
 *
 * The profile patch is the source of truth, so the entry is written through
 * the config-editor service (which validates against the live manager schema
 * and survives restarts). When that service is absent the registration falls
 * back to the manager's lifetime-bound `register()`.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} entry - stdio declaration.
 * @returns {Promise<{ok: boolean, persisted?: boolean, already?: boolean, reason?: string}>}
 */
export async function configureGlobalMcp(ctx, entry) {
  const fields = {
    transport: 'stdio',
    command: entry.command,
    args: entry.args,
    env: entry.env,
    cwd: entry.cwd,
    enabled: true,
  }
  const editor = ctx.get('configEditor', false)
  if (editor && typeof editor.edit === 'function') {
    const target = editor.entries().find((candidate) => candidate.options.name === '@deepseek-ai/dsh-mcp-manager')
    if (!target) return { ok: false, reason: 'the mcp-manager loader entry is not editable in this profile' }
    let already = false
    try {
      await editor.edit(target, (current) => {
        const servers = current.servers && typeof current.servers === 'object' ? { ...current.servers } : {}
        already = Object.hasOwn(servers, MCP_SERVER_NAME)
        servers[MCP_SERVER_NAME] = fields
        return { ...current, servers }
      })
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) }
    }
    return { ok: true, persisted: true, already }
  }
  let manager
  try {
    manager = ctx.get('mcpManager', false)
  } catch {
    manager = undefined
  }
  if (!manager || typeof manager.register !== 'function') {
    return { ok: false, reason: 'neither configEditor nor the mcp-manager service is mounted in this profile' }
  }
  try {
    manager.register(MCP_SERVER_NAME, fields)
    return { ok: true, persisted: false }
  } catch (error) {
    if (/already configured or registered/i.test(String(error?.message))) return { ok: true, persisted: false, already: true }
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/** Report the global manager's view of the JITx server, when available. */
export function globalMcpStatus(ctx) {
  try {
    const manager = ctx.get('mcpManager', false)
    if (!manager) return { available: false }
    const entry = manager.list().find((server) => server.name === MCP_SERVER_NAME)
    return { available: true, registered: Boolean(entry), state: entry?.status?.state }
  } catch {
    return { available: false }
  }
}
