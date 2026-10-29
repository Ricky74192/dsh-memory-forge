/**
 * Durable storage for dsh-memory.
 *
 * Memories live in append-only JSONL files, one namespace per workspace plus an
 * optional `global` namespace. JSONL keeps the format inspectable and diffable
 * and needs no native module, which matters because a Host plugin runs inside the
 * harness process. Reads are cached per file and invalidated by mtime/size, so a
 * second harness process (or a hand edit) is picked up on the next query.
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { rankEntries } from './search.js'

/** Namespaces a memory can belong to. */
export const SCOPES = Object.freeze(['workspace', 'global'])

/** Kinds recorded by automatic capture and by the tools. */
export const KINDS = Object.freeze(['note', 'user', 'assistant', 'skill'])

/**
 * Derive the stable namespace of a workspace from its directory.
 * @param {string | undefined} cwd - the session working directory.
 * @returns {string} a short stable key, or `unscoped` without a directory.
 */
export function workspaceKey(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return 'unscoped'
  return createHash('sha256').update(cwd.toLowerCase()).digest('hex').slice(0, 16)
}

/**
 * Build a sortable, collision-resistant memory id.
 * @param {number} now - epoch milliseconds.
 * @returns {string} an id such as `mem_lq3f8k_4f2c1a`.
 */
export function createId(now = Date.now()) {
  return `mem_${now.toString(36)}_${randomUUID().slice(0, 6)}`
}

/**
 * Trim a text for storage without destroying internal structure.
 * @param {string} text - raw text.
 * @param {number} maxChars - hard limit.
 * @returns {string} the trimmed text, ellipsized when truncated.
 */
export function clipText(text, maxChars) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`
}

/**
 * Validate one parsed JSONL record.
 * @param {unknown} value - parsed record.
 * @returns {boolean} whether the record is a usable memory.
 */
function isMemoryRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = /** @type {Record<string, unknown>} */ (value)
  return typeof record.id === 'string' && record.id !== '' && typeof record.text === 'string' && record.text !== ''
}

export class MemoryStore {
  /**
   * @param {{root: string, logger?: {warn: (message: string) => void}, now?: () => number}} options - store settings.
   */
  constructor(options) {
    this.root = options.root
    this.logger = options.logger
    this.now = options.now ?? (() => Date.now())
    /** @type {Map<string, {mtimeMs: number, size: number, entries: Array<Record<string, any>>}>} */
    this.cache = new Map()
  }

  /**
   * Absolute JSONL path of one namespace.
   * @param {'workspace' | 'global'} scope - namespace kind.
   * @param {string} key - workspace key, ignored for the global scope.
   * @returns {string} the file path.
   */
  fileFor(scope, key) {
    const directory = scope === 'global' ? join(this.root, 'global') : join(this.root, key)
    return join(directory, 'memories.jsonl')
  }

  /**
   * Read one namespace, tolerating damaged lines and a missing file.
   * @param {'workspace' | 'global'} scope - namespace kind.
   * @param {string} key - workspace key.
   * @returns {Array<Record<string, any>>} the namespace's memories in append order.
   */
  load(scope, key) {
    const file = this.fileFor(scope, key)
    let stats
    try {
      stats = statSync(file)
    } catch {
      this.cache.delete(file)
      return []
    }
    const cached = this.cache.get(file)
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.entries

    const entries = []
    let skipped = 0
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      this.logger?.warn(`dsh-memory: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line)
        if (isMemoryRecord(parsed)) entries.push(parsed)
        else skipped += 1
      } catch {
        skipped += 1
      }
    }
    if (skipped > 0) this.logger?.warn(`dsh-memory: skipped ${skipped} damaged line(s) in ${file}`)
    this.cache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, entries })
    return entries
  }

  /**
   * Append one memory and return the stored record.
   * @param {{text: string, kind?: string, tags?: string[], importance?: number, scope?: 'workspace' | 'global', workspace?: string, sessionId?: string, seq?: number, turn?: number, source?: string}} input - memory to store.
   * @returns {Record<string, any>} the record as stored.
   */
  append(input) {
    const scope = input.scope === 'global' ? 'global' : 'workspace'
    const key = input.workspace ?? 'unscoped'
    const now = this.now()
    const record = {
      id: createId(now),
      text: input.text,
      kind: input.kind ?? 'note',
      tags: Array.isArray(input.tags) ? input.tags.filter((tag) => typeof tag === 'string' && tag !== '') : [],
      importance: clampImportance(input.importance),
      scope,
      workspace: scope === 'global' ? 'global' : key,
      createdAt: now,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.seq === undefined ? {} : { seq: input.seq }),
      ...(input.turn === undefined ? {} : { turn: input.turn }),
      ...(input.source === undefined ? {} : { source: input.source }),
    }
    const file = this.fileFor(scope, record.workspace)
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    this.cache.delete(file)
    return record
  }

  /**
   * Collect the namespaces a workspace can read.
   * @param {string} key - workspace key.
   * @param {{includeGlobal?: boolean}} [options] - whether the global namespace participates.
   * @returns {Array<{scope: 'workspace' | 'global', key: string, entries: Array<Record<string, any>>}>} readable namespaces.
   */
  namespaces(key, options = {}) {
    const includeGlobal = options.includeGlobal ?? true
    const list = [{ scope: /** @type {const} */ ('workspace'), key, entries: this.load('workspace', key) }]
    if (includeGlobal) list.push({ scope: /** @type {const} */ ('global'), key: 'global', entries: this.load('global', 'global') })
    return list
  }

  /**
   * Rank memories for a query across the workspace and (optionally) global scopes.
   *
   * Candidates are pooled before scoring so inverse document frequency reflects
   * the real corpus a session can see, then each hit is labelled with the
   * namespace it came from.
   *
   * @param {string} query - the user's text.
   * @param {{workspace: string, scope?: 'all' | 'workspace' | 'global', includeGlobal?: boolean, limit?: number, minScore?: number, halfLifeDays?: number, now?: number}} options - query settings.
   * @returns {Array<{entry: Record<string, any>, scope: 'workspace' | 'global', score: number, coverage: number, bm25: number, matched: string[]}>} ranked matches.
   */
  search(query, options) {
    const scope = options.scope ?? 'all'
    const includeGlobal = options.includeGlobal ?? true
    const namespaces = this.namespaces(options.workspace, { includeGlobal }).filter(
      (namespace) => scope === 'all' || namespace.scope === scope,
    )
    const entries = []
    const scopeOf = new Map()
    for (const namespace of namespaces) {
      for (const entry of namespace.entries) {
        entries.push(entry)
        scopeOf.set(entry.id, namespace.scope)
      }
    }
    return rankEntries(entries, query, {
      now: options.now ?? this.now(),
      halfLifeDays: options.halfLifeDays,
      minScore: options.minScore,
      limit: options.limit,
    }).map((hit) => ({ ...hit, scope: scopeOf.get(hit.entry.id) ?? 'workspace' }))
  }

  /**
   * Remove one memory by id from any namespace this store owns.
   * @param {string} id - memory id.
   * @param {string} workspace - current workspace key.
   * @param {{includeGlobal?: boolean}} [options] - whether to look in the global namespace.
   * @returns {{removed: boolean, scope?: 'workspace' | 'global'}} the outcome.
   */
  remove(id, workspace, options = {}) {
    for (const namespace of this.namespaces(workspace, { includeGlobal: options.includeGlobal ?? true })) {
      const index = namespace.entries.findIndex((entry) => entry.id === id)
      if (index === -1) continue
      const file = this.fileFor(namespace.scope, namespace.key)
      const remaining = namespace.entries.filter((entry) => entry.id !== id)
      writeJsonlAtomically(file, remaining)
      this.cache.delete(file)
      return { removed: true, scope: namespace.scope }
    }
    return { removed: false }
  }

  /**
   * Sequence numbers already captured for one session, used to make automatic
   * capture idempotent across steps, restarts, and session resume.
   * @param {string} sessionId - session identity.
   * @param {string} workspace - workspace key.
   * @returns {Set<number>} captured event sequence numbers.
   */
  capturedSeqs(sessionId, workspace) {
    const captured = new Set()
    for (const namespace of this.namespaces(workspace)) {
      for (const entry of namespace.entries) {
        if (entry.sessionId === sessionId && typeof entry.seq === 'number') captured.add(entry.seq)
      }
    }
    return captured
  }
}

/**
 * Rewrite a JSONL file through a temporary sibling, so a crash cannot truncate
 * the existing log.
 * @param {string} file - target path.
 * @param {Array<Record<string, any>>} records - records to keep.
 */
function writeJsonlAtomically(file, records) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, records.map((record) => JSON.stringify(record)).join('\n') + (records.length === 0 ? '' : '\n'), 'utf8')
  // rename replaces the target atomically on every platform Node supports.
  renameSync(temporary, file)
}

/**
 * Keep the importance multiplier inside 1..3.
 * @param {unknown} value - configured importance.
 * @returns {number} the clamped importance.
 */
function clampImportance(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(3, Math.max(1, Math.round(value)))
}
