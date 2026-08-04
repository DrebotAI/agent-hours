# Installing agent-hours

**These are instructions for an AI coding agent.** If you are a human reading this,
paste the line from the repository README into Claude Code or Codex and it will do
all of this for you — or follow the manual steps at the bottom.

---

## Agent instructions

You are installing `agent-hours`, a metadata-only active-time tracker for Claude
Code and Codex. Work through these steps in order and report what you did at the end.

### Step 1 — check the runtime

Run `node --version`. It must be **20.1.0 or newer** (`fs.readdirSync` with
`recursive: true` landed there).

If Node is missing or older, stop and tell the user how to install it for their
platform. Do not install Node without asking.

### Step 2 — get the code

Clone into the user's home directory unless they have said otherwise:

- macOS / Linux: `~/.agent-hours`
- Windows: `%USERPROFILE%\.agent-hours`

```sh
git clone --branch v1.1.0 --depth 1 https://github.com/DrebotAI/agent-hours.git ~/.agent-hours
```

If git is unavailable, download and unpack
`https://github.com/DrebotAI/agent-hours/archive/refs/tags/v1.1.0.zip` instead.

If the directory already exists, check `git status --short` first. If it has local
changes, stop and tell the user. Otherwise fetch tags from `origin` and check out
`v1.1.0`; do not follow mutable `main` for an installation.

### Step 3 — recover existing history

```sh
node ~/.agent-hours/hours.mjs backfill
```

This reads timestamps and structural metadata from the local histories already kept
under `~/.claude/projects/` and `$CODEX_HOME/sessions` (normally
`~/.codex/sessions`). It never copies or stores message content.

The output reports recovered turns per agent. **If it reports 0 turns from a
non-zero number of transcripts and exits with an error, stop and tell the user.**
That fail-closed check means a transcript format may have changed; the previous
backfill is deliberately left untouched.

### Step 4 — inspect and install the hooks

Run:

```sh
node ~/.agent-hours/hours.mjs install
```

The command is read-only. It inspects Claude Code's `~/.claude/settings.json` and
Codex's `$CODEX_HOME/hooks.json` plus `config.toml`, then prints only missing hooks.
Use `install claude` or `install codex` if the user wants only one integration.

If any JSON file is malformed or has an unsafe shape, stop for that agent. Never
overwrite a config that could not be parsed.

#### Claude Code section

Carefully merge the printed block into `~/.claude/settings.json`:

1. If the file does not exist, create it as `{}`.
2. Parse it as JSON. If parsing fails, stop.
3. Add only the printed `UserPromptSubmit`, `Stop`, `StopFailure`, and `SessionEnd`
   entries under `hooks`. Append to existing arrays — never replace an array.
4. If warned about exact duplicate agent-hours commands, remove only the duplicate
   copies and leave one per event. Never change another tool's hook.
5. Write with 2-space indentation and verify that it re-parses.

Each command must be exactly `node "<absolute path>/hours.mjs" hook claude`. On
Windows use the real path with single backslashes in memory; JSON escaping is applied
by the serializer, not by hand.

#### Codex section

The command chooses the active representation safely:

- Normally it prints JSON for `$CODEX_HOME/hooks.json`.
- If no `hooks.json` exists but `config.toml` already contains inline hooks, it
  prints TOML blocks for that file instead, avoiding mixed representations.

For JSON, create the file from the printed object or append each printed matcher
group to the existing event array. Never replace existing arrays or top-level keys.
For TOML, append the printed array-of-table blocks exactly; never rewrite unrelated
tables. The Codex events are `UserPromptSubmit`, `Stop`, and `SessionEnd` — Codex
does not document a `StopFailure` lifecycle event.

The installer checks exact agent-hours commands across both Codex files. If it warns
about duplicates, remove only exact duplicate agent-hours entries. If it warns that
hooks are disabled under `[features]`, tell the user; do not silently change that
preference.

After restarting Codex, open `/hooks`, review the new commands, and trust them.
Non-managed Codex command hooks do not run until the user approves their definition.

### Step 5 — offer the Claude Code status bar (optional)

This feature is Claude Code-only. If `~/.claude/settings.json` already has a
`statusLine`, skip it and say why. Never replace the slot.

If it is empty and the user wants today's total at the bottom of Claude Code, add the
`statusLine` block printed by `install`, using the same JSON safety rules.

### Step 6 — show the result

```sh
node ~/.agent-hours/hours.mjs backfill
node ~/.agent-hours/hours.mjs report --days 30
```

Show the result and mention which agents were configured. **Agent active** is merged
wall-clock time with at least one Claude Code or Codex turn running. **Turn time**
sums every turn, and the ratio shows parallelism. Neither is human working time or
an automatic billing total. JSON keeps `wallMinutes` for compatibility and adds a
`bySource` breakdown.

### What not to do

- Do not send user data anywhere. Network access is only for fetching the pinned
  agent-hours release from `github.com/DrebotAI/agent-hours`.
- Do not add a shell profile entry, cron job, launch agent, database, or telemetry.
- Do not directly modify anything outside the chosen install directory,
  `~/.claude/settings.json`, `$CODEX_HOME/hooks.json`, and `$CODEX_HOME/config.toml`.
  Running agent-hours itself creates its documented private JSONL data files and
  optional HTML snapshots.
- Do not install hooks for an agent the user did not ask for or that is not detected
  on the machine without asking first.

---

## Manual install

```sh
git clone --branch v1.1.0 --depth 1 https://github.com/DrebotAI/agent-hours.git
cd agent-hours
node hours.mjs backfill
node hours.mjs report --days 30
node hours.mjs install          # both agents
node hours.mjs install codex    # or only Codex
```

Restart the configured agents. In Codex, review the command hooks with `/hooks`.
Requires Node 20.1+.
