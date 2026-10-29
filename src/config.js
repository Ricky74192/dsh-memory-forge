/**
 * Configuration normalization for the dsh-memory plugin.
 *
 * The plugin deliberately exports no Cordis `Config` schema: a Host-only bundle
 * must load with no dependencies, and a schemastery schema would add one. Values
 * are validated here instead, once per activation, and every correction is
 * reported through the logger so a typo never fails silently.
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** @typedef {'first-step' | 'every-step'} RecallCadence */

export const DEFAULTS = Object.freeze({
  /** Root holding `memories.jsonl` files; defaults to `<dshHome>/memory`. */
  memoryRoot: null,
  /** Root receiving distilled `SKILL.md` bundles; defaults to `<dshHome>/skills`. */
  skillsRoot: null,
  /** Capture user and assistant messages from the conversation automatically. */
  autoCapture: true,
  /** Also capture the previous turn's assistant messages, not just user prompts. */
  captureAssistant: true,
  /** Shorter messages are ignored by automatic capture (explicit saves still work). */
  minCaptureChars: 24,
  /** Automatic capture truncates longer messages to this many characters. */
  maxCaptureChars: 4000,
  /** Maximum recalled entries injected in one step. */
  maxRecallItems: 4,
  /** Minimum relevance (0..1) for an entry to be injected. */
  recallMinScore: 0.22,
  /** Character budget for the whole injected recall block. */
  recallMaxChars: 2000,
  /** Half-life of the recency weight, in days. Zero disables recency weighting. */
  halfLifeDays: 30,
  /** Include entries saved with `scope: 'global'` in every workspace. */
  includeGlobalScope: true,
  /** Inject recall on the first step of a turn (`first-step`) or on every step. */
  recallOn: /** @type {RecallCadence} */ ('first-step'),
  /** Write diagnostics to `<memoryRoot>/debug.log` in addition to the logger. */
  debug: false,
})

/** Read the harness home the same way the first-party plugins do. */
export function dshHome(env = process.env) {
  const configured = env.DSH_HOME
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Resolve a configured path against an absolute fallback.
 * @param {unknown} value - configured value, if any.
 * @param {string} fallback - absolute default.
 * @param {string} label - configuration key used in diagnostics.
 * @param {string[]} warnings - mutable warning sink.
 * @returns {string} an absolute path.
 */
function resolvePath(value, fallback, label, warnings) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') {
    warnings.push(`${label} must be a string; using ${fallback}`)
    return fallback
  }
  const expanded = value.startsWith('~') ? join(homedir(), value.slice(1)) : value
  const absolute = isAbsolute(expanded) ? expanded : resolve(expanded)
  return absolute
}

/**
 * Clamp a numeric option into a range, reporting a warning when it was invalid.
 * @param {unknown} value - configured value.
 * @param {number} fallback - default value.
 * @param {{min?: number, max?: number, integer?: boolean}} range - accepted range.
 * @param {string} label - configuration key used in diagnostics.
 * @param {string[]} warnings - mutable warning sink.
 * @returns {number} the accepted value.
 */
function numberOption(value, fallback, range, label, warnings) {
  if (value === undefined || value === null) return fallback
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    warnings.push(`${label} must be a finite number; using ${fallback}`)
    return fallback
  }
  const min = range.min ?? Number.NEGATIVE_INFINITY
  const max = range.max ?? Number.POSITIVE_INFINITY
  const clamped = Math.min(max, Math.max(min, range.integer === true ? Math.round(parsed) : parsed))
  if (clamped !== parsed) warnings.push(`${label} must be between ${min} and ${max}; using ${clamped}`)
  return clamped
}

/**
 * Normalize a raw loader config into the plugin's effective options.
 * @param {unknown} raw - the `config` block of the loader row.
 * @param {{env?: NodeJS.ProcessEnv}} [options] - environment override for tests.
 * @returns {{config: typeof DEFAULTS & {memoryRoot: string, skillsRoot: string}, warnings: string[]}}
 */
export function normalizeConfig(raw, options = {}) {
  const env = options.env ?? process.env
  const warnings = []
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push('config must be a mapping; using defaults')
  }

  const home = dshHome(env)
  const config = {
    ...DEFAULTS,
    memoryRoot: resolvePath(input.memoryRoot, join(home, 'memory'), 'memoryRoot', warnings),
    skillsRoot: resolvePath(input.skillsRoot, join(home, 'skills'), 'skillsRoot', warnings),
    autoCapture: booleanOption(input.autoCapture, DEFAULTS.autoCapture, 'autoCapture', warnings),
    captureAssistant: booleanOption(input.captureAssistant, DEFAULTS.captureAssistant, 'captureAssistant', warnings),
    minCaptureChars: numberOption(input.minCaptureChars, DEFAULTS.minCaptureChars, { min: 1, max: 100_000, integer: true }, 'minCaptureChars', warnings),
    maxCaptureChars: numberOption(input.maxCaptureChars, DEFAULTS.maxCaptureChars, { min: 64, max: 1_000_000, integer: true }, 'maxCaptureChars', warnings),
    maxRecallItems: numberOption(input.maxRecallItems, DEFAULTS.maxRecallItems, { min: 0, max: 50, integer: true }, 'maxRecallItems', warnings),
    recallMinScore: numberOption(input.recallMinScore, DEFAULTS.recallMinScore, { min: 0, max: 1 }, 'recallMinScore', warnings),
    recallMaxChars: numberOption(input.recallMaxChars, DEFAULTS.recallMaxChars, { min: 0, max: 100_000, integer: true }, 'recallMaxChars', warnings),
    halfLifeDays: numberOption(input.halfLifeDays, DEFAULTS.halfLifeDays, { min: 0, max: 3650 }, 'halfLifeDays', warnings),
    includeGlobalScope: booleanOption(input.includeGlobalScope, DEFAULTS.includeGlobalScope, 'includeGlobalScope', warnings),
    recallOn: cadenceOption(input.recallOn, warnings),
    debug: booleanOption(input.debug, DEFAULTS.debug, 'debug', warnings),
  }

  if (config.minCaptureChars > config.maxCaptureChars) {
    warnings.push(`minCaptureChars (${config.minCaptureChars}) exceeds maxCaptureChars (${config.maxCaptureChars}); using ${config.maxCaptureChars}`)
    config.minCaptureChars = config.maxCaptureChars
  }
  return { config, warnings }
}

/**
 * Accept `yes`/`no`-style strings as well as booleans, matching YAML habits.
 * @param {unknown} value - configured value.
 * @param {boolean} fallback - default value.
 * @param {string} label - configuration key used in diagnostics.
 * @param {string[]} warnings - mutable warning sink.
 * @returns {boolean} the accepted value.
 */
function booleanOption(value, fallback, label, warnings) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', 'yes', 'on', '1'].includes(normalized)) return true
    if (['false', 'no', 'off', '0'].includes(normalized)) return false
  }
  warnings.push(`${label} must be a boolean; using ${fallback}`)
  return fallback
}

/**
 * Accept only the two supported recall cadences.
 * @param {unknown} value - configured value.
 * @param {string[]} warnings - mutable warning sink.
 * @returns {RecallCadence} the accepted cadence.
 */
function cadenceOption(value, warnings) {
  if (value === undefined || value === null) return DEFAULTS.recallOn
  if (value === 'first-step' || value === 'every-step') return value
  warnings.push(`recallOn must be "first-step" or "every-step"; using "${DEFAULTS.recallOn}"`)
  return DEFAULTS.recallOn
}
