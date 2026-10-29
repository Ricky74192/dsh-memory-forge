/**
 * Skill materialization for dsh-memory-forge.
 *
 * A distilled skill is a directory bundle `<skillsRoot>/<name>/SKILL.md`, the
 * layout `@deepseek-ai/dsh-skill-filesystem` discovers under the user skill root.
 * Writing there (rather than into a workspace) makes the procedure available to
 * every later session in every project, which is what makes the memory loop
 * cumulative instead of per-repository.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { renderSkillDocument } from './render.js'

/** Kebab-case skill names accepted by the skill registry. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Whether a name is a valid skill bundle name.
 * @param {unknown} value - candidate name.
 * @returns {boolean} whether the registry will accept it.
 */
export function isSkillName(value) {
  return typeof value === 'string' && value.length <= 64 && SKILL_NAME_PATTERN.test(value)
}

/**
 * Validate the model-supplied skill content before touching the filesystem.
 * @param {{name?: unknown, description?: unknown, body?: unknown, whenToUse?: unknown, sources?: unknown}} input - tool arguments.
 * @returns {string[]} violations; empty means valid.
 */
export function validateSkillInput(input) {
  const violations = []
  if (!isSkillName(input.name)) violations.push('name must be kebab-case (a-z, 0-9, single hyphens) and at most 64 characters')
  if (typeof input.description !== 'string' || input.description.trim() === '') violations.push('description must be a non-empty string')
  else if (input.description.length > 1024) violations.push('description must be at most 1024 characters')
  if (typeof input.body !== 'string' || input.body.trim() === '') violations.push('body must be non-empty markdown')
  if (input.whenToUse !== undefined && typeof input.whenToUse !== 'string') violations.push('whenToUse must be a string when present')
  if (input.sources !== undefined && (!Array.isArray(input.sources) || input.sources.some((source) => typeof source !== 'string'))) {
    violations.push('sources must be an array of memory ids when present')
  }
  return violations
}

/**
 * Write (or refresh) one distilled skill bundle.
 *
 * The write is atomic: the document is written next to the target and renamed
 * over it, so a crash never leaves a half-written `SKILL.md` that the skill
 * watcher would pick up as a broken skill.
 *
 * @param {{root: string, name: string, description: string, body: string, whenToUse?: string, sources?: string[], now?: number}} input - skill content and destination.
 * @returns {{path: string, status: 'created' | 'updated', bytes: number}} the write outcome.
 */
export function writeSkill(input) {
  const directory = join(input.root, input.name)
  const path = join(directory, 'SKILL.md')
  const document = renderSkillDocument({
    name: input.name,
    description: input.description.trim(),
    body: input.body,
    whenToUse: input.whenToUse,
    sources: input.sources,
    generatedAt: input.now,
  })
  const status = existsSync(path) ? 'updated' : 'created'
  mkdirSync(directory, { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, document, 'utf8')
  renameSync(temporary, path)
  return { path, status, bytes: Buffer.byteLength(document, 'utf8') }
}

/**
 * Read the existing body of a skill, used to merge provenance on refresh.
 * @param {string} path - `SKILL.md` path.
 * @returns {string | undefined} the stored document, when readable.
 */
export function readSkill(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
