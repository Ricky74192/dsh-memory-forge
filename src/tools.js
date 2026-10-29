/**
 * Model-facing tools of dsh-memory-forge.
 *
 * Tools are plain registry definitions rather than `defineTool()` values: the
 * plugin ships as a dependency-free Host bundle, and importing
 * `@deepseek-ai/dsh-tools` would make it depend on a package that only resolves
 * inside the harness installation. Arguments are validated here instead, and
 * every tool declares the `output.render` the registry requires.
 */
import { clipText, workspaceKey } from './store.js'
import { validateSkillInput, writeSkill } from './skills.js'

/**
 * Resolve the workspace namespace of a tool call.
 * @param {{agent?: {session?: {header?: {cwd?: string}}}}} [exec] - tool execution context.
 * @returns {string} the workspace key.
 */
export function workspaceOf(exec) {
  return workspaceKey(exec?.agent?.session?.header?.cwd)
}

/**
 * Resolve the session identity of a tool call, when there is one.
 * @param {{agent?: {session?: {id?: string}}}} [exec] - tool execution context.
 * @returns {string | undefined} the session id.
 */
function sessionOf(exec) {
  const id = exec?.agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Render a short text result.
 * @param {string} text - result text.
 * @returns {Array<{type: 'text', text: string}>} registry content parts.
 */
function textResult(text) {
  return [{ type: 'text', text }]
}

/**
 * Build every tool definition this plugin registers.
 * @param {{store: import('./store.js').MemoryStore, config: Record<string, any>, logger: {info?: (message: string) => void, warn: (message: string) => void}}} context - plugin collaborators.
 * @returns {Array<Record<string, any>>} registry-ready tool definitions.
 */
export function buildTools(context) {
  const { store, config, logger } = context

  return [
    {
      name: 'memory_save',
      description:
        'Persist one durable memory for future sessions: a user preference, a decision and its reason, an environment fact, or a lesson learned. ' +
        'Save what you would otherwise have to rediscover or ask again; do not save transient task state, restatements of the current request, or secrets. ' +
        'Use scope "global" only for preferences that apply to every project.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'The memory, written so a future session can use it without this conversation.' },
          tags: { type: 'array', description: 'Short retrieval tags, for example ["build", "windows"].', items: { type: 'string' } },
          kind: { type: 'string', description: 'Category of the memory.', enum: ['note', 'user', 'assistant', 'skill'] },
          scope: { type: 'string', description: 'workspace (default) or global.', enum: ['workspace', 'global'] },
          importance: { type: 'integer', description: '1 normal, 2 important, 3 critical.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'scope', 'storedAt'],
          properties: {
            id: { type: 'string' },
            scope: { type: 'string' },
            storedAt: { type: 'string' },
            chars: { type: 'integer' },
          },
        },
        render: (_args, value) => textResult(`Saved memory ${value.id} to the ${value.scope} namespace (${value.chars} chars).`),
      },
      async execute(args, exec) {
        if (typeof args.text !== 'string' || args.text.trim() === '') throw new Error('memory_save: text must be a non-empty string')
        const text = clipText(args.text, config.maxCaptureChars)
        const record = store.append({
          text,
          kind: typeof args.kind === 'string' ? args.kind : 'note',
          tags: Array.isArray(args.tags) ? args.tags : [],
          importance: args.importance,
          scope: args.scope === 'global' ? 'global' : 'workspace',
          workspace: workspaceOf(exec),
          sessionId: sessionOf(exec),
          source: 'memory_save',
        })
        logger.info?.(`dsh-memory-forge: saved ${record.id} (${record.scope})`)
        return {
          id: record.id,
          scope: record.scope,
          storedAt: new Date(record.createdAt).toISOString(),
          chars: record.text.length,
        }
      },
    },

    {
      name: 'memory_search',
      description:
        'Search long-term memory written in earlier sessions. Call it before asking the user to repeat context, before re-deriving a prior decision, ' +
        'and when a task resembles work you may have done before. Results are ranked by lexical relevance and recency; an empty result means nothing relevant was stored.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'What to look for, in natural language.' },
          limit: { type: 'integer', description: 'Maximum results (default 8, max 50).' },
          scope: { type: 'string', description: 'all (default), workspace, or global.', enum: ['all', 'workspace', 'global'] },
          minScore: { type: 'number', description: 'Minimum relevance 0..1; defaults to 0.05 so weak matches still surface.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['total', 'results'],
          properties: {
            total: { type: 'integer' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'text', 'scope', 'score'],
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  scope: { type: 'string' },
                  kind: { type: 'string' },
                  score: { type: 'number' },
                  createdAt: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.total === 0) return textResult('No memories matched.')
          return textResult(
            value.results
              .map((result) => `- ${result.id} (${result.scope}, score ${result.score.toFixed(2)}): ${result.text.slice(0, 240)}`)
              .join('\n'),
          )
        },
      },
      async execute(args, exec) {
        if (typeof args.query !== 'string' || args.query.trim() === '') throw new Error('memory_search: query must be a non-empty string')
        const scope = args.scope === 'workspace' || args.scope === 'global' ? args.scope : 'all'
        const limit = Math.min(50, Math.max(1, Number.isFinite(args.limit) ? Math.trunc(args.limit) : 8))
        const minScore = Number.isFinite(args.minScore) ? Math.min(1, Math.max(0, args.minScore)) : 0.05
        const ranked = store.search(args.query, {
          workspace: workspaceOf(exec),
          scope,
          includeGlobal: config.includeGlobalScope,
          limit,
          minScore,
          halfLifeDays: config.halfLifeDays,
        })
        return {
          total: ranked.length,
          results: ranked.map(({ entry, scope: entryScope, score }) => ({
            id: entry.id,
            text: entry.text,
            scope: entryScope,
            kind: entry.kind,
            score: Number(score.toFixed(4)),
            ...(Number.isFinite(entry.createdAt) ? { createdAt: new Date(entry.createdAt).toISOString() } : {}),
            tags: Array.isArray(entry.tags) ? entry.tags : [],
          })),
        }
      },
    },

    {
      name: 'memory_forget',
      description:
        'Delete one memory by id when it is wrong, obsolete, or was stored by mistake. ' +
        'Prefer this over saving a contradictory note: recall injects what is stored, not what is newest.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'The memory id shown by memory_search or in a recall block.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['removed'],
          properties: {
            removed: { type: 'boolean' },
            scope: { type: 'string' },
          },
        },
        render: (_args, value) => textResult(value.removed ? `Removed memory from the ${value.scope} namespace.` : 'No memory with that id exists in this workspace.'),
      },
      async execute(args, exec) {
        if (typeof args.id !== 'string' || args.id === '') throw new Error('memory_forget: id must be a non-empty string')
        const outcome = store.remove(args.id, workspaceOf(exec), { includeGlobal: config.includeGlobalScope })
        return outcome
      },
    },

    {
      name: 'memory_distill_skill',
      description:
        'Turn a proven, repeatable procedure into a reusable skill (SKILL.md) under the user skill root, so every later session can load it with the skill tool. ' +
        'Use it after a workflow succeeded and will recur; pass the memory ids it was distilled from so provenance is recorded. ' +
        'The body should be actionable markdown: when to use it, the steps, the pitfalls, and how to verify success.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'body'],
        properties: {
          name: { type: 'string', description: 'Kebab-case skill name, for example "fix-flaky-windows-build".' },
          description: { type: 'string', description: 'One sentence that tells a future model when this skill applies.' },
          body: { type: 'string', description: 'The skill instructions in markdown.' },
          whenToUse: { type: 'string', description: 'Optional extra trigger guidance.' },
          sources: { type: 'array', description: 'Memory ids this skill was distilled from.', items: { type: 'string' } },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'status', 'bytes'],
          properties: {
            path: { type: 'string' },
            status: { type: 'string' },
            bytes: { type: 'integer' },
          },
        },
        render: (_args, value) => textResult(`${value.status === 'created' ? 'Created' : 'Updated'} skill ${value.path} (${value.bytes} bytes).`),
      },
      async execute(args, exec) {
        const violations = validateSkillInput(args)
        if (violations.length > 0) throw new Error(`memory_distill_skill: ${violations.join('; ')}`)
        const result = writeSkill({
          root: config.skillsRoot,
          name: args.name,
          description: args.description,
          body: args.body,
          whenToUse: typeof args.whenToUse === 'string' ? args.whenToUse : undefined,
          sources: Array.isArray(args.sources) ? args.sources : [],
        })
        store.append({
          text: `Skill "${args.name}": ${args.description.trim()}`,
          kind: 'skill',
          tags: ['skill', args.name],
          scope: 'workspace',
          workspace: workspaceOf(exec),
          sessionId: sessionOf(exec),
          source: 'memory_distill_skill',
        })
        logger.info?.(`dsh-memory-forge: ${result.status} skill ${result.path}`)
        return result
      },
    },
  ]
}
