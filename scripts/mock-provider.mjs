#!/usr/bin/env node
/**
 * Offline Anthropic-Messages mock provider for dsh-memory end-to-end checks.
 *
 * The harness talks to a DeepSeek endpoint over the Anthropic Messages protocol.
 * This server implements the streaming subset the harness uses, replays a script
 * of assistant turns, and records every request body so a test can assert on what
 * the model actually received (for example, an injected recall block).
 *
 * Usage:
 *   node scripts/mock-provider.mjs --port 0 --script <file.json> --log <dir>
 *
 * Script file: JSON array, one entry per request, consumed in order:
 *   {"text": "final answer"}
 *   {"tool": "memory_save", "input": {"text": "..."}}
 *   {"tools": [{"tool": "...", "input": {}}, ...]}   // parallel calls
 * When the script runs out the server answers with a short closing text.
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
/** @param {string} flag */
function valueOf(flag) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

const port = Number(valueOf('--port') ?? 0)
const scriptPath = valueOf('--script')
const logDir = valueOf('--log')
if (scriptPath === undefined || logDir === undefined) {
  console.error('usage: node scripts/mock-provider.mjs --port 0 --script <file.json> --log <dir>')
  process.exit(2)
}

mkdirSync(logDir, { recursive: true })
const script = JSON.parse(readFileSync(scriptPath, 'utf8'))
let requestCount = 0
let step = 0

/**
 * Send one SSE event.
 * @param {import('node:http').ServerResponse} response - server response.
 * @param {string} event - event name.
 * @param {unknown} data - JSON payload.
 */
function sendEvent(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/**
 * Stream one assistant message in the Anthropic Messages wire format.
 * @param {import('node:http').ServerResponse} response - server response.
 * @param {{text?: string, toolCalls?: Array<{name: string, input: unknown}>}} turn - scripted assistant turn.
 * @param {string} model - echoed model id.
 */
function streamMessage(response, turn, model) {
  const toolCalls = turn.toolCalls ?? []
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  sendEvent(response, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 32, output_tokens: 0 },
    },
  })

  let index = 0
  if (typeof turn.text === 'string' && turn.text !== '') {
    sendEvent(response, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    sendEvent(response, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: turn.text } })
    sendEvent(response, 'content_block_stop', { type: 'content_block_stop', index })
    index += 1
  }

  for (const call of toolCalls) {
    const id = `toolu_${randomUUID().replaceAll('-', '').slice(0, 20)}`
    sendEvent(response, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name: call.name, input: {} },
    })
    sendEvent(response, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input ?? {}) },
    })
    sendEvent(response, 'content_block_stop', { type: 'content_block_stop', index })
    index += 1
  }

  sendEvent(response, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 24 },
  })
  sendEvent(response, 'message_stop', { type: 'message_stop' })
  response.end()
}

const server = createServer((request, response) => {
  /** @type {Buffer[]} */
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    requestCount += 1
    const name = `${String(requestCount).padStart(3, '0')}-${request.method}-${request.url.replaceAll('/', '_')}`
    writeFileSync(join(logDir, `${name}.json`), body === '' ? '{}' : body, 'utf8')

    if (!request.url?.includes('/messages')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'mock: unsupported path' } }))
      return
    }

    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {
      /* the log keeps the raw body for diagnosis */
    }
    const model = typeof parsed.model === 'string' ? parsed.model : 'mock-model'
    // Auxiliary requests (session titles) must not consume the scripted turns.
    // Detection looks at the newest user message: the full request body also
    // carries the session log and tool list, so substring matches are ambiguous.
    const lastUser = [...(Array.isArray(parsed.messages) ? parsed.messages : [])].reverse().find((message) => message?.role === 'user')
    const lastText = Array.isArray(lastUser?.content)
      ? lastUser.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
      : ''
    if (lastText.trimStart().startsWith('Generate the session title')) {
      streamMessage(response, { text: 'Mock session title' }, model)
      return
    }
    const turn = script[step]
    step += 1

    if (turn === undefined) {
      streamMessage(response, { text: 'mock provider: script exhausted, stopping.' }, model)
      return
    }
    if (Array.isArray(turn.tools)) {
      streamMessage(response, { toolCalls: turn.tools.map((entry) => ({ name: entry.tool, input: entry.input ?? {} })) }, model)
      return
    }
    if (typeof turn.tool === 'string') {
      streamMessage(response, { toolCalls: [{ name: turn.tool, input: turn.input ?? {} }] }, model)
      return
    }
    streamMessage(response, { text: String(turn.text ?? 'ok') }, model)
  })
})

server.listen(port, '127.0.0.1', () => {
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  writeFileSync(join(logDir, 'port.txt'), String(actualPort), 'utf8')
  console.log(`mock provider listening on http://127.0.0.1:${actualPort}`)
})
