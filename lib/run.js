/**
 * Small cross-platform process and filesystem helpers.
 *
 * Everything here works on Windows and Linux without a shell: commands are
 * spawned directly, and executables are located by scanning PATH (plus the
 * conventional `~/.local/bin` that the uv installer uses on both platforms).
 *
 * @module dsh-jitx/run
 */

import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** True on native Windows (not WSL). */
export const isWindows = process.platform === 'win32'

/** Candidate file names for an executable, in lookup order. */
function executableNames(name) {
  if (!isWindows) return [name]
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name]
}

/**
 * Scan PATH for an executable.
 * @param {string} name - command name without extension.
 * @param {NodeJS.ProcessEnv} [env] - environment to read PATH from.
 * @returns {string | undefined} absolute path of the first match.
 */
export function findExecutable(name, env = process.env) {
  if (isAbsolute(name) && isFile(name)) return name
  const pathValue = env.PATH ?? env.Path ?? ''
  const directories = pathValue.split(delimiter).filter(Boolean)
  // uv installs to ~/.local/bin on both Windows and Linux even when that
  // directory is missing from the PATH inherited by the Harness.
  directories.push(join(env.USERPROFILE ?? env.HOME ?? homedir(), '.local', 'bin'))
  for (const directory of directories) {
    for (const candidate of executableNames(name)) {
      const file = join(directory, candidate)
      if (isFile(file)) return file
    }
  }
  return undefined
}

/** True when `file` exists and is a regular file. */
export function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Run a command without a shell and capture both streams.
 * @param {string} command - absolute executable path or PATH name.
 * @param {string[]} args - argument vector, never interpolated into a shell.
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<{code: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean, aborted: boolean, error?: string}>}
 */
export function run(command, args, options = {}) {
  const { cwd, env = process.env, timeoutMs = 120_000, signal } = options
  // JITx documents PYTHONUTF8=1 on Windows so stdout stays UTF-8; inherit an
  // explicit override when the caller already set one.
  const childEnv = process.platform === 'win32' && !('PYTHONUTF8' in env) ? { ...env, PYTHONUTF8: '1' } : env
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let timer
    const finish = (code, signalName, error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, signal: signalName, stdout, stderr, timedOut, aborted, ...(error ? { error } : {}) })
    }
    const onAbort = () => {
      aborted = true
      child.kill('SIGKILL')
    }
    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => finish(-1, null, error.message))
    child.on('close', (code, signalName) => finish(code, signalName))
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      timer.unref?.()
    }
  })
}

/** Last `count` non-empty lines of captured output, for compact reports. */
export function tail(text, count = 8) {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.trim().length > 0)
  return lines.slice(-count).join('\n')
}

/** Format one completed run for a report line. */
export function describeRun(result) {
  if (result.error) return `spawn failed: ${result.error}`
  if (result.timedOut) return `timed out after ${result.timeoutMs ?? 'the configured budget'}`
  if (result.aborted) return 'cancelled'
  return result.code === 0 ? 'ok' : `exit ${result.code}${result.stderr ? `: ${tail(result.stderr, 4)}` : ''}`
}

/** Read `/etc/os-release`'s ID on Linux; undefined elsewhere. */
export function linuxDistro() {
  if (process.platform !== 'linux') return undefined
  try {
    const text = readFileSync('/etc/os-release', 'utf8')
    return /^ID=(.*)$/m.exec(text)?.[1]?.replace(/^"|"$/g, '').trim()
  } catch {
    return undefined
  }
}

/** True inside WSL. */
export function isWsl() {
  return Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(linuxDistro() ?? '')
}

/**
 * Runtime build target to pass to `jitx runtime install --target`.
 * JITx auto-detects Ubuntu, macOS and Windows; every other host needs an
 * explicit build, and Ubuntu is the documented fallback.
 * @returns {'ubuntu' | 'macos' | 'windows' | undefined} undefined means auto.
 */
export function defaultRuntimeTarget() {
  if (process.platform === 'win32') return undefined
  if (process.platform === 'darwin') return undefined
  if (process.platform === 'linux') {
    if (isWsl()) return 'ubuntu'
    return linuxDistro() === 'ubuntu' ? undefined : 'ubuntu'
  }
  return 'ubuntu'
}

/** Human-readable platform label for reports. */
export function platformLabel() {
  if (process.platform === 'win32') return 'Windows'
  if (process.platform === 'darwin') return 'macOS'
  const distro = linuxDistro()
  return `Linux${distro ? ` (${distro})` : ''}${isWsl() ? ' / WSL' : ''}`
}

/**
 * Resolve a path that may contain a leading `~`.
 * @param {string} value - user-supplied path.
 * @returns {string} absolute path.
 */
export function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** Read a UTF-8 file, returning undefined instead of throwing. */
export function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

