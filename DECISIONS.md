# Decisions

Why this tool works the way it does. Every rule here was a choice with a cheaper
alternative that was rejected for a stated reason.

## 1. Metadata only, never content

The log stores a timestamp, an event name, a session id and a working directory.
Nothing else. Prompts, replies, tool arguments, file contents and transcripts are
never copied anywhere.

This is the decision the whole project rests on. It asks you to run code on every
prompt you send; the only version of that anyone should accept is one where the
worst case is a leaked list of folder names and clock times.

The cost is real: without content there is no "what was I working on", no ticket
detection, no summaries. Those features are not coming, because each one would
require reading what you wrote.

## 2. A turn runs from `UserPromptSubmit` to `Stop`

This measures the agent's clock, not yours. The gap between a reply landing and your
next prompt — reading, thinking, fixing things by hand — is not counted.

The alternative is measuring presence: session start to session end, or wrapping the
terminal to watch keystrokes. Presence is a better answer to "how long was I working"
and needs a PTY wrapper and a native module to get. Two clean hooks and a smaller,
honest number was the better trade.

## 3. An unterminated turn is capped at four hours

A killed terminal never fires `Stop`, leaving a turn open forever. Uncapped, one
crash silently inflates a day.

Four hours is a guess, and deliberately a generous one — long enough to survive a
genuinely long agent run, short enough that a crash cannot swallow a night. Change
`MAX_OPEN_TURN_MS` if your runs are longer.

Two events close a turn more precisely than the cap when they can: `SessionEnd`
(a clean exit closes whatever is open, at exit time) and the next prompt of the
same session — Claude Code's `Stop` hook never fires on an Esc interrupt, so an
interrupted turn ends when you prompt again, not when a wrong `Stop` shows up.

## 4. Overlapping sessions collapse into wall clock

Two terminals working at 14:00 is one hour of elapsed time, not two. `report` gives
both figures: `wall clock` after merging overlaps, `turn time` before. Bill the first;
the ratio between them tells you how much parallelism you are running.

## 5. The day starts at 05:00

Work at 02:00 belongs to the day it started, not the calendar day it landed in. A
midnight boundary splits one session across two days and makes both look wrong.

Configurable via `AGENT_HOURS_DAY_START`. Set it to `0` for calendar days.

## 6. A project is the nearest git root

A session started in `src/` belongs to the repository, not to a folder called `src`.
The reporter walks up from the working directory to the first `.git` and uses that
folder's name, falling back to the working directory when there is no repository.

Naive `basename(cwd)` was tried first and produced entries like `src`, `docs` and
`ui` competing with real project names.

## 7. Backfill rewrites its own file

`backfill` writes to a separate file and rewrites it completely on every run, so
re-running cannot double-count. No deduplication logic exists because none is needed.

One exception to the clean rewrite: Claude Code eventually prunes old transcripts,
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
to speak.

A corrupt line is skipped at read time rather than repaired. Append-only means the
only way to get a corrupt line is a crash mid-write, which costs one turn.

## 9. `install` prints, it does not write

Merging hooks into an existing `~/.claude/settings.json` that already contains other
people's hooks is exactly the operation that breaks someone's Claude Code and gets
this repository deleted. Printing the block to paste costs the user fifteen seconds
and cannot corrupt anything.

## 10. No package.json, no npm, no CI

One file, no dependencies, `node --test` for tests. There is nothing to build and
nothing to install, so there is no toolchain to keep alive. This gets added when
someone actually needs `npx`.

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
the tracked wall clock was sleep. Live hook events cannot see inside a turn, which
is one more reason backfill outranks them (decision 7).

## 14. Subagent transcripts are machine time, not your time

Task-tool subagents get their own transcripts under `<session>/subagents/`, and
they keep running after the parent's turn ends. Counting them as sessions inflated
wall clock by ~2 hours per month in the audit. `backfill` skips them: the parent
session already covers the time you were actually present.
