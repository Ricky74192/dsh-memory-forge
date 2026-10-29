#!/usr/bin/env node
/**
 * Link this checkout into a DSH profile for local development.
 *
 * Copies the package into <profile>/node_modules/dsh-memory-forge and writes the
 * loader patch row that mounts it. Intended for a throwaway development
 * profile (for example `dsh --profile memdev`); production use installs the
 * bundle through the plugin manager or `dsh plugin add`.
 *
 * Usage:
 *   node scripts/dev-install.mjs --profile memdev [--memory-root <dir>]
 *   node scripts/dev-install.mjs --profile memdev --uninstall
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

function parseArgs(argv) {
  const options = { profile: 'memdev', memoryRoot: '', skillsRoot: '', uninstall: false, debug: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') options.profile = argv[++index]
    else if (arg === '--memory-root') options.memoryRoot = argv[++index]
    else if (arg === '--skills-root') options.skillsRoot = argv[++index]
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--debug') options.debug = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log('usage: node scripts/dev-install.mjs --profile <name> [--memory-root <dir>] [--skills-root <dir>] [--debug] [--uninstall]')
  process.exit(0)
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', options.profile)
const target = join(profileDir, 'node_modules', 'dsh-memory-forge')

if (!existsSync(profileDir)) {
  console.error(`profile directory not found: ${profileDir}`)
  console.error('create it first, for example:')
  console.error(`  mkdir -p "${profileDir}"`)
  console.error(`  echo '{"name":"dsh-profile-${options.profile}","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]}}}' > "${join(profileDir, 'package.json')}"`)
  process.exit(1)
}

const patchPath = join(profileDir, 'cordis.patch.yml')

if (options.uninstall) {
  rmSync(target, { recursive: true, force: true })
  writeFileSync(patchPath, '[]\n', 'utf8')
  console.log(`removed ${target}`)
  process.exit(0)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

const skip = new Set(['node_modules', '.git', 'tests', '.github'])
for (const name of readdirSync(packageRoot)) {
  if (skip.has(name)) continue
  cpSync(join(packageRoot, name), join(target, name), { recursive: true, force: true })
}

const pathLine = (label, value) => (value === '' ? '' : `\n        ${label}: '${value.replaceAll('\\', '/')}'`)
const patch = `- insert:
    - id: memory
      name: 'dsh-memory-forge'
      config:
        maxRecallItems: 4
        recallMinScore: 0.15
        autoCapture: true
        debug: ${options.debug}${pathLine('memoryRoot', options.memoryRoot)}${pathLine('skillsRoot', options.skillsRoot)}
`
writeFileSync(patchPath, patch, 'utf8')

console.log(`installed ${target}`)
console.log(`profile patch ${patchPath}`)
