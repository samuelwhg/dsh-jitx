#!/usr/bin/env node
/**
 * JITx stdio MCP server.
 *
 * Speaks newline-delimited JSON-RPC 2.0 on stdio, so it works with the DSH
 * mcp-manager and workspace-mcp project files as well as any other MCP client.
 * It is intentionally small: two read-only tools over the project's uv-managed
 * JITx CLI, no network calls, no writes.
 *
 * Environment:
 *   JITX_PROJECT  project directory (defaults to the process working directory)
 *   JITX_UV       absolute uv executable (defaults to PATH lookup)
 *
 * @module dsh-jitx/mcp
 */

import { createInterface } from 'node:readline'
import { isAbsolute, resolve } from 'node:path'
import { MCP_SERVER_NAME, checkProject, detectWorkspaceMcp, readProjectMcp } from '../lib/jitx.js'
import { findExecutable, run } from '../lib/run.js'

const SERVER_VERSION = '0.1.0'
const ALLOWED_COMMANDS = new Set(['project', 'design', 'runtime', 'auth', 'support', 'ui'])

/** Resolve the project directory from arguments or the environment. */
function projectDirectory(raw) {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : process.env.JITX_PROJECT || process.cwd()
  return isAbsolute(value) ? value : resolve(process.cwd(), value)
}

/** Resolve uv, or return undefined with an actionable message. */
function resolveUv() {
  const configured = process.env.JITX_UV
  if (configured) return configured
  return findExecutable('uv')
}

/** Tool catalogue advertised by tools/list. */
const TOOLS = [
  {
    name: 'jitx_status',
    description:
      'Report the state of a JITx project: uv, pyproject.toml, uv.lock, .venv, Python, the pinned jitx CLI, the runtime, license, and installed skills. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Project directory (default: JITX_PROJECT or the server working directory).' },
      },
    },
  },
  {
    name: 'jitx_cli',
    description:
      'Run the project JITx CLI through uv and return its output. The first argument must be one of project, design, runtime, auth, support, ui; use it for commands such as `design find` or `runtime status`.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Project directory (default: JITX_PROJECT or the server working directory).' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments passed to jitx, e.g. ["design", "find"].',
        },
        timeoutSeconds: { type: 'number', description: 'Command timeout in seconds (default 120, maximum 1800).' },
      },
      required: ['args'],
    },
  },
]

/** Execute jitx_status. */
async function statusTool(args) {
  const dir = projectDirectory(args?.directory)
  const result = await checkProject({ dir })
  const mcp = detectWorkspaceMcp()
  const project = readProjectMcp(dir)
  const projectServer = Boolean(project.data?.mcpServers && Object.hasOwn(project.data.mcpServers, MCP_SERVER_NAME))
  const lines = [
    `JITx project: ${result.directory}`,
    `Platform: ${result.platform}`,
    ...result.checks.map((check) => `[${check.ok ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}${check.fix ? ` (fix: ${check.fix})` : ''}`),
    `MCP scope: ${mcp.active || projectServer ? 'project (.dsh/mcp.json)' : 'global (mcp-manager)'} — ${mcp.reason}`,
  ]
  return { text: lines.join('\n'), isError: false }
}

/** Execute jitx_cli. */
async function cliTool(args) {
  const command = Array.isArray(args?.args) ? args.args.map((value) => String(value)) : []
  if (command.length === 0) throw new Error('args must contain at least one JITx command name.')
  if (!ALLOWED_COMMANDS.has(command[0])) {
    throw new Error(`Refusing to run "${command[0]}"; allowed commands: ${[...ALLOWED_COMMANDS].join(', ')}.`)
  }
  const uv = resolveUv()
  if (!uv) throw new Error('uv is not on PATH; install uv (https://docs.astral.sh/uv/) or set JITX_UV.')
  const dir = projectDirectory(args?.directory)
  const seconds = Number.isFinite(args?.timeoutSeconds) ? Math.min(Math.max(args.timeoutSeconds, 1), 1800) : 120
  const result = await run(uv, ['run', '--project', dir, 'jitx', ...command], {
    cwd: dir,
    timeoutMs: seconds * 1000,
  })
  const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n')
  const text = output || `jitx ${command.join(' ')} exited with code ${result.code ?? 'unknown'}.`
  return { text, isError: result.code !== 0 || result.timedOut === true }
}

/** Dispatch one tools/call request. */
async function callTool(params) {
  const fn = params?.name === 'jitx_status' ? statusTool : params?.name === 'jitx_cli' ? cliTool : undefined
  if (!fn) throw new Error(`Unknown tool "${params?.name}".`)
  const result = await fn(params?.arguments ?? {})
  return { content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) }
}

/** Write one JSON-RPC frame. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** Handle one JSON-RPC request object; notifications produce no response. */
async function handle(message) {
  if (!message || typeof message !== 'object') return
  if (message.id === undefined) return
  const { id, method, params } = message
  const reply = (result) => send({ jsonrpc: '2.0', id, result })
  const fail = (code, text) => send({ jsonrpc: '2.0', id, error: { code, message: text } })

  try {
    switch (method) {
      case 'initialize':
        reply({
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: SERVER_VERSION },
          instructions: 'Use jitx_status before board work and jitx_cli to run the project JITx CLI through uv.',
        })
        return
      case 'ping':
        reply({})
        return
      case 'tools/list':
        reply({ tools: TOOLS })
        return
      case 'tools/call':
        reply(await callTool(params))
        return
      default:
        fail(-32601, `Method not found: ${method}`)
    }
  } catch (error) {
    const text = String(error?.message ?? error)
    if (method === 'tools/call') reply({ content: [{ type: 'text', text }], isError: true })
    else fail(-32603, text)
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
/** In-flight requests; stdin may close before a tool call settles. */
const inflight = new Set()
reader.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: each line must be one JSON-RPC frame.' } })
    return
  }
  const task = handle(message).finally(() => inflight.delete(task))
  inflight.add(task)
})
reader.on('close', async () => {
  await Promise.allSettled([...inflight])
  process.exit(0)
})
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
