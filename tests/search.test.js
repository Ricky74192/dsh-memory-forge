import assert from 'node:assert/strict'
import { test } from 'node:test'

import { entryText, prepareIndex, rankEntries, recencyWeight, tokenize } from '../src/search.js'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 29)

/**
 * Build one memory fixture.
 * @param {string} id - memory id.
 * @param {string} text - memory body.
 * @param {{createdAt?: number, tags?: string[], kind?: string}} [extra] - overrides.
 * @returns {Record<string, any>} the fixture.
 */
function memory(id, text, extra = {}) {
  return { id, text, kind: extra.kind ?? 'note', tags: extra.tags ?? [], createdAt: extra.createdAt ?? NOW }
}

test('tokenize keeps latin words, stems plurals, and emits CJK bigrams', () => {
  assert.deepEqual(tokenize('Fix Flaky Tests'), ['fix', 'flaky', 'tests', 'test'])
  assert.deepEqual(tokenize('记忆插件'), ['记', '忆', '插', '件', '记忆', '忆插', '插件'])
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize('   '), [])
})

test('entryText includes tags and kind so they participate in retrieval', () => {
  assert.equal(entryText({ text: 'build passes', tags: ['windows'], kind: 'note' }), 'build passes windows note')
})

test('rankEntries prefers the document that covers more of the query', () => {
  const entries = [
    memory('a', 'The build runs with pnpm and requires Node 24.'),
    memory('b', 'Unrelated note about the office coffee machine.'),
    memory('c', 'Release build notes: run pnpm build, then verify the artifact.'),
  ]
  const ranked = rankEntries(entries, 'pnpm release build', { now: NOW })
  assert.equal(ranked[0].entry.id, 'c')
  assert.equal(ranked.length, 2, 'the unrelated note shares no term and is excluded')
})

test('rankEntries returns nothing when the query shares no term', () => {
  const entries = [memory('a', 'The release build runs with pnpm build.')]
  assert.deepEqual(rankEntries(entries, 'kubernetes ingress', { now: NOW }), [])
})

test('rankEntries drops hits below minScore', () => {
  const entries = [memory('a', 'The release build runs with pnpm build and Node 24.')]
  const loose = rankEntries(entries, 'release build', { now: NOW, minScore: 0 })
  const strict = rankEntries(entries, 'release build', { now: NOW, minScore: 0.99 })
  assert.equal(loose.length, 1)
  assert.equal(strict.length, 0)
})

test('rankEntries honours limit', () => {
  const entries = Array.from({ length: 10 }, (_, index) => memory(`m${index}`, 'windows build failure retry'))
  assert.equal(rankEntries(entries, 'windows build failure', { now: NOW, limit: 3 }).length, 3)
})

test('recency discounts older memories without erasing them', () => {
  const entries = [memory('fresh', 'deploy checklist', { createdAt: NOW }), memory('stale', 'deploy checklist', { createdAt: NOW - 400 * DAY })]
  const ranked = rankEntries(entries, 'deploy checklist', { now: NOW, halfLifeDays: 30 })
  assert.equal(ranked[0].entry.id, 'fresh')
  assert.ok(ranked[1].score > 0, 'old memories stay retrievable')
  assert.ok(ranked[1].score < ranked[0].score)
  assert.equal(recencyWeight(NOW, NOW, 0), 1, 'zero half-life disables decay')
})

test('prepareIndex exposes document statistics used by idf', () => {
  const index = prepareIndex([memory('a', 'alpha beta'), memory('b', 'alpha gamma')])
  assert.equal(index.total, 2)
  assert.equal(index.documentFrequency.get('alpha'), 2)
  assert.equal(index.documentFrequency.get('beta'), 1)
  assert.ok(index.averageLength > 0)
})

test('CJK queries retrieve CJK memories', () => {
  const entries = [memory('cn', '构建失败时先清理 pnpm store，再重装依赖。'), memory('en', 'build fails: clear the pnpm store first')]
  const ranked = rankEntries(entries, '构建 失败', { now: NOW })
  assert.equal(ranked[0].entry.id, 'cn')
  assert.ok(ranked.every((hit) => hit.score > 0))
})
