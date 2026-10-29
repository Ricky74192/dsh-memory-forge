import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { MemoryStore, clipText, createId, workspaceKey } from '../src/store.js'

const NOW = Date.UTC(2026, 9, 29)

/**
 * Create a store rooted in a fresh temporary directory.
 * @returns {{store: MemoryStore, root: string, warnings: string[]}} the fixture.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-forge-store-'))
  const warnings = []
  const store = new MemoryStore({ root, now: () => NOW, logger: { warn: (message) => warnings.push(message) } })
  return { store, root, warnings }
}

test('workspaceKey is stable, path-normalizing, and bucketed by directory', () => {
  assert.equal(workspaceKey('C:\\Work\\Project'), workspaceKey('c:\\work\\project'))
  assert.notEqual(workspaceKey('C:\\Work\\One'), workspaceKey('C:\\Work\\Two'))
  assert.equal(workspaceKey(undefined), 'unscoped')
  assert.match(workspaceKey('/tmp/x'), /^[0-9a-f]{16}$/)
})

test('createId is sortable by time and unique', () => {
  const early = createId(NOW)
  const later = createId(NOW + 1000)
  assert.notEqual(early, later)
  assert.ok(later > early, 'later ids sort after earlier ids')
})

test('clipText collapses blank runs and ellipsizes overflow', () => {
  assert.equal(clipText('  a\n\n\n\n\nb  ', 100), 'a\n\n\nb')
  assert.equal(clipText('abcdef', 4), 'abc…')
})

test('append then load round-trips a memory', () => {
  const { store } = fixture()
  const record = store.append({ text: 'uses pnpm, not npm', tags: ['build'], workspace: 'ws1' })
  assert.match(record.id, /^mem_/)
  const loaded = store.load('workspace', 'ws1')
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].text, 'uses pnpm, not npm')
  assert.deepEqual(loaded[0].tags, ['build'])
  assert.equal(loaded[0].importance, 1)
})

test('namespaces isolate workspaces and expose the global scope on demand', () => {
  const { store } = fixture()
  store.append({ text: 'workspace secret', workspace: 'ws1' })
  store.append({ text: 'shared preference', workspace: 'global', scope: 'global' })

  const one = store.namespaces('ws1')
  const two = store.namespaces('ws2')
  const isolated = store.namespaces('ws1', { includeGlobal: false })
  assert.deepEqual(one.map((namespace) => namespace.entries.length), [1, 1])
  assert.deepEqual(two.map((namespace) => namespace.entries.length), [0, 1])
  assert.deepEqual(isolated.map((namespace) => namespace.entries.length), [1])
})

test('capturedSeqs makes automatic capture idempotent per session', () => {
  const { store } = fixture()
  store.append({ text: 'first turn user text', workspace: 'ws1', sessionId: 's1', seq: 3 })
  store.append({ text: 'other session text', workspace: 'ws1', sessionId: 's2', seq: 9 })
  const captured = store.capturedSeqs('s1', 'ws1')
  assert.deepEqual([...captured], [3])
})

test('search returns namespace-labelled hits scoped to the workspace', () => {
  const { store } = fixture()
  store.append({ text: 'deploy uses the staging cluster', workspace: 'ws1' })
  store.append({ text: 'deploy needs an approval token', workspace: 'ws2' })
  store.append({ text: 'deploy policy: no Fridays', workspace: 'global', scope: 'global' })

  const scoped = store.search('deploy', { workspace: 'ws1', scope: 'workspace' })
  const withGlobal = store.search('deploy', { workspace: 'ws1', scope: 'all' })
  assert.equal(scoped.length, 1)
  assert.equal(withGlobal.length, 2)
  assert.ok(withGlobal.some((hit) => hit.scope === 'global'))
})

test('remove deletes one memory and rewrites the file atomically', () => {
  const { store, root } = fixture()
  const keep = store.append({ text: 'keep this note', workspace: 'ws1' })
  const drop = store.append({ text: 'drop this note', workspace: 'ws1' })

  assert.deepEqual(store.remove(drop.id, 'ws1'), { removed: true, scope: 'workspace' })
  assert.deepEqual(store.remove(drop.id, 'ws1'), { removed: false })
  assert.deepEqual(store.load('workspace', 'ws1').map((entry) => entry.id), [keep.id])

  const raw = readFileSync(join(root, workspaceKey(undefined).replace('unscoped', 'ws1'), 'memories.jsonl'), 'utf8')
  assert.ok(raw.trim().split('\n').every((line) => JSON.parse(line).id === keep.id))
})

test('a damaged JSONL line is skipped with a warning instead of failing the load', () => {
  const { store, root, warnings } = fixture()
  const directory = join(root, 'ws1')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'memories.jsonl'), '{"id":"ok","text":"valid"}\nnot json\n{"id":"","text":"no id"}\n', 'utf8')

  const entries = store.load('workspace', 'ws1')
  assert.deepEqual(entries.map((entry) => entry.id), ['ok'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /skipped 2 damaged line/)
})

test('a missing namespace reads as empty rather than throwing', () => {
  const { store } = fixture()
  assert.deepEqual(store.load('workspace', 'never-written'), [])
})
