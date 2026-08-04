# agent-hours — instructions for AI agents

This file is the entry point for any agent working in this repository. First identify
the task, then follow the matching document. Do not improvise across task boundaries.

## Route the task

| User intent | Read first | Expected action |
| --- | --- | --- |
| Install or upgrade agent-hours | [docs/install.md](docs/install.md) | Inspect configs, print/merge only missing hooks, backfill, then show a report. |
| Read or explain usage numbers | [docs/agent-playbook.md](docs/agent-playbook.md#read-a-users-numbers) | Use the JSON interface and explain agent activity without calling it human time. |
| Diagnose an empty or suspicious report | [docs/agent-playbook.md](docs/agent-playbook.md#diagnose-an-installation) | Run read-only checks first; preserve logs and configs. |
| Change code or documentation | [CONTRIBUTING.md](CONTRIBUTING.md) and [DECISIONS.md](DECISIONS.md) | Preserve the zero-dependency, local-only design and add tests for behavior changes. |
| Prepare or publish a release | [docs/releasing.md](docs/releasing.md) and [CHANGELOG.md](CHANGELOG.md) | Complete every acceptance check; never publish without explicit user authorization. |

Copy-paste prompts for all of these jobs live in
[docs/agent-playbook.md](docs/agent-playbook.md).

## Product contract

agent-hours is a local, metadata-only tracker of **agent-active time** for Claude Code
and Codex. It is not a human-time tracker and is not an automatic billing system.

- `wallMinutes`: merged wall-clock time when at least one supported agent turn ran.
- `turnMinutes`: every turn duration summed, including overlaps.
- `bySource`: Claude Code and Codex totals; these may overlap each other.
- `turns`: logical prompts, not idle-gap segments.

The machine interface is:

```sh
node hours.mjs report --json
node hours.mjs report --days 7 --json
node hours.mjs report 2026-08-03 --json
```

## Non-negotiable safety rules

- Store timestamps, source, lifecycle event, session id, optional turn id and cwd only.
  Never persist prompts, replies, tool arguments, file contents or transcript content.
- Make no runtime network calls and add no telemetry, account, cloud sync or database.
- Keep the implementation dependency-free and compatible with Node 20.1+.
- Keep reports reproducible from the two local JSONL files and local transcripts.
- Preserve unrelated user hooks and settings. Remove only exact duplicate agent-hours
  commands; never replace an existing hook array or Claude Code `statusLine`.
- Stop on malformed `settings.json` or `hooks.json`. Do not repair or overwrite it.
- If non-zero transcripts recover zero turns, fail closed and retain the previous
  backfill. A lone currently-open Codex rollout is the documented exception.
- Keep logs, backfill and HTML snapshots private on POSIX; do not break Windows when
  tightening permissions best-effort.
- Keep `serve` bound to `127.0.0.1`.

During installation, network access is allowed only to fetch the pinned release from
`github.com/DrebotAI/agent-hours`. Direct configuration writes are limited to the
chosen install directory, `~/.claude/settings.json`, and the selected Codex
`$CODEX_HOME/hooks.json` or `$CODEX_HOME/config.toml`. Running agent-hours also creates
its documented private JSONL data files and optional HTML snapshots.

## Source-specific rules

Claude Code live events are `UserPromptSubmit`, `Stop`, `StopFailure` and
`SessionEnd`. Codex documents `UserPromptSubmit`, `Stop` and `SessionEnd`; do not
invent a Codex `StopFailure` hook.

Claude and Codex normalize into the same event model but use separate transcript
parsers. Codex transcript format is not a stable public hook interface, so changes to
that parser require fixtures, a fail-closed test and a real local rollout smoke test.
Source must remain part of session and logical-turn identity.

## Definition of done

Before declaring a repository change complete, run:

```sh
node --check hours.mjs
node --test
git diff --check
```

A behavior change is incomplete without a test in `hours.test.mjs`. A new
non-obvious policy is incomplete without a numbered entry in `DECISIONS.md`. Update
English and Ukrainian user documentation together when user-visible behavior changes.

Do not create a tag, push, publish a GitHub Release or announce availability unless
the user explicitly asks for that external action.
