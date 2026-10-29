#!/usr/bin/env node
/**
 * Offline end-to-end check for dsh-memory.
 *
 * Runs two real headless harness turns against the bundled mock provider:
 *   phase A — the plugin's `memory_save` tool stores a fact;
 *   phase B — a later turn receives that fact as an injected recall block.
 *
 * Everything is asserted from artifacts on disk (memory JSONL, recorded model
 * requests), never from prose the model produced.
 *
 * Usage:
 *   node scripts/e2e.mjs --profile memdev [--workdir <dir>] [--dsh <dsh command>]
 *
 * Requirements:
 *   - a dev profile with this plugin installed (see scripts/dev-install.mjs),
 *   - the harness CLI, defaulting to $DSH_BIN or the Windows desktop install.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')

const args = process.argv.slice(2)
/** @param {string} flag */
function valueOf(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

const profile = valueOf('--profile') ?? 'memdev'
const workdir = resolve(valueOf('--workdir') ?? process.cwd())
const dshCommand =
  valueOf('--dsh') ??
  process.env.DSH_BIN ??
  'C:\\Users\\13994\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd'
const memoryRoot = resolve(valueOf('--memory-root') ?? join(packageRoot, '.e2e', 'memory'))
const agentsHome = resolve(valueOf('--agents-home') ?? join(packageRoot, '.e2e', 'agents-home'))
const skillsRoot = resolve(valueOf('--skills-root') ?? join(agentsHome, 'skills'))
const runRoot = join(packageRoot, '.e2e', 'runs')

if (!existsSync(dshCommand)) {
  console.error(`dsh command not found: ${dshCommand}`)
  process.exit(2)
}

rmSync(runRoot, { recursive: true, force: true })
mkdirSync(runRoot, { recursive: true })

/**
 * Run one child process to completion, capturing output.
 * @param {string} command - executable.
 * @param {string[]} argv - arguments.
 * @param {{cwd?: string, env?: Record<string, string>, timeoutMs?: number}} [options] - spawn options.
 * @returns {Promise<{code: number | null, stdout: string, stderr: string}>} the outcome.
 */
/**
 * Quote one Windows command-line argument for cmd.exe.
 * @param {string} value - raw argument.
 * @returns {string} a quoted argument.
 */
function quoteArg(value) {
  return /[\s"&|<>^]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function run(command, argv, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const windows = process.platform === 'win32'
    const child = windows
      ? spawn([command, ...argv].map(quoteArg).join(' '), {
          cwd: options.cwd ?? process.cwd(),
          env: { ...process.env, ...options.env },
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(command, argv, {
          cwd: options.cwd ?? process.cwd(),
          env: { ...process.env, ...options.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`timeout after ${options.timeoutMs ?? 120_000}ms: ${command} ${argv.join(' ')}`))
    }, options.timeoutMs ?? 120_000)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

/**
 * Start the mock provider and wait until it reports its port.
 * @param {string} name - phase name used for the script and log directory.
 * @param {unknown} script - scripted assistant turns.
 * @returns {Promise<{stop: () => void, logDir: string}>} the running server.
 */
async function startMock(name, script) {
  const logDir = join(runRoot, name, 'requests')
  mkdirSync(logDir, { recursive: true })
  const scriptPath = join(runRoot, name, 'script.json')
  mkdirSync(dirname(scriptPath), { recursive: true })
  writeFileSync(scriptPath, JSON.stringify(script, null, 2), 'utf8')

  const child = spawn(process.execPath, [join(here, 'mock-provider.mjs'), '--port', '0', '--script', scriptPath, '--log', logDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const portFile = join(logDir, 'port.txt')
  const deadline = Date.now() + 15_000
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) {
      child.kill()
      throw new Error('mock provider did not start')
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  const port = readFileSync(portFile, 'utf8').trim()
  return {
    logDir,
    stop: () => {
      child.kill('SIGKILL')
    },
    port,
  }
}

/**
 * Run one headless harness turn against a mocked provider.
 * @param {string} name - phase name.
 * @param {string} prompt - user prompt.
 * @param {unknown} script - scripted assistant turns.
 * @returns {Promise<{output: string, logDir: string}>} turn artifacts.
 */
async function turn(name, prompt, script) {
  const mock = await startMock(name, script)
  try {
    const result = await run(dshCommand, ['--profile', profile, prompt], {
      cwd: workdir,
      env: {
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.port}`,
        DEEPSEEK_API_KEY: 'mock-key',
        DSH_AGENTS_HOME: agentsHome,
      },
      timeoutMs: 180_000,
    })
    return { output: `${result.stdout}\n${result.stderr}`, logDir: mock.logDir, code: result.code }
  } finally {
    mock.stop()
  }
}

/**
 * Concatenated request bodies recorded for one phase.
 * @param {string} logDir - request directory.
 * @returns {string} all recorded bodies.
 */
function requestBodies(logDir) {
  return readdirSync(logDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readFileSync(join(logDir, name), 'utf8'))
    .join('\n')
}

const workspaceKey = createHash('sha256').update(workdir.toLowerCase()).digest('hex').slice(0, 16)
const memoryFile = join(memoryRoot, workspaceKey, 'memories.jsonl')

rmSync(memoryRoot, { recursive: true, force: true })
rmSync(skillsRoot, { recursive: true, force: true })
rmSync(agentsHome, { recursive: true, force: true })

const failures = []
/** @param {boolean} condition @param {string} message */
function check(condition, message) {
  if (condition) {
    console.log(`  ok   ${message}`)
    return
  }
  failures.push(message)
  console.log(`  FAIL ${message}`)
}

console.log(`phase A: capture (profile=${profile}, workdir=${workdir})`)
const phaseA = await turn('a', 'Remember the build workflow: we use pnpm and verify the release artifact with pnpm pack.', [
  {
    tool: 'memory_save',
    input: {
      text: 'The project builds with pnpm build and the release artifact must be verified with pnpm pack before publishing.',
      tags: ['build', 'release'],
    },
  },
  { text: 'Stored the build workflow.' },
])
console.log(`  dsh exit=${phaseA.code}`)
if (phaseA.code !== 0) console.log(phaseA.output.slice(-4000))
check(existsSync(memoryFile), `memory file exists: ${memoryFile}`)
const stored = existsSync(memoryFile) ? readFileSync(memoryFile, 'utf8') : ''
check(stored.includes('pnpm pack'), 'memory_save persisted the fact')

console.log('phase B: recall injection')
const phaseB = await turn('b', 'How do we build and publish a release of this project?', [{ text: 'Answered from recalled context.' }])
console.log(`  dsh exit=${phaseB.code}`)
if (phaseB.code !== 0) console.log(phaseB.output.slice(-4000))
const bodies = requestBodies(phaseB.logDir)
check(bodies.includes('Recalled from long-term memory'), 'a recall block reached the model')
check(bodies.includes('pnpm pack'), 'the recalled fact reached the model')
check(!bodies.includes('script exhausted'), 'the mock script covered every request')

console.log('phase C: skill distillation')
const skillName = 'verify-release-artifact'
const phaseC = await turn('c', 'Distill the release workflow into a reusable skill.', [
  {
    tool: 'memory_distill_skill',
    input: {
      name: skillName,
      description: 'Use when publishing a release artifact for this project.',
      body: '## Steps\n\n1. Run `pnpm build`.\n2. Verify the artifact with `pnpm pack`.\n3. Publish only after the pack contents look right.\n',
    },
  },
  { text: 'Distilled the workflow into a skill.' },
])
console.log(`  dsh exit=${phaseC.code}`)
if (phaseC.code !== 0) console.log(phaseC.output.slice(-4000))
const skillFile = join(skillsRoot, skillName, 'SKILL.md')
check(existsSync(skillFile), `skill bundle written: ${skillFile}`)
const skillDocument = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : ''
check(skillDocument.includes(`name: ${skillName}`), 'skill frontmatter carries the kebab-case name')
check(skillDocument.includes('pnpm pack'), 'skill body carries the distilled procedure')
check(skillDocument.includes('generatedBy: dsh-memory'), 'skill frontmatter records provenance')

console.log('phase D: the harness discovers the distilled skill')
const phaseD = await turn('d', 'List the skills you can load.', [{ text: 'Listed the catalogue.' }])
console.log(`  dsh exit=${phaseD.code}`)
if (phaseD.code !== 0) console.log(phaseD.output.slice(-4000))
const catalog = requestBodies(phaseD.logDir)
check(catalog.includes(skillName), 'the distilled skill appears in the next session skill catalogue')

console.log('')
if (failures.length > 0) {
  console.log(`FAILED (${failures.length})`)
  for (const failure of failures) console.log(` - ${failure}`)
  process.exit(1)
}
console.log('PASS: capture and recall verified end to end')
