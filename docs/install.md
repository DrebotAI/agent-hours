# Installing agent-hours

**These are instructions for an AI coding agent.** If you are a human reading this,
paste the line from the repository README into Claude Code and it will do all of this
for you — or follow the manual steps at the bottom.

---

## Agent instructions

You are installing `agent-hours`, a metadata-only time tracker for Claude Code
sessions. Work through these steps in order. Report what you did at the end.

### Step 1 — check the runtime

Run `node --version`. It must be **20.1.0 or newer** (`fs.readdirSync` with
`recursive: true` landed there).

If Node is missing or older, stop and tell the user how to install it for their
platform. Do not attempt to install Node yourself without asking.

### Step 2 — get the code

Clone into the user's home directory unless they have said otherwise:

- macOS / Linux: `~/.agent-hours`
- Windows: `%USERPROFILE%\.agent-hours`

```sh
git clone --branch v1.0.1 --depth 1 https://github.com/DrebotAI/agent-hours.git ~/.agent-hours
```

If git is unavailable, download and unpack the ZIP from
`https://github.com/DrebotAI/agent-hours/archive/refs/tags/v1.0.1.zip` instead.

If the directory already exists, check `git status --short` in it first. If it has
local changes, stop and tell the user. Otherwise fetch tags from `origin` and check
out `v1.0.1`; do not follow mutable `main` for an installation.

### Step 3 — recover existing history

```sh
node ~/.agent-hours/hours.mjs backfill
```

This reads timestamps out of the transcripts Claude Code already keeps in
`~/.claude/projects/`. It prints how many turns it recovered. **If it reports 0 turns
from a non-zero number of transcripts, stop and tell the user** — that means the
transcript format has changed and backfill needs updating. Do not hide this.

### Step 4 — install the hooks

Run `node ~/.agent-hours/hours.mjs install`. It reads `settings.json` without writing
it and prints only the missing hook entries. If it reports malformed JSON or an unsafe
shape, stop — do not overwrite the file.

Then edit `~/.claude/settings.json` yourself, carefully:

1. Read the current file. If it does not exist, create it as `{}`.
2. Parse it as JSON. **If it fails to parse, stop and tell the user** — do not
   overwrite a file you could not read.
3. Add the printed `UserPromptSubmit`, `Stop`, `StopFailure` and `SessionEnd` entries
   under the `hooks` key. The command omits events that are already installed. If any
   key already has entries, **append to the array — never replace it.**
4. If the command warns about exact duplicate agent-hours commands, remove only the
   duplicate copies and leave one under that event. Never remove or rewrite another
   tool's hook.
5. Write it back with 2-space indentation, and verify it re-parses.

The command in each hook must be exactly `node "<absolute path>/hours.mjs" hook claude`
with the path in plain double quotes. On Windows use the real path with single
backslashes — the JSON encoding escapes them for you, and escaping them yourself
produces a path that cmd cannot resolve.

### Step 5 — offer the status bar (optional)

Look at `~/.claude/settings.json`. **If it already has a `statusLine` key, skip
this step entirely and mention to the user that their status bar is already
taken** — never replace an existing statusLine, tools like ccusage live there too.

If there is no `statusLine`, ask the user whether they want today's agent-active time shown
at the bottom of Claude Code. If yes, add:

```json
"statusLine": { "type": "command", "command": "node \"<absolute path>/hours.mjs\" statusline" }
```

with the same plain-quoting rule as the hooks.

### Step 6 — show the result

```sh
node ~/.agent-hours/hours.mjs report --days 30
```

Show the user their numbers. Tell them to restart Claude Code so the hooks load, and
that from then on it counts automatically.

Explain the two figures in one line each: **agent active** is merged wall-clock time
with at least one Claude Code turn running; **turn time** is every turn summed, and the
ratio between them is how much parallelism they are running. Neither is human working
time or an automatic billing total.

### What not to do

- Do not send user data anywhere. Network access is only for cloning or fetching the
  pinned agent-hours release from `github.com/DrebotAI/agent-hours`.
- Do not add it to a shell profile, a cron job, or a launch agent. The four hooks are
  the whole integration.
- Do not modify anything outside `~/.agent-hours` and `~/.claude/settings.json`.

---

## Manual install

```sh
git clone --branch v1.0.1 --depth 1 https://github.com/DrebotAI/agent-hours.git
cd agent-hours
node hours.mjs backfill
node hours.mjs report --days 30
node hours.mjs install    # prints the block to paste into ~/.claude/settings.json
```

Restart Claude Code afterwards. Requires Node 20.1+.
