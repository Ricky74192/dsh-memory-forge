/**
 * dsh-memory — long-term memory and self-evolving skills for DeepSeek Harness.
 *
 * The plugin adds three things to a profile:
 *   1. Durable, searchable memories stored as JSONL under `$DSH_HOME/memory`.
 *   2. Automatic capture of conversation turns, and recall of relevant memories
 *      injected as a `<system-reminder>` block before a step.
 *   3. `memory_distill_skill`, which writes a `SKILL.md` bundle into the user
 *      skill root so a proven procedure becomes a skill every later session can
 *      load — the "self-evolution" half of the loop.
 *
 * Design constraints that shaped this file:
 *   - The package is a dependency-free Host bundle, so it imports only Node
 *     builtins and its own modules.
 *   - The session log stays the single source of truth; the memory store is a
 *     derived, human-inspectable index, never a second session log.
 *   - Anything the model sees is a normal `user` message, so recall replays,
 *     compacts, and survives session resume like any other message.
 * @module dsh-memory
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { normalizeConfig } from './src/config.js'
import { clipText, MemoryStore, workspaceKey } from './src/store.js'
import { buildTools } from './src/tools.js'
import { RECALL_HEADER, messageText, renderRecall } from './src/render.js'

/** Cordis plugin name used by loader diagnostics and as the message source kind. */
export const name = 'dsh-memory'

/** Services this plugin needs before it can activate. */
export const inject = ['tools']

/** Smallest user text worth searching memory with. */
const MIN_QUERY_CHARS = 8

/** Bound on the backwards event scan, so a huge resumed session stays cheap. */
const MAX_SCAN_EVENTS = 4000

/**
 * Compose the plugin's logger.
 * @param {any} ctx - plugin context.
 * @param {{debug: boolean, memoryRoot: string}} config - effective configuration.
 * @returns {{info: (message: string) => void, warn: (message: string) => void}} the logger.
 */
function createLogger(ctx, config) {
  const write = (level, message) => {
    try {
      if (config.debug) {
        mkdirSync(config.memoryRoot, { recursive: true })
        appendFileSync(join(config.memoryRoot, 'debug.log'), `${new Date().toISOString()} ${level} ${message}\n`, 'utf8')
      }
    } catch {
      /* diagnostics must never fail the turn */
    }
    try {
      const target = ctx?.logger?.[level]
      if (typeof target === 'function') target.call(ctx.logger, `dsh-memory: ${message}`)
    } catch {
      /* the logger is optional in minimal profiles */
    }
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
  }
}

/**
 * Collect the message events belonging to one turn.
 *
 * The turn boundary is located first (backwards, bounded), then messages are
 * read forward until the next `turn/start`. Locating the boundary first is what
 * keeps a newer turn's messages out of an older turn's capture.
 *
 * @param {{seq: number, eventAt: (seq: number) => any}} session - the session log.
 * @param {number} turn - turn number to collect.
 * @returns {Array<{seq: number, event: any}>} message events in chronological order.
 */
export function turnEvents(session, turn) {
  const head = typeof session.seq === 'number' ? session.seq : 0
  let startSeq = -1
  for (let seq = head - 1; seq >= 0 && head - seq <= MAX_SCAN_EVENTS; seq -= 1) {
    const event = session.eventAt(seq)
    if (event?.type !== 'turn/start') continue
    const eventTurn = event.data?.turn
    if (eventTurn === turn) {
      startSeq = seq
      break
    }
    if (typeof eventTurn === 'number' && eventTurn < turn) break
  }

  const collected = []
  for (let seq = startSeq === -1 ? 0 : startSeq + 1; seq < head && collected.length < MAX_SCAN_EVENTS; seq += 1) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (event.type === 'turn/start') break
    if (event.type === 'user/message' || event.type === 'assistant/message') collected.push({ seq, event })
  }
  return collected
}

/**
 * Normalize text for duplicate detection across captures.
 * @param {string} text - stored text.
 * @returns {string} a comparison key.
 */
function compareKey(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Capture the user messages of the turn being assembled.
 *
 * At `agent/pre-step` time the new messages are not in the session log yet —
 * they are the decision's claimed batch — so capture reads them from there.
 * Only messages whose source is the user are captured: injected context from
 * other plugins carries its own source kind and is not something the user said.
 *
 * @param {{store: MemoryStore, config: Record<string, any>, messages: any[], workspace: string, sessionId: string, turn: number}} input - capture inputs.
 * @returns {number} number of memories appended.
 */
export function captureProposed(input) {
  const { store, config, messages, workspace, sessionId, turn } = input
  const existing = new Set(store.load('workspace', workspace).map((entry) => compareKey(entry.text)))
  let appended = 0
  for (const message of messages) {
    if (message?.role !== 'user' || message?.source?.kind !== 'user') continue
    const text = messageText(message)
    if (text.length < config.minCaptureChars) continue
    const clipped = clipText(text, config.maxCaptureChars)
    if (clipped === '') continue
    const key = compareKey(clipped)
    if (existing.has(key)) continue
    existing.add(key)
    store.append({
      text: clipped,
      kind: 'user',
      workspace,
      scope: 'workspace',
      sessionId,
      turn,
      source: 'auto-capture',
    })
    appended += 1
  }
  return appended
}

/**
 * Capture the assistant replies of a completed turn.
 *
 * Assistant messages are committed to the session log by the time the next turn
 * starts, so this pass is sequence-based and therefore idempotent across steps
 * and session resume.
 *
 * @param {{store: MemoryStore, config: Record<string, any>, session: any, workspace: string, turn: number}} input - capture inputs.
 * @returns {number} number of memories appended.
 */
export function captureTurn(input) {
  const { store, config, session, workspace, turn } = input
  const captured = store.capturedSeqs(session.id, workspace)
  const existing = new Set(store.load('workspace', workspace).map((entry) => compareKey(entry.text)))
  let appended = 0
  for (const { seq, event } of turnEvents(session, turn)) {
    if (captured.has(seq)) continue
    if (event.type !== 'assistant/message') continue
    const data = event.data
    if (data?.source?.kind === name) continue
    const text = messageText(data)
    if (text.length < config.minCaptureChars) continue
    const clipped = clipText(text, config.maxCaptureChars)
    if (clipped === '') continue
    const key = compareKey(clipped)
    if (existing.has(key)) continue
    existing.add(key)
    store.append({
      text: clipped,
      kind: 'assistant',
      workspace,
      scope: 'workspace',
      sessionId: session.id,
      seq,
      turn,
      createdAt: Number.isFinite(event.time) ? event.time : Date.now(),
      source: 'auto-capture',
    })
    appended += 1
  }
  return appended
}

/**
 * Find the newest user-authored text in the batch being assembled.
 * @param {any[]} messages - the pre-step decision's messages.
 * @returns {string} the user's text, or an empty string.
 */
export function proposedUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user' || message?.source?.kind !== 'user') continue
    const text = messageText(message)
    if (text !== '') return text
  }
  return ''
}

/**
 * Find the newest user text of a turn, ignoring this plugin's own injections.
 * @param {{seq: number, eventAt: (seq: number) => any}} session - the session log.
 * @param {number} turn - turn number.
 * @returns {string} the user's text, or an empty string.
 */
export function latestUserText(session, turn) {
  const events = turnEvents(session, turn)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index].event
    if (event.type !== 'user/message') continue
    if (event.data?.source?.kind === name) continue
    const text = messageText(event.data)
    if (text !== '') return text
  }
  return ''
}

/**
 * Build the injected recall message.
 *
 * It is an ordinary `user` message with a typed source, exactly like the
 * first-party instruction and time-context injections, so it is replayable and
 * compactable instead of living outside the log.
 *
 * @param {string} text - rendered block.
 * @returns {Record<string, any>} a message payload for an `agent/pre-step` decision.
 */
export function recallMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: name, form: 'snapshot', sections: [{ name: 'memory-recall', text }] },
  }
}

/**
 * Activate the plugin.
 * @param {any} ctx - Cordis plugin context.
 * @param {unknown} rawConfig - the loader row's `config` block.
 */
export function apply(ctx, rawConfig) {
  const { config, warnings } = normalizeConfig(rawConfig)
  const logger = createLogger(ctx, config)
  for (const warning of warnings) logger.warn(warning)

  const store = new MemoryStore({ root: config.memoryRoot, logger })
  for (const tool of buildTools({ store, config, logger })) ctx.tools.register(tool)

  logger.info(
    `active (memoryRoot=${config.memoryRoot}, skillsRoot=${config.skillsRoot}, autoCapture=${config.autoCapture}, recall=${config.recallOn}, maxRecallItems=${config.maxRecallItems})`,
  )

  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next()
      try {
        if (decision?.kind !== 'enter') return decision
        if (payload?.signal?.aborted === true) return decision
        const session = payload?.agent?.session
        if (!session || typeof session.eventAt !== 'function') return decision

        const turn = Number.isFinite(payload.turn) ? payload.turn : 1
        const step = Number.isFinite(payload.step) ? payload.step : 1
        const firstStep = step === 1
        const workspace = workspaceKey(session.header?.cwd)

        if (config.autoCapture && firstStep) {
          captureProposed({
            store,
            config,
            messages: decision.messages,
            workspace,
            sessionId: session.id,
            turn,
          })
          if (config.captureAssistant && turn > 1) captureTurn({ store, config, session, workspace, turn: turn - 1 })
        }

        const wantsRecall = config.maxRecallItems > 0 && (config.recallOn === 'every-step' || firstStep)
        if (!wantsRecall) return decision

        const query = proposedUserText(decision.messages) || latestUserText(session, turn)
        if (query.length < MIN_QUERY_CHARS) return decision

        const ranked = store
          .search(query, {
            workspace,
            scope: 'all',
            includeGlobal: config.includeGlobalScope,
            limit: config.maxRecallItems + 2,
            minScore: config.recallMinScore,
            halfLifeDays: config.halfLifeDays,
          })
          // A memory captured from this very turn restates what the model already
          // has in context; recalling it would only spend tokens.
          .filter((hit) => !(hit.entry.sessionId === session.id && hit.entry.turn === turn))
          .slice(0, config.maxRecallItems)
        if (ranked.length === 0) return decision

        const block = renderRecall(ranked, { maxChars: config.recallMaxChars, header: RECALL_HEADER })
        if (block === '') return decision

        const messages = Array.isArray(decision.messages) ? decision.messages : []
        logger.info(`recalled ${ranked.length} memories (top ${ranked[0].score.toFixed(2)}) for turn ${turn}`)
        return { ...decision, messages: [...messages, recallMessage(block)] }
      } catch (error) {
        logger.warn(`recall skipped: ${error instanceof Error ? error.message : String(error)}`)
        return decision
      }
    },
    { prepend: true },
  )
}
