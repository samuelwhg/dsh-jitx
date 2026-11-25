/**
 * Minimal smoke test for dsh-jitx: project MCP file handling and the stdio
 * MCP handshake. Run with `node test/smoke.mjs`.
 *
 * No network, no uv install: the MCP part only checks the protocol and the
 * read-only path against a directory that may be an empty project.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MCP_SERVER_PATH,
  configureGlobalMcp,
  detectWorkspaceMcp,
  pinnedVersions,
  readSkillsMarker,
  mcpServerEntry,
  readProjectMcp,
  removeProjectMcp,
  tarballUrls,
  writeProjectMcp,
} from '../lib/jitx.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-jitx-smoke-'))

try {
  // An existing unrelated server must survive the merge, and remove must not
  // delete the file when only our entry is present.
  writeFileSync(join(root, 'keep.txt'), 'x')
  const first = writeProjectMcp(root, mcpServerEntry(root, '/usr/bin/uv'))
  assert.equal(first.created, true)
  assert.equal(first.replaced, false)
  const withOther = readProjectMcp(root)
  withOther.data.mcpServers.other = { type: 'stdio', command: 'true' }
  writeFileSync(withOther.file, JSON.stringify(withOther.data))
  const second = writeProjectMcp(root, mcpServerEntry(root, '/usr/bin/uv'))
  assert.equal(second.replaced, true)
  const merged = readProjectMcp(root)
  assert.deepEqual(Object.keys(merged.data.mcpServers).sort(), ['jitx', 'other'])
  assert.equal(merged.data.mcpServers.jitx.env.JITX_PROJECT, root)
  assert.deepEqual(removeProjectMcp(root), { removed: true, file: merged.file })
  assert.deepEqual(Object.keys(readProjectMcp(root).data.mcpServers), ['other'])

  // A ref may be a tag, so the tarball fallback must try tags as well as branches.
  assert.deepEqual(tarballUrls('v4.6.0').map((url) => new URL(url).pathname), [
    '/JITx-Inc/jitx-skills/tar.gz/refs/heads/v4.6.0',
    '/JITx-Inc/jitx-skills/tar.gz/refs/tags/v4.6.0',
  ])

  // The setup fast path keys off exact pins in pyproject.toml.
  const pinned = join(root, 'pinned')
  mkdirSync(pinned, { recursive: true })
  writeFileSync(join(pinned, 'pyproject.toml'), '[project]\ndependencies = [\n  "jitx==4.6.0",\n  "jitxlib-standard==4.6.0",\n]\n')
  assert.deepEqual(pinnedVersions(pinned), { jitx: '4.6.0', jitxlib: '4.6.0' })
  assert.deepEqual(pinnedVersions(join(root, 'no-pyproject')), { jitx: undefined, jitxlib: undefined })

  // Detection must always answer with a decision, never throw.
  const detection = detectWorkspaceMcp()
  assert.equal(typeof detection.active, 'boolean')
  assert.equal(typeof detection.reason, 'string')

  // A dependency without the bundle entry must not count as active.
  const profile = join(root, 'profile')
  mkdirSync(profile, { recursive: true })
  const manifest = (bundles) =>
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-workspace-mcp': '^0.2.1' }, dsh: { profile: { bundles } } }))
  manifest([])
  assert.equal(detectWorkspaceMcp(profile).active, false)
  manifest(['dsh-workspace-mcp'])
  assert.equal(detectWorkspaceMcp(profile).active, true)
  writeFileSync(join(profile, 'cordis.patch.yml'), '- insert:\n    - id: workspace-mcp\n      disabled: true\n')
  assert.equal(detectWorkspaceMcp(profile).active, false)

  // Skills markers prefer the project root and fall back to $DSH_HOME/skills.
  const previousDshHome = process.env.DSH_HOME
  const dshHome = join(root, 'dsh-home')
  process.env.DSH_HOME = dshHome
  const skillProject = join(root, 'skill-project')
  mkdirSync(join(skillProject, '.dsh', 'skills'), { recursive: true })
  mkdirSync(join(dshHome, 'skills'), { recursive: true })
  const marker = JSON.stringify({ skills: ['jitx'] })
  writeFileSync(join(dshHome, 'skills', '.jitx-skills.json'), marker)
  assert.equal(readSkillsMarker(skillProject).scope, 'user')
  writeFileSync(join(skillProject, '.dsh', 'skills', '.jitx-skills.json'), marker)
  assert.equal(readSkillsMarker(skillProject).scope, 'project')
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome

  // Global wiring goes through config-editor and preserves sibling servers.
  const edits = []
  const fakeContext = {
    get: (name) =>
      name === 'configEditor'
        ? {
            entries: () => [{ options: { id: 'mcp-manager', name: '@deepseek-ai/dsh-mcp-manager' } }],
            edit: async (entry, change) => void edits.push(change({ servers: { other: { transport: 'stdio' } } }, {})),
          }
        : undefined,
  }
  const global = await configureGlobalMcp(fakeContext, mcpServerEntry(root, '/usr/bin/uv', profile))
  assert.equal(global.persisted, true)
  assert.deepEqual(Object.keys(edits[0].servers).sort(), ['jitx', 'other'])
  assert.equal(edits[0].servers.jitx.transport, 'stdio')
  assert.equal(edits[0].servers.jitx.env.DSH_PROFILE_DIR, profile)
  assert.ok(readFileSync(MCP_SERVER_PATH, 'utf8').includes('jitx_status'))

  // Protocol: initialize, tools/list, then one failing tool call.
  const child = spawn(process.execPath, [MCP_SERVER_PATH], {
    env: { ...process.env, JITX_PROJECT: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const resolve = pending.get(message.id)
      if (resolve) {
        pending.delete(message.id)
        resolve(message)
      }
    }
  })
  const request = (id, method, params) =>
    new Promise((resolve, reject) => {
      pending.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000)
    })

  const init = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })
  assert.equal(init.result.serverInfo.name, 'jitx')
  assert.ok(init.result.capabilities.tools)

  const list = await request(2, 'tools/list', {})
  assert.deepEqual(list.result.tools.map((tool) => tool.name).sort(), ['jitx_cli', 'jitx_status'])

  const refused = await request(3, 'tools/call', { name: 'jitx_cli', arguments: { args: ['rm', '-rf', '/'] } })
  assert.equal(refused.result.isError, true)
  assert.match(refused.result.content[0].text, /Refusing to run "rm"/)

  const unknown = await request(4, 'tools/call', { name: 'nope', arguments: {} })
  assert.equal(unknown.result.isError, true)

  child.stdin.end()
  await new Promise((resolve) => child.on('exit', resolve))
  console.log('smoke: ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
