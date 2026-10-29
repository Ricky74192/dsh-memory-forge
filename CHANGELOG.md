# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-10-29

### Added

- Dependency-free Cordis Host plugin (`dsh-memory`) that installs as a DSH bundle.
- Automatic turn capture into append-only JSONL namespaces, one per workspace
  plus a shared `global` namespace, with sequence and text deduplication.
- Automatic recall injected as a durable `user` message before the first step of
  a turn, framed as a `<system-reminder>` block with a character budget.
- BM25-style lexical retrieval blended with query coverage and a recency
  half-life, including CJK bigram tokenization and function-word filtering so
  coverage stays meaningful on small corpora.
- Tools: `memory_save`, `memory_search`, `memory_forget`, `memory_distill_skill`.
- Skill distillation into `<skillsRoot>/<name>/SKILL.md` bundles that the
  harness's skill registry discovers in later sessions.
- Config validation with per-key warnings; `debug` file logging.
- 62 unit tests plus a four-phase offline end-to-end check that drives real
  headless harness turns against a bundled Anthropic-Messages mock provider.
