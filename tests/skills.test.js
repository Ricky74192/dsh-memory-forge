import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { isSkillName, validateSkillInput, writeSkill } from '../src/skills.js'

/**
 * Create an isolated skills root.
 * @returns {string} the directory.
 */
function skillsRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-skills-'))
}

test('isSkillName accepts kebab-case and rejects everything the registry rejects', () => {
  assert.equal(isSkillName('fix-windows-build'), true)
  assert.equal(isSkillName('a1'), true)
  assert.equal(isSkillName('Fix-Windows-Build'), false)
  assert.equal(isSkillName('fix--windows'), false)
  assert.equal(isSkillName('-leading'), false)
  assert.equal(isSkillName('trailing-'), false)
  assert.equal(isSkillName('has space'), false)
  assert.equal(isSkillName('x'.repeat(65)), false)
  assert.equal(isSkillName(undefined), false)
})

test('validateSkillInput reports every violation at once', () => {
  const violations = validateSkillInput({ name: 'Bad Name', description: '', body: '' })
  assert.equal(violations.length, 3)
  assert.match(violations[0], /kebab-case/)
  assert.match(violations[1], /description/)
  assert.match(violations[2], /body/)
})

test('validateSkillInput accepts a minimal valid input and optional fields', () => {
  assert.deepEqual(validateSkillInput({ name: 'ok-name', description: 'd', body: 'b' }), [])
  assert.deepEqual(validateSkillInput({ name: 'ok-name', description: 'd', body: 'b', whenToUse: 'when', sources: ['mem_1'] }), [])
  assert.equal(validateSkillInput({ name: 'ok-name', description: 'd', body: 'b', sources: [1] }).length, 1)
  assert.equal(validateSkillInput({ name: 'ok-name', description: 'd', body: 'b', whenToUse: 2 }).length, 1)
})

test('writeSkill creates then updates a bundle in place', () => {
  const root = skillsRoot()
  const first = writeSkill({
    root,
    name: 'verify-release',
    description: 'Use when publishing a release.',
    body: '## Steps\n\n1. Build.',
    sources: ['mem_1'],
    now: Date.UTC(2026, 9, 29),
  })
  assert.equal(first.status, 'created')
  assert.equal(first.bytes > 0, true)
  assert.equal(first.path, join(root, 'verify-release', 'SKILL.md'))

  const document = readFileSync(first.path, 'utf8')
  assert.match(document, /^---\n/)
  assert.match(document, /name: verify-release/)
  assert.match(document, /generatedBy: dsh-memory/)

  const second = writeSkill({
    root,
    name: 'verify-release',
    description: 'Use when publishing a release.',
    body: '## Steps\n\n1. Build.\n2. Verify.',
    sources: ['mem_1', 'mem_2'],
    now: Date.UTC(2026, 9, 30),
  })
  assert.equal(second.status, 'updated')
  const updated = readFileSync(second.path, 'utf8')
  assert.match(updated, /2\. Verify\./)
  assert.doesNotMatch(updated, /\n1\. Build\.\n1\. Build\./)
  assert.deepEqual(readdirSync(join(root, 'verify-release')), ['SKILL.md'], 'the temporary write leaves no sibling behind')
})

test('writeSkill keeps hostile content inside the frontmatter', () => {
  const root = skillsRoot()
  const result = writeSkill({
    root,
    name: 'quoted',
    description: 'Use when: the user asks for "quotes" # and colons',
    body: 'body',
    now: Date.UTC(2026, 9, 29),
  })
  const document = readFileSync(result.path, 'utf8')
  const lines = document.split('\n')
  assert.equal(lines[0], '---')
  assert.equal(lines[1], 'name: quoted')
  const description = lines[2].slice('description:'.length).trim()
  assert.equal(typeof JSON.parse(description), 'string')
  assert.equal(lines[3], 'metadata:')
})
