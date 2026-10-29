import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { workspaceKey } from '../src/store.js'
import { MemoryStore } from '../src/store.js'
import { buildTools } from '../src/tools.js'

const NOW = Date.UTC(2026, 9, 29)
const CWD = 'C:\\Work\\Project'

/**
 * Build a tool set backed by isolated storage.
 * @returns {{tools: Map<string, any>, store: MemoryStore, skillsRoot: string, exec: any, key: string}} the fixture.
 */
function fixture() {
  const store = new MemoryStore({ root: mkdtempSync(join(tmpdir(), 'dsh-memory-forge-tools-')), now: () => NOW, logger: { warn: () => {} } })
  const skillsRoot = mkdtempSync(join(tmpdir(), 'dsh-memory-forge-tools-skills-'))
  const config = { maxCaptureChars: 4000, skillsRoot, includeGlobalScope: true, halfLifeDays: 30 }
  const tools = buildTools({ store, config, logger: { info: () => {}, warn: () => {} } })
  const exec = { agent: { session: { id: 'session-1', header: { cwd: CWD } } } }
  return { tools: new Map(tools.map((tool) => [tool.name, tool])), store, skillsRoot, exec, key: workspaceKey(CWD) }
}

/**
 * Walk every schema node.
 * @param {any} schema - JSON schema node.
 * @param {(node: any, path: string) => void} visit - visitor.
 * @param {string} [path] - current path.
 */
function walkSchema(schema, visit, path = '$') {
  if (schema === null || typeof schema !== 'object') return
  visit(schema, path)
  for (const [key, value] of Object.entries(schema.properties ?? {})) walkSchema(value, visit, `${path}.${key}`)
  if (schema.items !== undefined) walkSchema(schema.items, visit, `${path}[]`)
}

test('every tool satisfies the registry contract', () => {
  const { tools } = fixture()
  assert.deepEqual([...tools.keys()], ['memory_save', 'memory_search', 'memory_forget', 'memory_distill_skill'])
  for (const [name, tool] of tools) {
    assert.ok(tool.description.length > 40, `${name} needs a model-facing description`)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.output.schema, 'object')
    assert.equal(typeof tool.output.render, 'function', `${name} must declare output.render`)
    assert.equal(typeof tool.execute, 'function')
  }
})

test('no schema marks a property with the boolean required the registry rejects', () => {
  const { tools } = fixture()
  for (const [name, tool] of tools) {
    for (const schema of [tool.parameters, tool.output.schema]) {
      walkSchema(schema, (node, path) => {
        assert.notEqual(node.required, true, `${name}: ${path} uses per-property required, which the tool registry rejects`)
        if (node.required !== undefined) assert.ok(Array.isArray(node.required), `${name}: ${path}.required must be an array`)
      })
    }
  }
})

test('memory_save stores into the workspace namespace and reports the id', async () => {
  const { tools, store, exec, key } = fixture()
  const saved = await tools.get('memory_save').execute({ text: 'The build uses pnpm 11, not npm.' }, exec)
  assert.match(saved.id, /^mem_/)
  assert.equal(saved.scope, 'workspace')
  assert.equal(saved.chars, 'The build uses pnpm 11, not npm.'.length)
  assert.match(saved.storedAt, /^\d{4}-\d\d-\d\dT/)
  const stored = store.load('workspace', key)
  assert.equal(stored.length, 1)
  assert.equal(stored[0].text, 'The build uses pnpm 11, not npm.')
  assert.equal(stored[0].sessionId, 'session-1')
})

test('memory_save rejects empty text and honours the global scope', async () => {
  const { tools, store, exec } = fixture()
  await assert.rejects(() => tools.get('memory_save').execute({ text: '   ' }, exec), /text must be a non-empty string/)
  const saved = await tools.get('memory_save').execute({ text: 'Prefer TypeScript strict mode.', scope: 'global' }, exec)
  assert.equal(saved.scope, 'global')
  assert.equal(store.load('global', 'global').length, 1)
})

test('memory_search finds a saved memory with a bounded score', async () => {
  const { tools, exec } = fixture()
  await tools.get('memory_save').execute({ text: 'Release artifacts are verified with pnpm pack before publishing.' }, exec)
  const found = await tools.get('memory_search').execute({ query: 'how do we verify a release artifact?' }, exec)
  assert.equal(found.total, 1)
  assert.equal(found.results[0].scope, 'workspace')
  assert.ok(found.results[0].score > 0 && found.results[0].score <= 1)
  assert.match(found.results[0].createdAt, /^\d{4}-/)
})

test('memory_search can be restricted to one namespace', async () => {
  const { tools, exec } = fixture()
  await tools.get('memory_save').execute({ text: 'Workspace fact about the build pipeline.' }, exec)
  await tools.get('memory_save').execute({ text: 'Global preference about the build pipeline.', scope: 'global' }, exec)
  const globalOnly = await tools.get('memory_search').execute({ query: 'build pipeline', scope: 'global' }, exec)
  assert.equal(globalOnly.total, 1)
  assert.equal(globalOnly.results[0].scope, 'global')
})

test('memory_search returns an empty result instead of failing on no match', async () => {
  const { tools, exec } = fixture()
  const found = await tools.get('memory_search').execute({ query: 'kubernetes ingress controller' }, exec)
  assert.deepEqual(found, { total: 0, results: [] })
})

test('memory_search rejects an empty query', async () => {
  const { tools, exec } = fixture()
  await assert.rejects(() => tools.get('memory_search').execute({ query: '' }, exec), /query must be a non-empty string/)
})

test('memory_forget deletes once and then reports a missing id', async () => {
  const { tools, exec } = fixture()
  const saved = await tools.get('memory_save').execute({ text: 'A note that will be removed again.' }, exec)
  assert.deepEqual(await tools.get('memory_forget').execute({ id: saved.id }, exec), { removed: true, scope: 'workspace' })
  assert.deepEqual(await tools.get('memory_forget').execute({ id: saved.id }, exec), { removed: false })
})

test('memory_distill_skill writes a skill and records it as a memory', async () => {
  const { tools, store, skillsRoot, exec, key } = fixture()
  const result = await tools.get('memory_distill_skill').execute(
    {
      name: 'verify-release-artifact',
      description: 'Use when publishing a release artifact.',
      body: '## Steps\n\n1. Run `pnpm build`.\n2. Verify with `pnpm pack`.',
      sources: ['mem_example'],
    },
    exec,
  )
  assert.equal(result.status, 'created')
  assert.equal(result.path, join(skillsRoot, 'verify-release-artifact', 'SKILL.md'))
  assert.equal(existsSync(result.path), true)
  assert.equal(store.load('workspace', key).filter((entry) => entry.kind === 'skill').length, 1)
})

test('memory_distill_skill rejects an invalid name before touching the filesystem', async () => {
  const { tools, skillsRoot, exec } = fixture()
  await assert.rejects(
    () => tools.get('memory_distill_skill').execute({ name: 'Bad Name', description: 'd', body: 'b' }, exec),
    /kebab-case/,
  )
  assert.deepEqual(readdirSync(skillsRoot), [])
})
