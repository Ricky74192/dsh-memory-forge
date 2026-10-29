import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { DEFAULTS, dshHome, normalizeConfig } from '../src/config.js'

const ENV = { DSH_HOME: 'C:\\harness-home' }

test('defaults derive absolute roots from DSH_HOME', () => {
  const { config, warnings } = normalizeConfig({}, { env: ENV })
  assert.deepEqual(warnings, [])
  assert.equal(config.memoryRoot, join('C:\\harness-home', 'memory'))
  assert.equal(config.skillsRoot, join('C:\\harness-home', 'skills'))
  assert.equal(config.autoCapture, DEFAULTS.autoCapture)
  assert.equal(config.recallOn, 'first-step')
})

test('missing or non-object config falls back to defaults with one warning', () => {
  const fromString = normalizeConfig('nonsense', { env: ENV })
  assert.equal(fromString.warnings.length, 1)
  assert.match(fromString.warnings[0], /must be a mapping/)
  assert.deepEqual(normalizeConfig(null, { env: ENV }).warnings, [])
})

test('relative roots resolve against the process directory and ~ expands', () => {
  const { config } = normalizeConfig({ memoryRoot: 'relative/memory', skillsRoot: '~/skills' }, { env: ENV })
  assert.ok(config.memoryRoot.endsWith(join('relative', 'memory')))
  assert.ok(config.skillsRoot.endsWith(join('skills')))
  assert.ok(config.skillsRoot !== '~/skills')
})

test('numbers are clamped into their supported range with warnings', () => {
  const { config, warnings } = normalizeConfig({ maxRecallItems: 500, recallMinScore: -3, halfLifeDays: 99999 }, { env: ENV })
  assert.equal(config.maxRecallItems, 50)
  assert.equal(config.recallMinScore, 0)
  assert.equal(config.halfLifeDays, 3650)
  assert.equal(warnings.length, 3)
})

test('numeric strings are accepted, junk is reported', () => {
  const { config, warnings } = normalizeConfig({ maxRecallItems: '3', recallMaxChars: 'lots' }, { env: ENV })
  assert.equal(config.maxRecallItems, 3)
  assert.equal(config.recallMaxChars, DEFAULTS.recallMaxChars)
  assert.equal(warnings.length, 1)
})

test('booleans accept YAML-style spellings', () => {
  const { config, warnings } = normalizeConfig({ autoCapture: 'no', captureAssistant: 'YES', debug: 'on' }, { env: ENV })
  assert.equal(config.autoCapture, false)
  assert.equal(config.captureAssistant, true)
  assert.equal(config.debug, true)
  assert.deepEqual(warnings, [])
})

test('recallOn rejects unknown cadences', () => {
  const { config, warnings } = normalizeConfig({ recallOn: 'sometimes' }, { env: ENV })
  assert.equal(config.recallOn, 'first-step')
  assert.equal(warnings.length, 1)
})

test('minCaptureChars never exceeds maxCaptureChars', () => {
  const { config, warnings } = normalizeConfig({ minCaptureChars: 900, maxCaptureChars: 100 }, { env: ENV })
  assert.equal(config.minCaptureChars, 100)
  assert.equal(warnings.length, 1)
})

test('dshHome prefers DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(dshHome({ DSH_HOME: 'C:\\x' }), 'C:\\x')
  assert.ok(dshHome({}).endsWith('.dsh'))
})
