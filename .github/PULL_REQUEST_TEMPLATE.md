## What changed

<!-- Describe the user-visible outcome and why it is needed. -->

## Scope

- [ ] Shared report/event model
- [ ] Claude Code adapter
- [ ] Codex adapter
- [ ] Installer
- [ ] Documentation only

## Contract checks

- [ ] No prompt, reply, tool argument or file content is stored or transmitted.
- [ ] No dependency, package manager, telemetry or runtime network call was added.
- [ ] Existing JSONL and JSON report consumers remain compatible.
- [ ] Unrelated hooks, configs and status lines are preserved.
- [ ] English and Ukrainian documentation agree.
- [ ] A numbered decision documents every new non-obvious rule.

## Verification

- [ ] `node --check hours.mjs`
- [ ] `node --test`
- [ ] `git diff --check`
- [ ] Relevant install/backfill smoke test
- [ ] CLI/JSON/HTML totals agree when report behavior changes

## Remaining uncertainty

<!-- State what was not tested. Do not call CI or a platform green unless verified. -->
