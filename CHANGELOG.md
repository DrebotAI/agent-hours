# Changelog

All notable user-visible changes are documented here. Release notes describe shipped
behavior, not planned behavior.

## [Unreleased]

### Added

- The HTML report's day grid now colors each hour cell by which agent worked it:
  Claude Code in orange, Codex (or any other source) in ink. An hour with turns from
  both agents — whether they ran in parallel or just took turns within the same
  hour — gets a hard-edged two-tone split proportional to each agent's share, instead
  of an ambiguous third color. Darkness still tracks how full the hour is, same as
  before. A small color key appears above the grid once a report has more than one
  agent's worth of history; a single-agent history stays one hue and needs no key.
- Clicking an hour with recorded activity in the day grid opens a small popover with
  that hour's breakdown: which agent(s) worked it and for how many minutes, and which
  project(s) were touched. An hour with no activity is not clickable. Metadata only,
  same boundary as everywhere else in this report — no prompt or reply text is
  available to show even if the popover wanted to. CSS-only (`:target`), no JS.

### Fixed

- `backfill` no longer falsely reports "format may have changed" and refuses to write
  when a Codex transcript is a freshly created session with no `task_started` yet
  (e.g. right after launching Codex, before the first turn). It is now recognized via
  its `session_meta` record and treated as legitimately empty, the same way a single
  in-progress turn already was.

## [1.1.0] — 2026-08-04

agent-hours now measures Claude Code and Codex through one local, privacy-first report.
This is a feature release because it adds a second agent integration and an additive
JSON field; existing v1.0.1 logs and scripts remain compatible.

### Added

- Codex live tracking through its documented `UserPromptSubmit`, `Stop` and
  `SessionEnd` hooks.
- Codex history backfill from `$CODEX_HOME/sessions` or `~/.codex/sessions`, using
  structural `task_started`, `task_complete` and `turn_aborted` boundaries.
- Additive JSON `bySource` totals for Claude Code and Codex. Existing `wallMinutes`,
  `turnMinutes`, `turns`, day and project fields keep their meaning.
- Source breakdowns in terminal and HTML reports.
- Read-only Codex installation planning for `hooks.json` and inline hooks in
  `config.toml`, including exact-duplicate and disabled-hook warnings.
- Agent-facing repository guidance, reusable operational prompts, contributor rules
  and a repeatable release checklist.

### Changed

- Session and logical-turn identities now include their source, so equal Claude Code
  and Codex ids cannot merge or suppress each other.
- Backfill reads both detected transcript roots and reports recovered counts per
  source while preserving pruned history.
- Daily durations are clipped at the configured work-day boundary, so terminal, JSON
  and HTML-grid totals agree when a turn crosses 05:00, including in time zones with
  daylight-saving transitions.
- Legacy v1.0.x events without `source` continue to be treated as Claude Code events.
- Empty-report guidance, privacy wording and accuracy notes now describe both agents.
- The public metric remains **agent active**: merged wall-clock time when at least one
  supported agent turn ran. It is not human working time or an invoice total.

### Safety and reliability

- Codex subagent rollouts are excluded because the parent turn already covers their
  orchestration interval.
- A non-empty, unrecognized Codex transcript set fails closed and leaves the previous
  backfill untouched. One currently-open rollout with no completed turn is allowed.
- Codex transcript content is neither copied nor stored; only timestamps, structural
  boundaries, ids and working directories are retained.
- Runtime remains dependency-free, telemetry-free, local-only and reproducible from
  JSONL plus local transcripts.

### Compatibility and limitations

- Existing live/backfill JSONL remains readable; `bySource`, `source` and `turnId` are
  additive metadata.
- Codex has no documented `StopFailure` lifecycle hook, so only Claude Code installs
  that event.
- Codex does not guarantee transcript format as a stable hooks API. The parser is
  structural and fail-closed, but a future Codex update may require an adapter update.
- Silence over 30 minutes is removed as idle and can undercount a genuinely long,
  quiet tool call.

### Verification required before publication

- Local syntax check, complete `node:test` suite and whitespace check.
- GitHub Actions on Node 20.1 and 22 across Ubuntu, macOS and Windows.
- Clean, repeated and v1.0.0-upgrade installation smoke tests.
- Published-tag clone and pinned install-URL validation.

## [1.0.1] — 2026-08-04

- Added `StopFailure`, logical turn identity, canonical project disambiguation,
  atomic/private persistence, idempotent installation planning and cross-platform CI.
- Renamed the primary presentation metric to **agent active** while retaining the
  backward-compatible JSON field `wallMinutes`.
- Reframed accuracy and privacy claims as measured local observations rather than
  universal guarantees.

## [1.0.0] — 2026-08-04

- Initial public release for local Claude Code agent-active tracking, transcript
  backfill, terminal/JSON/HTML reports and the Claude Code status line.

[1.1.0]: https://github.com/DrebotAI/agent-hours/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/DrebotAI/agent-hours/releases/tag/v1.0.1
[1.0.0]: https://github.com/DrebotAI/agent-hours/releases/tag/v1.0.0
