# agent-hours — notes for AI agents

## Installing for a user

Follow [docs/install.md](docs/install.md) — it is written for you, step by step.
The hard rules, in case you read nothing else: append to existing hook arrays,
never replace them; stop if `settings.json` fails to parse; stop if `backfill`
recovers 0 turns from a non-zero number of transcripts; make no network calls;
touch no file other than `~/.claude/settings.json`.

## Reading a user's numbers

`node hours.mjs report --json` is the machine interface (`--days N`, or a
`YYYY-MM-DD` date). `wallMinutes` merges parallel sessions and is the number a
human would bill; `turnMinutes` sums every turn; both are lower bounds on human
time — the pause between a reply and the next prompt is never counted.

## Working on the code

- Everything lives in `hours.mjs` — one file, zero dependencies, Node 20.1+.
- Tests: `node --test`. A behavior change without a test in `hours.test.mjs`
  is not done.
- Every non-obvious rule has a numbered entry in [DECISIONS.md](DECISIONS.md).
  Read it before touching constants like `MAX_IDLE_MS` or `MAX_OPEN_TURN_MS`,
  and add an entry when you introduce a rule of your own.
- Do not add dependencies, a package.json, build steps, telemetry, or network
  calls. The privacy claims in the README are load-bearing; code that breaks
  them is a bug regardless of what it fixes.
- Reports must stay reproducible from `~/.agent-hours.jsonl` plus the local
  transcripts alone.
