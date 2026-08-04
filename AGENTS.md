# agent-hours — notes for AI agents

## Installing for a user

Follow [docs/install.md](docs/install.md) — it is written for you, step by step.
The hard rules, in case you read nothing else: append missing hooks and remove only
exact duplicate agent-hours commands, never replace arrays; stop if `settings.json`
fails to parse; stop if `backfill` recovers 0 turns from a non-zero number of
transcripts; send no user data over the network; touch no path outside the install
directory and `~/.claude/settings.json`.

## Reading a user's numbers

`node hours.mjs report --json` is the machine interface (`--days N`, or a
`YYYY-MM-DD` date). `wallMinutes` is merged agent-active wall-clock time and
`turnMinutes` sums every turn. Neither is human working time or an automatic
billing total.

## Working on the code

- Everything lives in `hours.mjs` — one file, zero dependencies, Node 20.1+.
- Tests: `node --test`. A behavior change without a test in `hours.test.mjs`
  is not done.
- Every non-obvious rule has a numbered entry in [DECISIONS.md](DECISIONS.md).
  Read it before touching constants like `MAX_IDLE_MS` or `MAX_OPEN_TURN_MS`,
  and add an entry when you introduce a rule of your own.
- Do not add dependencies, a package.json, build steps, telemetry, or runtime network
  calls. The privacy claims in the README are load-bearing; code that breaks
  them is a bug regardless of what it fixes.
- Reports must stay reproducible from `~/.agent-hours.jsonl` plus the local
  transcripts alone.
