# Data and privacy

`dsh-memory-forge` stores conversation text on the machine running the harness. This
page states exactly what is written, where it goes, and how to remove it.

## What is stored

For every captured turn:

- the text of user messages (`source.kind === 'user'`) and, when
  `captureAssistant` is on, the text of assistant replies;
- the memory id, kind, tags, importance, scope, and creation timestamp;
- the session id, event sequence number, and turn number, used only to make
  capture idempotent;
- a workspace key: the first 16 hex characters of `sha256(lowercase(cwd))`.

Tool results, reasoning traces, attachments, and images are **not** captured.
Nothing is sent off the machine: the plugin makes no network calls.

## Where it lives

```text
$DSH_HOME/memory/<workspace-key>/memories.jsonl   # automatic capture, memory_save
$DSH_HOME/memory/global/memories.jsonl            # scope: global
$DSH_HOME/memory/debug.log                        # only with debug: true
$DSH_HOME/skills/<name>/SKILL.md                  # distilled skills
$DSH_AGENTS_HOME/skills/<name>/SKILL.md           # when skillsRoot points there
```

Files are created with the process umask. On a shared machine, treat
`$DSH_HOME` like any other user profile directory.

## Model visibility

Recall injects stored text into the next request as a `<system-reminder>` block,
so it is transmitted to whichever model provider the session uses, exactly like
the rest of the conversation. Memories saved with `scope: 'global'` are visible
to every workspace under the same `$DSH_HOME`.

Workspace scoping is a retrieval convenience, not an access-control boundary: the
files are readable by anything running as that user, and the tools can read the
global namespace from any workspace.

## Secrets

The `memory_save` tool description tells the model not to store secrets, and
capture only keeps message text — but a model can still paste a token into a
message. Recommended precautions:

- keep provider keys in the harness credential store, not in prompts;
- set `autoCapture: false` for repositories where prompts routinely contain
  sensitive data, and use `memory_save` deliberately instead;
- set `debug: false` (the default) so paths and scores are not logged.

## Deletion

- one memory: `memory_forget` with its id, or delete the matching JSONL line;
- one workspace: delete `$DSH_HOME/memory/<workspace-key>/`;
- everything: delete `$DSH_HOME/memory/` and the skill bundles you no longer want;
- distilled skills are ordinary files: delete `$DSH_HOME/skills/<name>/`.

Deleting a memory removes it from future recall; it does not rewrite session
logs that already contain a recall block from an earlier turn. Session logs are
owned by the harness and follow its own retention policy.

## Reporting

This is a local-file plugin with no service component. If you find a case where
stored data escapes the locations above, or where recall can be made to close
its own framing, open an issue with the reproduction and the harness version.
