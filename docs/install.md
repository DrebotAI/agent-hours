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
git clone https://github.com/DrebotAI/agent-hours.git ~/.agent-hours
```

If git is unavailable, download and unpack the ZIP from
`https://github.com/DrebotAI/agent-hours/archive/refs/heads/main.zip` instead.

If the directory already exists, run `git pull` in it rather than cloning again.

### Step 3 — recover existing history

```sh
node ~/.agent-hours/hours.mjs backfill
```

This reads timestamps out of the transcripts Claude Code already keeps in
`~/.claude/projects/`. It prints how many turns it recovered. **If it reports 0 turns
from a non-zero number of transcripts, stop and tell the user** — that means the
transcript format has changed and backfill needs updating. Do not hide this.

### Step 4 — install the hooks

Run `node ~/.agent-hours/hours.mjs install` to see the exact block that is needed.

Then edit `~/.claude/settings.json` yourself, carefully:

1. Read the current file. If it does not exist, create it as `{}`.
2. Parse it as JSON. **If it fails to parse, stop and tell the user** — do not
   overwrite a file you could not read.
3. Add `UserPromptSubmit` and `Stop` entries under the `hooks` key. If either key
   already has entries, **append to the array — never replace it.** Other tools put
   their hooks there and silently deleting them is the worst outcome of this install.
4. Write it back with 2-space indentation, and verify it re-parses.

The command in each hook must be exactly `node "<absolute path>/hours.mjs" hook claude`
with the path in plain double quotes. On Windows use the real path with single
backslashes — the JSON encoding escapes them for you, and escaping them yourself
produces a path that cmd cannot resolve.

### Step 5 — show the result

```sh
node ~/.agent-hours/hours.mjs report --days 30
```

Show the user their numbers. Tell them to restart Claude Code so the hooks load, and
that from then on it counts automatically.

Explain the two figures in one line each: **wall clock** is elapsed time with parallel
sessions counted once — the number to bill; **turn time** is every turn summed, and the
ratio between them is how much parallelism they are running.

### What not to do

- Do not send anything anywhere. This tool has no network calls, and the install
  should not add any.
- Do not add it to a shell profile, a cron job, or a launch agent. The two hooks are
  the whole integration.
- Do not modify any file other than `~/.claude/settings.json`.

---

## Manual install

```sh
git clone https://github.com/DrebotAI/agent-hours.git
cd agent-hours
node hours.mjs backfill
node hours.mjs report --days 30
node hours.mjs install    # prints the block to paste into ~/.claude/settings.json
```

Restart Claude Code afterwards. Requires Node 20.1+.
