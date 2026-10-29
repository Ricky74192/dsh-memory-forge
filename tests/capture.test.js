import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { captureProposed, captureTurn, latestUserText, proposedUserText, recallMessage, turnEvents } from '../index.js'
import { MemoryStore } from '../src/store.js'

const NOW = Date.UTC(2026, 9, 29)

/**
 * Build a fake session over a fixed event list.
 * @param {Array<Record<string, any>>} events - events indexed by sequence number.
 * @returns {{seq: number, eventAt: (seq: number) => any}} the session stub.
 */
function session(events) {
  return { seq: events.length, eventAt: (seq) => events[seq] }
}

/**
 * Build a fresh store with an isolated root.
 * @returns {MemoryStore} the store.
 */
function store() {
  return new MemoryStore({ root: mkdtempSync(join(tmpdir(), 'dsh-memory-capture-')), now: () => NOW, logger: { warn: () => {} } })
}

const CONFIG = { minCaptureChars: 10, maxCaptureChars: 4000 }

/**
 * Build one user message payload.
 * @param {string} text - message text.
 * @param {{kind?: string}} [source] - source overrides.
 * @returns {Record<string, any>} the message.
 */
function userMessage(text, source = { kind: 'user' }) {
  return { id: `id-${text}`, role: 'user', content: [{ type: 'text', text }], source }
}

/**
 * Build one assistant message payload.
 * @param {string} text - message text.
 * @returns {Record<string, any>} the message.
 */
function assistantMessage(text) {
  return { id: `id-${text}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'mock', model: 'mock' } }
}

test('turnEvents returns only the requested turn, in chronological order', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: userMessage('first turn question') },
    { type: 'assistant/message', data: assistantMessage('first turn answer') },
    { type: 'turn/end', data: {} },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: userMessage('second turn question') },
  ]
  const recent = turnEvents(session(events), 2)
  assert.deepEqual(
    recent.map(({ event }) => event.data?.content?.[0]?.text ?? event.type),
    ['second turn question'],
  )
  const previous = turnEvents(session(events), 1)
  assert.deepEqual(
    previous.filter(({ event }) => event.type.endsWith('/message')).map(({ event }) => event.data.content[0].text),
    ['first turn question', 'first turn answer'],
  )
})

test('turnEvents stops at the older turn boundary instead of scanning forever', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: userMessage('ancient question text') },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: userMessage('current question text') },
  ]
  assert.deepEqual(turnEvents(session(events), 2).map(({ event }) => event.type), ['user/message'])
})

test('captureProposed stores only real user text and deduplicates it', () => {
  const memory = store()
  const messages = [
    userMessage('a durable preference worth keeping'),
    userMessage('injected context that must not be stored', { kind: 'time-context' }),
    userMessage('too short'),
  ]
  const appended = captureProposed({ store: memory, config: CONFIG, messages, workspace: 'ws', sessionId: 's1', turn: 1 })
  assert.equal(appended, 1)
  assert.deepEqual(memory.load('workspace', 'ws').map((entry) => entry.kind), ['user'])

  const again = captureProposed({ store: memory, config: CONFIG, messages, workspace: 'ws', sessionId: 's1', turn: 1 })
  assert.equal(again, 0, 'a repeated prompt is not stored twice')
  assert.equal(memory.load('workspace', 'ws').length, 1)
})

test('captureTurn stores previous-turn assistant text once per sequence', () => {
  const memory = store()
  const fakeSession = {
    id: 'session-1',
    seq: 4,
    eventAt: (seq) =>
      [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: userMessage('a long enough question') },
        { type: 'assistant/message', data: assistantMessage('a durable answer about the build') },
        { type: 'turn/start', data: { turn: 2 } },
      ][seq],
  }
  assert.equal(captureTurn({ store: memory, config: CONFIG, session: fakeSession, workspace: 'ws', turn: 1 }), 1)
  assert.equal(captureTurn({ store: memory, config: CONFIG, session: fakeSession, workspace: 'ws', turn: 1 }), 0)
  const stored = memory.load('workspace', 'ws')
  assert.equal(stored.length, 1)
  assert.equal(stored[0].kind, 'assistant')
  assert.equal(stored[0].seq, 2)
})

test('proposedUserText picks the newest user-authored message', () => {
  const messages = [
    userMessage('the actual question from the user'),
    userMessage('recalled memory block', { kind: 'dsh-memory' }),
    assistantMessage('not a user message'),
  ]
  assert.equal(proposedUserText(messages), 'the actual question from the user')
  assert.equal(proposedUserText([]), '')
})

test('latestUserText falls back to the session log and skips own injections', () => {
  const fakeSession = session([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: userMessage('question in the log') },
    { type: 'user/message', data: userMessage('recall block in the log', { kind: 'dsh-memory' }) },
  ])
  assert.equal(latestUserText(fakeSession, 1), 'question in the log')
})

test('recallMessage is a replayable user message with a typed source', () => {
  const message = recallMessage('<system-reminder>notes</system-reminder>')
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'dsh-memory')
  assert.equal(message.source.sections[0].name, 'memory-recall')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
})
