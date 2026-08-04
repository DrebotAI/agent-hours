# Release procedure

This is the maintainer and AI-agent checklist for publishing agent-hours. Preparing a
release candidate does not authorize pushing, tagging, publishing or posting publicly.
Those external actions require explicit user approval.

## 1. Establish the candidate

- Confirm the intended version and previous release tag.
- Inspect `git status --short`; distinguish release changes from unrelated user work.
- Review `git diff <previous-tag> -- hours.mjs hours.test.mjs` and make sure
  `CHANGELOG.md` describes the actual behavior, not the plan.
- Update every pinned version in `README.md`, `docs/README_uk.md`, `docs/install.md`,
  `docs/agent-playbook.md` and `CHANGELOG.md`.
- In the final release commit, replace `Unreleased` in `CHANGELOG.md` with the actual
  publication date. Leave it as `Unreleased` while publication timing is unknown.
- Use an immutable tag in public install URLs. Never point installation at `main`.

For v1.1.0, the previous tag is `v1.0.1`.

## 2. Local acceptance

Run from the repository root:

```sh
node --check hours.mjs
node --test
git diff --check
```

Also verify these user journeys in temporary homes or disposable accounts:

1. Clean install with no Claude Code or Codex config.
2. Repeated install produces no duplicate hook.
3. Upgrade from v1.0.0 adds only Claude Code `StopFailure` plus the requested Codex
   integration; unrelated hooks and `statusLine` remain unchanged.
4. Malformed JSON exits non-zero without modifying the file.
5. Backfill with recognized transcripts reports non-zero turns per detected source.
6. Unknown non-empty transcript format leaves the previous backfill intact.
7. CLI, JSON and HTML agree on combined totals and source breakdown.
8. On POSIX, live/backfill/HTML files are private; on Windows, path JSON round-trips.
9. The HTML report is inspected in both English and Ukrainian.

The installer itself is read-only. For install smoke tests, apply its printed config
to disposable files only and verify that the files re-parse.

## 3. Commit and CI

- Commit the complete candidate without unrelated files.
- Push the candidate branch or commit.
- Wait for every GitHub Actions job on the exact commit:
  Node 20.1 and 22 on Ubuntu, macOS and Windows.
- Treat skipped, cancelled or stale jobs as unverified, not green.
- If anything changes after CI, repeat local acceptance and CI.

## 4. Publish the immutable release

Only after explicit approval and green CI:

```sh
git tag -a v1.1.0 -m "v1.1.0 — Claude Code and Codex agent-active time"
git push origin main
git push origin v1.1.0
```

Before creating the tag, stop if `v1.1.0` already exists locally or remotely. Never
move, delete and recreate, or force-push a public version tag. Ship a new patch version
instead.

Create the GitHub Release from [releases/v1.1.0.md](releases/v1.1.0.md), reconciling
its verification section with the exact published commit. Keep the limitations and
migration notes; do not market the metric as human time or billing.

## 5. Validate the published artifact

After GitHub serves the tag:

- Open the raw pinned install document:
  `https://raw.githubusercontent.com/DrebotAI/agent-hours/v1.1.0/docs/install.md`.
- Clone `--branch v1.1.0 --depth 1` into a fresh temporary directory.
- Run `node --check hours.mjs` and `node --test` from that clone.
- Run `node hours.mjs install` with a disposable HOME and confirm it remains read-only.
- Confirm the source archive contains `AGENTS.md`, `CHANGELOG.md`, `CONTRIBUTING.md`,
  `DECISIONS.md`, `README.md`, `docs/`, `hours.mjs` and `hours.test.mjs`.

If the artifact fails, do not replace the tag. Publish a corrected patch release.

## 6. Announce

Publish a post only after the artifact validation succeeds. Position agent-hours as a
local, privacy-first tracker of Claude Code and Codex **agent-active time**. Mention:

- one file, zero dependencies and no runtime network calls;
- combined wall-clock time plus per-agent and per-project breakdown;
- local transcript backfill without retaining message content;
- the metric does not replace a human timer or billing system;
- a long silent tool call may be undercounted;
- Codex transcript compatibility is guarded but cannot be permanently guaranteed.

Link to the immutable GitHub Release, not a raw `main` file.
