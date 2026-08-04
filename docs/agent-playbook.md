# Agent playbook

This page gives humans copy-paste prompts and gives AI agents an operational runbook.
The root [AGENTS.md](../AGENTS.md) is the authoritative safety contract.

## Install the latest immutable release

Use this only after `v1.1.0` has been published:

```text
Install agent-hours for Claude Code and Codex by following this document exactly:
https://raw.githubusercontent.com/DrebotAI/agent-hours/v1.1.0/docs/install.md

Preserve every unrelated hook and setting. Stop on malformed JSON. Do not make any
network request except fetching this pinned agent-hours release. At the end, show me
the 30-day report and state which integrations were configured.
```

To install only one integration, replace the first sentence with either:

```text
Install agent-hours for Claude Code only ...
```

or:

```text
Install agent-hours for Codex only ...
```

The installation agent must still follow [install.md](install.md), including the
read-only `install` inspection and the Codex `/hooks` trust step.

## Read a user's numbers

Prompt:

```text
Open this agent-hours repository and run the JSON report for the last 7 days. Explain
agent active, turn time, turns, projects and the Claude Code/Codex source split. Do not
describe either duration as my human working time or as an invoice total. Do not
modify any files.
```

Agent procedure:

1. Run `node hours.mjs report --days 7 --json`.
2. Treat `wallMinutes` as the primary combined agent-active duration.
3. Explain that `turnMinutes - wallMinutes` represents overlapping turns.
4. Use `bySource` for the agent split. Its values may sum above `wallMinutes` when
   Claude Code and Codex overlap.
5. Mention that reading, thinking and manual work between turns are not measured.

## Diagnose an installation

Prompt:

```text
Diagnose why agent-hours is empty or inaccurate. Start with read-only checks, inspect
both Claude Code and Codex integration plans, and preserve all existing configs and
history. Do not reinstall, delete, rewrite or publish anything unless I approve it.
Report the root cause and the smallest safe fix.
```

Agent procedure:

```sh
node --version
node hours.mjs install
node hours.mjs backfill
node hours.mjs report --days 7 --json
```

Then verify:

- Node is 20.1 or newer.
- The command paths printed by `install` point to the current `hours.mjs`.
- Claude Code was restarted after editing `settings.json`.
- Codex hooks were reviewed and trusted with `/hooks`.
- `$CODEX_HOME` points to the expected directory, if it is set.
- The transcript roots exist and the backfill did not hit its 0-turn format guard.
- `AGENT_HOURS_DAY_START` is valid (`0` through `23`).

For silent live-hook errors, reproduce once with `AGENT_HOURS_DEBUG=1`. Do not leave
debug output enabled as a substitute for fixing the cause.

## Change the implementation

Prompt:

```text
Implement this change in agent-hours. First read AGENTS.md, CONTRIBUTING.md and the
relevant numbered decisions. Keep one dependency-free hours.mjs, preserve the JSONL
formats and privacy contract, add focused node:test coverage, update both English and
Ukrainian documentation when behavior changes, and run all required checks. Do not
commit, tag, push or publish unless I ask explicitly.
```

The working agent should summarize changed behavior, tests run, compatibility impact
and any remaining uncertainty. It should not claim cross-platform success until the
GitHub Actions matrix has passed for the exact commit.

## Prepare a release candidate

Prompt:

```text
Prepare agent-hours v1.1.0 as a release candidate. Follow AGENTS.md and
docs/releasing.md, reconcile CHANGELOG.md with the actual diff from v1.0.1, run local
acceptance checks, and report every remaining blocker. Do not create or push a tag and
do not publish the GitHub Release or announcement until I explicitly approve it.
```

## Publish after approval

Prompt:

```text
The v1.1.0 release candidate is approved. Verify the exact commit and green CI, create
the immutable v1.1.0 tag, publish the GitHub Release using
docs/releases/v1.1.0.md, validate the pinned install URL from a clean temporary
directory, and only then draft the public announcement. Stop instead of moving or
replacing an existing tag.
```

Publishing changes external state. An agent must treat this prompt, or equivalent
explicit authorization, as required before tagging, pushing or creating a release.
