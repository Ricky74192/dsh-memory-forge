# dsh-memory

Long-term memory and self-evolving skills for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

`dsh-memory` is a dependency-free Cordis Host plugin that gives a DSH profile four things it does not ship with:

- **Automatic capture** 鈥?user prompts and assistant replies are written to a local, inspectable memory store, once per event.
- **Automatic recall** 鈥?before a step, memories relevant to the current request are injected as a framed `<system-reminder>` block.
- **Memory tools** 鈥?`memory_save`, `memory_search`, `memory_forget` for explicit, model-driven use.
- **Skill evolution** 鈥?`memory_distill_skill` turns a proven procedure into a `SKILL.md` bundle in the user skill root, where the harness discovers it in every later session.

Everything stays on the machine: JSONL files under `$DSH_HOME/memory`, skills under `$DSH_HOME/skills` (or `$DSH_AGENTS_HOME/skills`). No network calls, no embedding service, no native modules.

## Why this exists

DSH deliberately ships no memory plugin. It ships the primitives 鈥?`AGENTS.md` instruction loading, a skill registry that watches the filesystem, a plugin system with hot reload 鈥?but nothing that closes the loop from "what happened in this session" to "what the next session knows".

Hermes-style memory plugins (for example the [MemOS local plugin](https://memos-docs.openmem.net/cn/openclaw/hermes_local_plugin/)) provide that loop with an LLM + embedding + SQLite stack. This plugin provides the same loop with a much smaller footprint:

| Hermes / MemOS local plugin | dsh-memory |
| --- | --- |
| Full conversation capture, chunked and embedded | Turn capture into append-only JSONL; no embeddings |
| Auto-recall injected into the system context | Auto-recall injected as a durable `user` message before step 1 |
| Hybrid retrieval (FTS5 + vector, RRF, MMR, decay) | BM25-style lexical retrieval + query coverage + recency half-life |
| `memory_search` / `task_summary` / `skill_get` | `memory_search` / `memory_forget` / `memory_distill_skill` |
| Task summarization pipeline | Not included; `compaction` already owns context compression |
| Skill auto-evolution (generate + upgrade) | Model-driven distillation into real `SKILL.md` bundles, discovered by the harness |
| SQLite + bridge daemon + viewer | Plain files; read them with any editor |

The trade-off is explicit: no semantic search and no background summarization, in exchange for zero dependencies, zero daemons, a format you can `git diff`, and a plugin that installs into any DSH profile.

## Install

Requires DSH with `@deepseek-ai/dsh-base` (any shipped profile: `web`, `headless`, `tui`, 鈥? and Node.js 鈮?22.

### Plugin manager (recommended)

In the DSH Web UI, open **Plugins 鈫?Install bundle** and point it at this directory, or ask a Creator-preset session to run:

```text
plugin_manager action=install_bundle target=<absolute path to this checkout>
```

A published package can be installed the same way with its registry spec.

### CLI

```bash
dsh plugin --profile <profile> add file:<absolute path to this checkout>
```

The `desktop` profile is owned by the Electron application; use the Plugins page or `plugin_manager` for it instead of the CLI. `dsh plugin` forwards to pnpm, so `pnpm` must be on `PATH`. A `file:` dependency is installed as a copy, so reinstall after editing the checkout.

### Manual (development)

```bash
node scripts/dev-install.mjs --profile memdev --debug \
  --memory-root  "$PWD/.e2e/memory" \
  --skills-root  "$PWD/.e2e/agents-home/skills"
```

That copies this package into `<DSH_HOME>/profiles/memdev/node_modules/dsh-memory` and writes the loader row. Remove it with `--uninstall`.

### Enable

Installing the bundle inserts this row into the profile patch:

```yaml
- insert:
    - id: memory
      name: 'dsh-memory'
      config:
        maxRecallItems: 4
        recallMinScore: 0.22
```

With HMR enabled the plugin mounts immediately; otherwise restart the profile.

## Configuration

All keys are optional. Values are validated at activation and every correction is logged.

| Key | Default | Meaning |
| --- | --- | --- |
| `memoryRoot` | `$DSH_HOME/memory` | Root of the memory store. |
| `skillsRoot` | `$DSH_HOME/skills` | Root receiving distilled `SKILL.md` bundles. Set it to `$DSH_AGENTS_HOME/skills` to share skills with other agent tools. |
| `autoCapture` | `true` | Capture conversation turns automatically. |
| `captureAssistant` | `true` | Also capture the previous turn's assistant replies. |
| `minCaptureChars` | `24` | Shorter messages are not captured automatically. |
| `maxCaptureChars` | `4000` | Automatic capture truncates longer texts. |
| `maxRecallItems` | `4` | Memories injected per recall. `0` disables recall. |
| `recallMinScore` | `0.22` | Minimum relevance (0..1) to inject a memory. |
| `recallMaxChars` | `2000` | Character budget of the whole injected block. |
| `halfLifeDays` | `30` | Recency half-life; `0` disables recency weighting. |
| `includeGlobalScope` | `true` | Recall entries saved with `scope: 'global'`. |
| `recallOn` | `first-step` | `first-step` or `every-step`. |
| `debug` | `false` | Write `<memoryRoot>/debug.log` diagnostics. |

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_save` | Store one durable fact, preference, decision, or lesson. `scope: 'global'` for cross-project preferences. |
| `memory_search` | Ranked search over the workspace and global namespaces. |
| `memory_forget` | Delete a memory by id 鈥?preferred over writing a contradictory note. |
| `memory_distill_skill` | Write a `SKILL.md` bundle from a proven procedure, recording the source memory ids. |

Tool descriptions carry the operating policy, so a session discovers when to save and recall without any prompt injection.

## How it works

```text
agent/pre-step (step 1)
  鈹溾攢 capture   user messages of this turn (from the decision's claimed batch)
  鈹?           assistant messages of the previous turn (from the session log, seq-deduped)
  鈹溾攢 recall    query = newest user text
  鈹?           rank(workspace 鈭?global) 鈫?filter current-turn captures 鈫?render block
  鈹斺攢 inject    append one `user` message with source kind `dsh-memory`
```

Design decisions worth knowing:

- **The session log stays authoritative.** Recall is a normal `user` message, so it replays, compacts, and survives resume. The memory store is a derived index, never a second log.
- **Capture is idempotent twice.** Event sequence numbers prevent re-capture after resume; normalized-text dedupe prevents duplicates from repeated prompts.
- **Recall never echoes the current turn.** A memory captured from this very turn is filtered out 鈥?it would restate what the model already has.
- **The plugin has no imports outside Node builtins.** A Host bundle must load without a dependency tree, so schemas are hand-written and validated in place.
- **Distilled skills are ordinary skill bundles.** They land in a watched root, get parsed by `@deepseek-ai/dsh-skill-filesystem`, and appear in the next session's catalogue 鈥?no registry API, no restart.

### Data layout

```text
$DSH_HOME/memory/
  <workspace-key>/memories.jsonl     # sha256(cwd)[0:16]
  global/memories.jsonl              # cross-project memories
  debug.log                          # only with debug: true
$DSH_HOME/skills/<name>/SKILL.md     # distilled skills
```

Each line is one JSON object:

```json
{"id":"mem_mvtaup5t_c19e0b","text":"...","kind":"note","tags":["build"],"importance":1,
 "scope":"workspace","workspace":"4ae8d930ea1f76ea","createdAt":1792395281000,
 "sessionId":"session-鈥?,"seq":12,"turn":1,"source":"auto-capture"}
```

The store tolerates damaged lines (it skips them with a warning) and rewrites atomically on delete.

## Verify

```bash
node --test                      # 46 unit tests: retrieval, store, rendering, config
node scripts/e2e.mjs --profile memdev   # 4 real headless turns against a mock provider
```

The offline end-to-end check runs actual harness turns with `scripts/mock-provider.mjs`, an Anthropic-Messages mock, and asserts from disk artifacts only:

- **A** `memory_save` through the real tool pipeline writes the memory;
- **B** a later turn receives the saved fact inside a recall block;
- **C** `memory_distill_skill` writes a valid `SKILL.md`;
- **D** the harness lists that skill in the next session's catalogue.

The same four phases pass against the `npm pack` tarball installed with `dsh plugin add file:<tgz>`, which is the install path a registry package takes.

No API key is needed; the mock provider records every request body so assertions are made against what the model actually received.

## Limitations

- **Lexical retrieval only.** BM25-style scoring handles identifiers, paths, and CJK bigrams well, but it will miss paraphrase-only matches that an embedding model would find.
- **No background summarization.** Memories are conversation turns and explicit notes; there is no task-summary pipeline. DSH's `compaction` plugin already owns context compression.
- **Capture happens on the first step of a turn.** A turn aborted during its first step may leave its user message stored without a reply; that is accurate, if occasionally noisy.
- **Subagent sessions are captured too.** Delegated children run the same profile, so their turns enter the same workspace namespace. Disable utoCapture if that is unwanted.
- **One writer per file.** Concurrent harness processes appending to the same namespace can interleave, but each JSONL line is written with a single `appendFileSync`, so lines stay intact. Delete rewrites through a temp file.
- **Skills are written, not curated.** The plugin validates names and frontmatter, but deciding whether a procedure is worth keeping is the model's call.
- **No viewer.** The files are plain JSONL; a UI plugin would be a separate package.

## Roadmap

- Optional embedding backend behind the same store interface.
- A `memory_stats` tool and a compaction hook that expires superseded notes.
- Web UI page listing, searching, and deleting memories.

## License

MIT. See [LICENSE](LICENSE).
