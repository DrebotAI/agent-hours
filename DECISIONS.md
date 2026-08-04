# Decisions

Why this tool works the way it does. Every rule here was a choice with a cheaper
alternative that was rejected for a stated reason.

## 1. Metadata only, never content

The log stores a timestamp, source, event name, session id, optional logical turn id,
and working directory. Nothing else. Prompts, replies, tool arguments, file contents
and transcripts are never copied anywhere.

This is the decision the whole project rests on. It asks you to run code on every
prompt you send; the only version of that anyone should accept is one where the
worst case is a leaked list of folder names and clock times.

The cost is real: without retaining or analyzing content there is no "what was I
working on", no ticket detection, no summaries. Those features are not coming.

## 2. A turn runs from `UserPromptSubmit` to completion

Normal completion is `Stop`; Claude Code also exposes `StopFailure` for an API error.
This measures agent activity, not human working time. The gap between a reply landing and the next prompt
— reading, thinking, fixing things by hand — is not counted, while unattended agent
work is.

The alternative is measuring presence: session start to session end, or wrapping the
terminal to watch keystrokes. Presence is a better answer to "how long was I working"
and needs a PTY wrapper and a native module to get. Four small lifecycle hooks and a
clearly named agent-active number were the better trade.

## 3. An unterminated turn is capped at four hours

A killed terminal never fires `Stop`, leaving a turn open forever. Uncapped, one
crash silently inflates a day.

Four hours is a guess, and deliberately a generous one — long enough to survive a
genuinely long agent run, short enough that a crash cannot swallow a night. Change
`MAX_OPEN_TURN_MS` if your runs are longer.

Three events close a Claude turn more precisely than the cap when they can:
`StopFailure` (an API error), `SessionEnd` (a clean exit closes whatever is open, at
exit time), and the next prompt of the same session — Claude Code's `Stop` hook never fires on
an Esc interrupt, so an
interrupted turn ends when you prompt again, not when a wrong `Stop` shows up.

## 4. Overlapping sessions collapse into agent-active time

Two terminals working at 14:00 is one hour of elapsed time, not two. `report` gives
both figures: `agent active` after merging overlaps, `turn time` before. The ratio
between them tells you how much parallelism you are running. Neither claims to be
human working time or an automatic billing total.

## 5. The day starts at 05:00

Work at 02:00 belongs to the day it started, not the calendar day it landed in. A
midnight boundary splits one session across two days and makes both look wrong.

Configurable via `AGENT_HOURS_DAY_START`. Set it to `0` for calendar days.

## 6. A project is the nearest git root

A session started in `src/` belongs to the repository, not to a folder called `src`.
The reporter walks up from the working directory to the first `.git` and groups by
that canonical root, falling back to the working directory when there is no repository.
Display labels normally use the basename; collisions expand to the shortest unique
path suffix (`client-a/app`, `client-b/app`) instead of merging unrelated work.

Naive `basename(cwd)` was tried first and produced entries like `src`, `docs` and
`ui` competing with real project names.

## 7. Backfill rewrites its own file

`backfill` writes to a separate file and rewrites it completely on every run, so
re-running cannot double-count. The replacement is written and flushed beside the
target, then atomically renamed; a crash cannot expose a truncated history file.

One exception to the clean rewrite: coding agents can eventually prune old transcripts,
and a session recovered on an earlier run must not vanish with its transcript. So
the rewrite unions with its previous self — sessions still on disk are re-parsed
fresh, sessions whose transcripts are gone are carried over. History does not rot.

At report time, the freshest source wins per session. Backfilled turns carry the
full activity timeline — idle gaps split out, interrupted turns recovered — so they
replace the live events they overlap; live events newer than the last backfill keep
the clock running in real time. A session is never counted twice.

`report` and `serve` refresh a backfill older than 15 minutes automatically —
keeping the numbers honest must not depend on remembering a maintenance command.

## 8. Append-only JSONL, no database

The hook does one `appendFileSync` of one line, wrapped in a `catch` that swallows
everything. Telemetry that can break the session it is measuring is worse than no
telemetry, so failure is always silent — set `AGENT_HOURS_DEBUG=1` when you need it
to speak. Logs, backfills and exported HTML are owner-only on POSIX systems; HTML
uses an unpredictable private temp directory.

A corrupt line is skipped at read time rather than repaired. Append-only means the
only way to get a corrupt line is a crash mid-write, which costs one turn.

## 9. `install` prints, it does not write

Merging hooks into an existing agent config is exactly the operation that breaks
someone's setup. `install` reads Claude Code's JSON plus Codex's `hooks.json` and
inline TOML, then prints only missing entries; it never writes. Exact existing
agent-hours hooks are skipped, duplicates are reported across Codex representations,
malformed JSON stops that flow, and unrelated hooks are never replaced. Public
install instructions point at an immutable release tag rather than mutable `main`.

## 10. No package.json or npm; minimal CI

One file, no dependencies, `node --test` for tests. There is nothing to build and no
package toolchain to keep alive. A small GitHub Actions matrix runs syntax and tests
on the minimum Node version and current Node across Linux, macOS and Windows because
cross-platform behavior is a public claim worth verifying.

## 11. The status bar is opt-in and never evicts a tenant

`statusline` prints one line for Claude Code's `statusLine` slot — but that slot is
shared real estate (ccusage and friends live there too), and there is exactly one.
The install flow only offers it when the slot is empty and never replaces an
existing statusLine. Breaking someone's setup is worse than a missing feature —
the same reasoning as `install` printing instead of writing.

## 12. `serve` binds to loopback and nothing else

The live viewer listens on `127.0.0.1`, not `0.0.0.0`, and there is no flag to
change that. The moment a report of your working hours is reachable from the
network, "nothing leaves your machine" becomes a lie with an asterisk. If the
page needs to travel, export the HTML file and move that.

## 13. A dead gap of 30+ minutes inside a turn is not work

Backfilled turns are split wherever the transcript timeline goes silent for more
than 30 minutes (`MAX_IDLE_MS`), and the silence is dropped. Audited on real data:
a laptop that fell asleep mid-tool-call produced a single "turn" of 14.7 hours the
4-hour cap could not catch, because the prompt→stop pair looked valid — 41% of
the tracked agent-active total was sleep. A genuinely long silent tool call can also
be removed, so this heuristic may undercount; the audit informed the default but is
not a universal accuracy guarantee. Live hook events cannot see inside a turn, which
is one more reason backfill outranks them (decision 7).

## 14. Subagent transcripts are machine time, not your time

Claude task-tool subagents get transcripts under `<session>/subagents/`; Codex marks
subagent rollouts in `session_meta.source`. They can keep running after the parent's
turn ends. Counting them as sessions inflated agent-active time by ~2 hours per month
in the original local audit. `backfill` skips both forms because the parent turn
already covers their orchestration interval.

## 15. One prompt stays one logical turn after idle splitting

An idle gap can split one prompt into several measurable intervals. Those intervals
must contribute separately to time totals but only once to `TURNS`. Backfill gives
each segment a stable optional `turnId`. Old JSONL remains readable through the
start-event fallback; rare split turns carried from already-pruned transcripts keep
their legacy segment count because their original identity cannot be reconstructed.

## 16. Claude Code and Codex share a metric, not a parser

Both adapters normalize into the same metadata events, but their source formats stay
separate. Claude Code backfill infers prompts, replies, tool results and interrupts
from message structure. Codex rollouts provide explicit `task_started`,
`task_complete` and `turn_aborted` events plus stable ids inside each observed file,
so the Codex parser uses those boundaries and never inspects message content.

Live Codex capture installs the three lifecycle events its public
[hook reference](https://learn.chatgpt.com/docs/hooks) documents:
`UserPromptSubmit`, `Stop` and `SessionEnd`. It does not invent a Codex `StopFailure`.
The installer uses `hooks.json` unless the user already chose inline hooks in
`config.toml`, inspects both forms for exact duplicates, and reminds the user to
approve non-managed commands in `/hooks`.

Codex explicitly says its transcript format is not a stable hooks interface. That is
why the parser is small and structural, the 0-turn format guard leaves the previous
backfill untouched, and this compatibility claim is backed by fixtures plus a local
rollout smoke test rather than a promise that future schemas cannot change. Source is
part of every session and logical-turn key, so a coincidentally equal Claude and Codex
id can never merge or suppress the other agent's data.

## 17. Report periods clip turns at the shifted day boundary

A turn that crosses 05:00 contributes only its overlap to each work day. The same
logical turn can therefore appear in both single-day reports, while a multi-day report
still counts it once. Project, source, terminal, JSON and HTML-grid totals all use the
same clipped intervals. The shift uses local calendar hours, not a fixed millisecond
offset, so 05:00 stays the boundary across daylight-saving transitions.

Assigning the whole turn to its start day made the headline total disagree with the
HTML hour grid, which already split occupancy at 05:00. Clipping durations preserves
the meaning of a reporting period and keeps every presentation internally consistent.
