# Contributing

agent-hours deliberately has a small implementation surface: one Node.js file, one
test file and zero dependencies. Contributions should make that surface more reliable,
not turn it into a framework.

## Set up

Install Node 20.1 or newer, clone the repository and run:

```sh
node --check hours.mjs
node --test
```

There is no `package.json`, install step or build step.

## Before changing behavior

1. Read [AGENTS.md](AGENTS.md) for the product and privacy contract.
2. Read [DECISIONS.md](DECISIONS.md) before changing time boundaries, identities,
   transcript parsing, persistence, project grouping or installation behavior.
3. Reproduce the behavior with the smallest synthetic fixture possible.
4. Decide whether the change affects Claude Code, Codex or their shared normalized
   event model. Do not make one parser depend on the other's transcript shape.

## Implementation rules

- Keep runtime code in `hours.mjs` and use Node built-ins only.
- Keep existing live and backfill JSONL readable. New fields must be optional.
- Never store or emit prompt text, reply text, tool arguments or file contents.
- Never add runtime network access, telemetry, accounts or cloud storage.
- Preserve owner-only files on POSIX and functional behavior on Windows.
- Prefer fail-closed behavior when a format change could erase or corrupt history.
- Keep terminal, JSON and HTML totals derived from the same report model.
- Keep project identity canonical; display labels may be shortened only after
  aggregation.

## Tests

Use `node:test` in `hours.test.mjs`. Every behavior change needs a regression test.
When applicable, cover:

- normal completion, interruption, failure and abandoned turns;
- Claude Code and Codex source separation;
- corrupt or unknown transcript input;
- old optional-field-free JSONL;
- duplicate-preserving, read-only installation planning;
- Windows path serialization;
- private and atomic persistence on POSIX;
- agreement between CLI/JSON/HTML report totals.

Before handing off a change, run:

```sh
node --check hours.mjs
node --test
git diff --check
```

GitHub Actions repeats syntax and tests on Node 20.1 and 22 across Ubuntu, macOS and
Windows. Do not claim that matrix is green until it has run for the exact commit.

## Documentation and decisions

Update `README.md` and `docs/README_uk.md` together for user-visible behavior. Update
`docs/install.md` for installation changes. Add a numbered decision when introducing
a non-obvious rule or changing a previous tradeoff.

Keep metric language precise:

- say **agent active**, not human work time;
- `wallMinutes` is the backward-compatible JSON name for that metric;
- `turnMinutes` includes overlaps;
- `bySource` values may overlap;
- accuracy audits are observations, not guarantees.

## Pull request handoff

State:

- what changed and why;
- which source adapters are affected;
- compatibility and privacy impact;
- tests and smoke tests actually run;
- documentation or decision entries updated;
- known limitations that remain.

Release publication is a separate operation. Follow
[docs/releasing.md](docs/releasing.md); never tag or publish merely because a code
change is complete.
