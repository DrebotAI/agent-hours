import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  atomicWritePrivate,
  bar,
  buildReport,
  codexHookConfig,
  codexInstallPlan,
  codexTomlConfig,
  codexTranscript,
  dateRange,
  hookConfig,
  hourGrid,
  htmlReport,
  installPlan,
  merge,
  minutes,
  parseDayStart,
  projectLabels,
  statuslineConfig,
  transcriptTurns,
  turns,
  workDay,
} from "./hours.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "hours.mjs");

const at = (...parts) => new Date(...parts).toISOString();
const prompt = (session, ...parts) => ({
  at: at(...parts),
  source: "claude",
  event: "UserPromptSubmit",
  sessionId: session,
  cwd: "/work/demo",
});
const stop = (session, ...parts) => ({ ...prompt(session, ...parts), event: "Stop" });

test("a prompt pairs with the next stop of the same session", () => {
  const list = turns([prompt("a", 2026, 7, 3, 10, 0), stop("a", 2026, 7, 3, 10, 30)]);
  assert.equal(list.length, 1);
  assert.equal(minutes(list), 30);
});

test("a stop with no prompt is ignored", () => {
  assert.deepEqual(turns([stop("a", 2026, 7, 3, 10, 30)]), []);
});

test("sessions do not steal each other's stops", () => {
  const list = turns([
    prompt("a", 2026, 7, 3, 10, 0),
    prompt("b", 2026, 7, 3, 10, 5),
    stop("b", 2026, 7, 3, 10, 15),
    stop("a", 2026, 7, 3, 11, 0),
  ]);
  assert.deepEqual(list.map((turn) => minutes([turn])).sort((x, y) => x - y), [10, 60]);
});

test("an unterminated turn is capped at four hours", () => {
  const now = new Date(2026, 7, 3, 23, 0).getTime();
  assert.equal(minutes(turns([prompt("a", 2026, 7, 3, 10, 0)], now)), 240);
});

test("a new prompt closes an interrupted turn of the same session", () => {
  const list = turns([
    prompt("a", 2026, 7, 3, 10, 0),
    prompt("a", 2026, 7, 3, 10, 20),
    stop("a", 2026, 7, 3, 10, 30),
  ]);
  assert.deepEqual(list.map((turn) => minutes([turn])), [20, 10]);
});

test("SessionEnd closes whatever the session left open", () => {
  const end = { ...prompt("a", 2026, 7, 3, 10, 15), event: "SessionEnd" };
  assert.equal(minutes(turns([prompt("a", 2026, 7, 3, 10, 0), end])), 15);
});

test("StopFailure closes a failed turn at the failure time", () => {
  const failed = { ...prompt("a", 2026, 7, 3, 10, 12), event: "StopFailure" };
  assert.equal(minutes(turns([prompt("a", 2026, 7, 3, 10, 0), failed])), 12);
});

test("parallel sessions collapse into wall clock time", () => {
  const list = turns([
    prompt("a", 2026, 7, 3, 10, 0),
    stop("a", 2026, 7, 3, 11, 0),
    prompt("b", 2026, 7, 3, 10, 30),
    stop("b", 2026, 7, 3, 11, 30),
  ]);
  assert.equal(minutes(list), 120, "turn time counts both sessions");
  assert.equal(minutes(merge(list)), 90, "wall clock counts the overlap once");
});

test("reports merge Claude and Codex while retaining a source breakdown", () => {
  const codexPrompt = { ...prompt("same-id", 2026, 7, 3, 10, 30), source: "codex", turnId: "turn-c" };
  const codexStop = { ...codexPrompt, at: at(2026, 7, 3, 11, 30), event: "Stop" };
  const claudePrompt = { ...prompt("same-id", 2026, 7, 3, 10, 0), turnId: "turn-a" };
  const report = buildReport(
    [claudePrompt, { ...claudePrompt, at: at(2026, 7, 3, 11, 0), event: "Stop" }, codexPrompt, codexStop],
    ["2026-08-03"],
  );
  assert.equal(report.wallMinutes, 90);
  assert.equal(report.turnMinutes, 120);
  assert.equal(report.turns, 2);
  assert.deepEqual(report.bySource, { claude: 60, codex: 60 });
});

test("legacy events without a source remain Claude Code events", () => {
  const start = { ...prompt("legacy", 2026, 7, 3, 10, 0) };
  const end = { ...stop("legacy", 2026, 7, 3, 10, 30) };
  delete start.source;
  delete end.source;
  const report = buildReport([start, end], ["2026-08-03"]);
  assert.equal(report.wallMinutes, 30);
  assert.deepEqual(report.bySource, { claude: 30 });
});

test("work before the 05:00 cutoff belongs to the previous day", () => {
  assert.equal(workDay(new Date(2026, 7, 3, 3, 0).getTime()), "2026-08-02");
  assert.equal(workDay(new Date(2026, 7, 3, 6, 0).getTime()), "2026-08-03");
});

test("the 05:00 cutoff remains local across daylight-saving transitions", () => {
  const program = `
    import { workDay } from ${JSON.stringify(pathToFileURL(script).href)};
    const values = [
      "2026-03-08T04:30:00",
      "2026-03-08T05:00:00",
      "2026-11-01T04:30:00",
      "2026-11-01T05:00:00",
    ].map((value) => workDay(new Date(value).getTime()));
    process.stdout.write(JSON.stringify(values));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8",
    env: { ...process.env, AGENT_HOURS_DAY_START: "5", TZ: "America/New_York" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    "2026-03-07",
    "2026-03-08",
    "2026-10-31",
    "2026-11-01",
  ]);
});

test("an invalid day-start value falls back to 05:00", () => {
  assert.equal(parseDayStart("nope"), 5);
  assert.equal(parseDayStart(""), 5);
  assert.equal(parseDayStart(-1), 5);
  assert.equal(parseDayStart(24), 5);
  assert.equal(parseDayStart(0), 0);
});

test("events with malformed timestamps are ignored", () => {
  const bad = { ...prompt("a", 2026, 7, 3, 10, 0), at: "not-a-date" };
  assert.deepEqual(turns([bad, stop("a", 2026, 7, 3, 10, 30)]), []);
});

test("a date range walks back over a month boundary", () => {
  assert.deepEqual(dateRange("2026-08-02", 3), ["2026-07-31", "2026-08-01", "2026-08-02"]);
});

test("a transcript turn runs from the prompt to the last reply", () => {
  const transcript = [
    { type: "user", timestamp: "2026-08-03T10:00:00Z", cwd: "/work", message: { content: "hi" } },
    { type: "assistant", timestamp: "2026-08-03T10:01:00Z" },
    { type: "user", timestamp: "2026-08-03T10:02:00Z", message: { content: [{ type: "tool_result" }] } },
    { type: "assistant", timestamp: "2026-08-03T10:05:00Z" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.deepEqual(transcriptTurns(transcript), [
    {
      start: "2026-08-03T10:00:00Z",
      cwd: "/work",
      stop: "2026-08-03T10:05:00Z",
      turnId: "2026-08-03T10:00:00Z",
    },
  ]);
});

test("a machine asleep mid-turn is cut out of the turn", () => {
  const transcript = [
    { type: "user", timestamp: "2026-08-03T10:00:00Z", cwd: "/work", message: { content: "hi" } },
    { type: "assistant", timestamp: "2026-08-03T10:05:00Z" },
    { type: "assistant", timestamp: "2026-08-03T22:00:00Z" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.deepEqual(transcriptTurns(transcript), [
    {
      start: "2026-08-03T10:00:00Z",
      cwd: "/work",
      stop: "2026-08-03T10:05:00Z",
      turnId: "2026-08-03T10:00:00Z",
    },
  ]);
});

test("an interrupted prompt still counts up to its last activity", () => {
  const transcript = [
    { type: "user", timestamp: "2026-08-03T10:00:00Z", cwd: "/work", message: { content: "hi" } },
    { type: "assistant", timestamp: "2026-08-03T10:01:00Z", message: { content: [{ type: "tool_use" }] } },
    { type: "user", timestamp: "2026-08-03T10:07:00Z", message: { content: [{ type: "tool_result" }] } },
    { type: "user", timestamp: "2026-08-03T10:08:00Z", message: { content: "[Request interrupted by user]" } },
    { type: "user", timestamp: "2026-08-03T10:30:00Z", cwd: "/work", message: { content: "next" } },
    { type: "assistant", timestamp: "2026-08-03T10:31:00Z" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.deepEqual(transcriptTurns(transcript), [
    {
      start: "2026-08-03T10:00:00Z",
      cwd: "/work",
      stop: "2026-08-03T10:08:00Z",
      turnId: "2026-08-03T10:00:00Z",
    },
    {
      start: "2026-08-03T10:30:00Z",
      cwd: "/work",
      stop: "2026-08-03T10:31:00Z",
      turnId: "2026-08-03T10:30:00Z",
    },
  ]);
});

test("idle-gap segments retain one logical turn count", () => {
  const transcript = [
    { type: "user", timestamp: "2026-08-03T10:00:00Z", cwd: "/work", message: { content: "hi" } },
    { type: "assistant", timestamp: "2026-08-03T10:05:00Z" },
    { type: "assistant", timestamp: "2026-08-03T11:00:00Z" },
    { type: "assistant", timestamp: "2026-08-03T11:05:00Z" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  const segments = transcriptTurns(transcript);
  assert.equal(segments.length, 2);
  assert.equal(new Set(segments.map((turn) => turn.turnId)).size, 1);
  const events = segments.flatMap((turn) => [
    { at: turn.start, event: "UserPromptSubmit", source: "claude", sessionId: "a", cwd: turn.cwd, turnId: turn.turnId },
    { at: turn.stop, event: "Stop", source: "claude", sessionId: "a", cwd: turn.cwd, turnId: turn.turnId },
  ]);
  const report = buildReport(events, [workDay(Date.parse(segments[0].start))]);
  assert.equal(report.turns, 1);
  assert.equal(report.turnMinutes, 10);
});

test("a transcript prompt with no reply is dropped", () => {
  const transcript = JSON.stringify({
    type: "user",
    timestamp: "2026-08-03T10:00:00Z",
    message: { content: "hi" },
  });
  assert.deepEqual(transcriptTurns(transcript), []);
});

test("transcript turns survive corrupt lines", () => {
  assert.deepEqual(transcriptTurns("not json\n\n{broken"), []);
});

test("a Codex transcript uses explicit task boundaries and cwd", () => {
  const transcript = [
    { timestamp: "2026-08-03T10:00:00Z", type: "session_meta", payload: { id: "session-c", cwd: "/old", source: "cli" } },
    { timestamp: "2026-08-03T10:01:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { timestamp: "2026-08-03T10:01:01Z", type: "turn_context", payload: { turn_id: "turn-1", cwd: "/work/codex" } },
    { timestamp: "2026-08-03T10:03:00Z", type: "response_item", payload: { type: "reasoning" } },
    { timestamp: "2026-08-03T10:06:00Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
  ].map(JSON.stringify).join("\n");
  assert.deepEqual(codexTranscript(transcript), {
    sessionId: "session-c",
    isSubagent: false,
    starts: 1,
    closes: 1,
    recognized: true,
    turns: [{ start: "2026-08-03T10:01:00Z", cwd: "/work/codex", stop: "2026-08-03T10:06:00Z", turnId: "turn-1" }],
  });
});

test("a Codex interrupt ends at turn_aborted", () => {
  const transcript = [
    { timestamp: "2026-08-03T10:00:00Z", type: "session_meta", payload: { id: "session-c", cwd: "/work", source: "cli" } },
    { timestamp: "2026-08-03T10:01:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { timestamp: "2026-08-03T10:08:00Z", type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-1", reason: "interrupted" } },
  ].map(JSON.stringify).join("\n");
  assert.equal(minutes(codexTranscript(transcript).turns.map((turn) => ({ start: Date.parse(turn.start), stop: Date.parse(turn.stop) }))), 7);
});

test("a freshly created Codex transcript with no turns yet is recognized, not corrupt", () => {
  const metaOnly = JSON.stringify({
    timestamp: "2026-08-03T10:00:00Z",
    type: "session_meta",
    payload: { id: "session-fresh", cwd: "/work", source: "cli" },
  });
  assert.deepEqual(codexTranscript(metaOnly), {
    sessionId: "session-fresh",
    isSubagent: false,
    starts: 0,
    closes: 0,
    recognized: true,
    turns: [],
  });
  assert.deepEqual(codexTranscript(""), {
    sessionId: "",
    isSubagent: false,
    starts: 0,
    closes: 0,
    recognized: false,
    turns: [],
  });
});

test("Codex idle segments keep one logical turn and subagents are excluded", () => {
  const root = [
    { timestamp: "2026-08-03T10:00:00Z", type: "session_meta", payload: { id: "root", cwd: "/work", source: "vscode" } },
    { timestamp: "2026-08-03T10:01:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    { timestamp: "2026-08-03T10:05:00Z", type: "response_item", payload: { type: "reasoning" } },
    { timestamp: "2026-08-03T11:00:00Z", type: "response_item", payload: { type: "reasoning" } },
    { timestamp: "2026-08-03T11:05:00Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
  ];
  const parsed = codexTranscript(root.map(JSON.stringify).join("\n"));
  assert.equal(parsed.turns.length, 2);
  assert.equal(new Set(parsed.turns.map((turn) => turn.turnId)).size, 1);
  const subagent = structuredClone(root);
  subagent[0].payload.source = { subagent: { thread_spawn: { parent_thread_id: "parent" } } };
  const excluded = codexTranscript(subagent.map(JSON.stringify).join("\n"));
  assert.equal(excluded.isSubagent, true);
  assert.deepEqual(excluded.turns, []);
  assert.deepEqual(codexTranscript("corrupt\n{broken").turns, []);
});

test("bars scale to the widest row and keep sub-cell precision", () => {
  assert.equal(bar(120, 120, 24), "█".repeat(24), "the max value fills every cell");
  assert.equal(bar(60, 120, 24), "█".repeat(12), "half the max fills half the cells");
  assert.equal(bar(1, 8, 1), "▏", "a sliver still shows as a fractional block");
  assert.equal(bar(0, 0, 24), "", "an empty report draws nothing");
});

test("html report escapes project names and carries the totals", () => {
  const html = htmlReport({
    range: "2026-07-28..2026-08-03",
    wallMinutes: 60,
    turnMinutes: 90,
    turns: 3,
    bySource: { claude: 60, codex: 30 },
    byProject: { "<evil> & co": 60 },
    byDay: [["2026-08-03", Array.from({ length: 24 }, (_, hour) => (hour === 10 ? 60 : 0))]],
  });
  assert.ok(html.includes("&lt;evil&gt; &amp; co"), "markup in a project name is escaped");
  assert.ok(!html.includes("<evil>"), "raw markup never reaches the page");
  assert.ok(html.includes("1:00"), "the wall clock total is rendered");
  assert.ok(html.includes("28.07 — 03.08.2026"), "the range reads like a document, not a log");
  assert.ok(html.includes("Mon") && html.includes("Пн"), "day rows carry both languages");
  assert.ok(html.includes('id="lang-uk"'), "the language switcher is present");
  assert.ok(!html.includes("?days="), "the file snapshot carries no period links");
  assert.ok(!html.includes("<script"), "no scripts in a self-contained report");
  assert.ok(html.includes("Agent Active"), "the primary metric is named honestly");
  assert.ok(html.includes("Claude Code") && html.includes("Codex"), "the agent breakdown is visible");
  const live = htmlReport({ range: "2026-08-03", wallMinutes: 60, turnMinutes: 60, turns: 1, byProject: {} }, 7);
  assert.ok(live.includes('href="?days=30"'), "the served page links between periods");
  assert.ok(live.includes('href="?days=7" class="here"'), "the current period is marked");
});

test("same-named repositories get shortest unique labels", () => {
  const first = path.join(path.sep, "clients", "alpha", "app");
  const second = path.join(path.sep, "clients", "beta", "app");
  const labels = projectLabels([first, second, path.join(path.sep, "work", "api")]);
  assert.equal(labels.get(first), "alpha/app");
  assert.equal(labels.get(second), "beta/app");
  assert.equal(labels.get(path.join(path.sep, "work", "api")), "api");
});

test("the hour grid buckets a turn into its calendar hours", () => {
  const events = [prompt("a", 2026, 7, 3, 10, 30), stop("a", 2026, 7, 3, 12, 15)];
  const grid = Object.fromEntries(hourGrid(events, ["2026-08-03"]));
  const row = grid["2026-08-03"];
  assert.equal(row[10], 30, "the first partial hour");
  assert.equal(row[11], 60, "the full hour in the middle");
  assert.equal(row[12], 15, "the last partial hour");
  assert.equal(row.reduce((sum, value) => sum + value, 0), 105);
});

test("report totals and hour grid agree across the 05:00 work-day boundary", () => {
  const events = [prompt("a", 2026, 7, 3, 4, 30), stop("a", 2026, 7, 3, 5, 30)];
  const previous = workDay(new Date(2026, 7, 3, 4, 30).getTime());
  const current = workDay(new Date(2026, 7, 3, 5, 30).getTime());
  assert.notEqual(previous, current);

  for (const day of [previous, current]) {
    const report = buildReport(events, [day]);
    const grid = Object.fromEntries(hourGrid(events, [day]))[day];
    assert.equal(report.wallMinutes, 30);
    assert.equal(report.turnMinutes, 30);
    assert.equal(report.turns, 1);
    assert.equal(grid.reduce((sum, value) => sum + value, 0), report.wallMinutes);
  }

  const combined = buildReport(events, [previous, current]);
  assert.equal(combined.wallMinutes, 60);
  assert.equal(combined.turnMinutes, 60);
  assert.equal(combined.turns, 1, "one logical turn stays one turn across report days");
});

test("a Windows path survives the settings.json round trip", () => {
  const target = "C:\\Users\\Ivan\\agent-hours\\hours.mjs";
  const written = JSON.stringify(hookConfig(target), null, 2);
  const command = JSON.parse(written).hooks.Stop[0].hooks[0].command;
  assert.equal(command, `node "${target}" hook claude`);
  assert.ok(!command.includes("\\\\"), "backslashes must not be escaped twice");
  const status = JSON.parse(JSON.stringify(statuslineConfig(target))).statusLine.command;
  assert.equal(status, `node "${target}" statusline`);
  const codex = JSON.parse(JSON.stringify(codexHookConfig(target))).hooks.Stop[0].hooks[0].command;
  assert.equal(codex, `node "${target}" hook codex`);
});

test("hook config includes all four lifecycle events", () => {
  assert.deepEqual(Object.keys(hookConfig("/work/hours.mjs").hooks), [
    "UserPromptSubmit",
    "Stop",
    "StopFailure",
    "SessionEnd",
  ]);
});

test("Codex hook config uses its three documented lifecycle events", () => {
  assert.deepEqual(Object.keys(codexHookConfig("/work/hours.mjs").hooks), [
    "UserPromptSubmit",
    "Stop",
    "SessionEnd",
  ]);
});

test("install plan preserves other hooks and is idempotent", () => {
  const target = "/work/hours.mjs";
  const other = { hooks: [{ type: "command", command: "other-tool" }] };
  const settings = { hooks: { Stop: [other] }, theme: "dark" };
  const first = installPlan(settings, target);
  assert.deepEqual(first.missing, ["UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"]);
  assert.equal(settings.hooks.Stop[0], other, "inspection never mutates unrelated config");
  const installed = { ...settings, hooks: { ...settings.hooks } };
  for (const [event, entries] of Object.entries(first.config.hooks)) {
    installed.hooks[event] = [...(installed.hooks[event] ?? []), ...entries];
  }
  assert.deepEqual(installPlan(installed, target).missing, []);
  assert.equal(installed.theme, "dark");
});

test("install plan upgrades v1.0.0 with only StopFailure", () => {
  const target = "/work/hours.mjs";
  const full = hookConfig(target);
  delete full.hooks.StopFailure;
  const plan = installPlan(full, target);
  assert.deepEqual(plan.missing, ["StopFailure"]);
  assert.deepEqual(Object.keys(plan.config.hooks), ["StopFailure"]);
});

test("install plan reports exact duplicate hooks", () => {
  const target = "/work/hours.mjs";
  const settings = hookConfig(target);
  settings.hooks.Stop.push(...hookConfig(target).hooks.Stop);
  assert.deepEqual(installPlan(settings, target).duplicates, [{ event: "Stop", count: 2 }]);
  assert.throws(() => installPlan({ hooks: { Stop: {} } }, target), /must be an array/);
});

test("Codex install plan is idempotent across hooks.json and inline TOML", () => {
  const target = "/work/hours.mjs";
  const clean = codexInstallPlan({}, "", target);
  assert.deepEqual(clean.missing, ["UserPromptSubmit", "Stop", "SessionEnd"]);
  assert.deepEqual(codexInstallPlan(clean.config, "", target).missing, []);

  const stopToml = codexTomlConfig(["Stop"], target);
  const mixed = codexInstallPlan({}, stopToml, target, true);
  assert.deepEqual(mixed.missing, ["UserPromptSubmit", "SessionEnd"]);
  assert.equal(mixed.format, "toml");
  assert.ok(!mixed.config.includes("[[hooks.Stop]]"));

  const duplicate = codexInstallPlan(codexHookConfig(target), stopToml, target);
  assert.deepEqual(duplicate.duplicates, [{ event: "Stop", count: 2 }]);
  const disabled = codexInstallPlan({}, "[features]\nhooks = false\n", target);
  assert.equal(disabled.hooksDisabled, true);
});

test("install command refuses malformed settings", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hours-install-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{broken", "utf8");
  const result = spawnSync(process.execPath, [script, "install"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not parse/);
  assert.equal(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"), "{broken");
});

test("install inspects both agents without creating config files", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hours-install-clean-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [script, "install"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude Code — inspecting/);
  assert.match(result.stdout, /Codex — inspecting/);
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
  assert.equal(fs.existsSync(path.join(home, ".codex")), false);
});

test("Codex install refuses malformed hooks.json", (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hours-codex-install-"));
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codex = path.join(home, ".codex");
  fs.mkdirSync(codex);
  const hooks = path.join(codex, "hooks.json");
  fs.writeFileSync(hooks, "{broken", "utf8");
  const result = spawnSync(process.execPath, [script, "install", "codex"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codex },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not parse/);
  assert.equal(fs.readFileSync(hooks, "utf8"), "{broken");
});

test("Codex live capture stores the logical turn id and ignores unsupported events", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hours-codex-live-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, "hours.jsonl");
  const env = { ...process.env, AGENT_HOURS_FILE: log };
  const run = (event) =>
    spawnSync(process.execPath, [script, "hook", "codex"], {
      encoding: "utf8",
      env,
      input: JSON.stringify({
        hook_event_name: event,
        session_id: "codex-session",
        turn_id: "codex-turn",
        cwd: root,
      }),
    });
  assert.equal(run("UserPromptSubmit").status, 0);
  assert.equal(run("StopFailure").status, 0);
  assert.equal(run("Stop").status, 0);
  const rows = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map((row) => row.event), ["UserPromptSubmit", "Stop"]);
  assert.ok(rows.every((row) => row.source === "codex" && row.turnId === "codex-turn"));
});

test("backfill combines Claude and Codex and refuses an unknown Codex format", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hours-dual-backfill-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claude = path.join(root, "claude");
  const codex = path.join(root, "codex");
  const log = path.join(root, "hours.jsonl");
  fs.mkdirSync(claude);
  fs.mkdirSync(codex);
  fs.writeFileSync(
    path.join(claude, "claude-session.jsonl"),
    [
      { type: "user", timestamp: "2026-08-03T10:00:00Z", cwd: "/work", message: { content: "private" } },
      { type: "assistant", timestamp: "2026-08-03T10:05:00Z", message: { content: "private" } },
    ].map(JSON.stringify).join("\n"),
    "utf8",
  );
  const codexFile = path.join(codex, "rollout-codex-session.jsonl");
  fs.writeFileSync(
    codexFile,
    [
      { timestamp: "2026-08-03T11:00:00Z", type: "session_meta", payload: { id: "codex-session", cwd: "/work", source: "cli" } },
      { timestamp: "2026-08-03T11:01:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "codex-turn" } },
      { timestamp: "2026-08-03T11:06:00Z", type: "event_msg", payload: { type: "task_complete", turn_id: "codex-turn" } },
    ].map(JSON.stringify).join("\n"),
    "utf8",
  );
  const env = {
    ...process.env,
    AGENT_HOURS_FILE: log,
    AGENT_HOURS_CLAUDE_TRANSCRIPTS: claude,
    AGENT_HOURS_CODEX_TRANSCRIPTS: codex,
  };
  const first = spawnSync(process.execPath, [script, "backfill"], { encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /claude 1, codex 1/);
  const backfilled = path.join(root, "hours.backfill.jsonl");
  const original = fs.readFileSync(backfilled, "utf8");
  const rows = original.trim().split("\n").map(JSON.parse);
  assert.deepEqual(new Set(rows.map((row) => row.source)), new Set(["claude", "codex"]));
  assert.ok(rows.every((row) => !JSON.stringify(row).includes("private")));
  const report = spawnSync(process.execPath, [script, "report", "2026-08-03", "--json"], {
    encoding: "utf8",
    env,
  });
  assert.equal(report.status, 0, report.stderr);
  assert.deepEqual(JSON.parse(report.stdout).bySource, { claude: 5, codex: 5 });

  fs.rmSync(path.join(claude, "claude-session.jsonl"));
  fs.writeFileSync(codexFile, JSON.stringify({ timestamp: "2026-08-03T12:00:00Z", type: "new_format" }), "utf8");
  const failed = spawnSync(process.execPath, [script, "backfill"], { encoding: "utf8", env });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /0 turns.*codex transcripts/);
  assert.equal(fs.readFileSync(backfilled, "utf8"), original);
});

test("backfill tolerates a freshly created Codex session with no turns yet", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hours-fresh-codex-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codex = path.join(root, "codex");
  const log = path.join(root, "hours.jsonl");
  fs.mkdirSync(codex);
  fs.writeFileSync(
    path.join(codex, "rollout-fresh-session.jsonl"),
    JSON.stringify({
      timestamp: "2026-08-03T11:00:00Z",
      type: "session_meta",
      payload: { id: "fresh-session", cwd: "/work", source: "cli" },
    }),
    "utf8",
  );
  const env = {
    ...process.env,
    AGENT_HOURS_FILE: log,
    AGENT_HOURS_TRANSCRIPTS: path.join(root, "missing-claude"),
    AGENT_HOURS_CODEX_TRANSCRIPTS: codex,
  };
  const result = spawnSync(process.execPath, [script, "backfill"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex 0/);
});

test("backfill is private, preserves pruned history, and refuses an empty parse", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hours-backfill-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcripts = path.join(root, "transcripts");
  const log = path.join(root, "hours.jsonl");
  const backfilled = path.join(root, "hours.backfill.jsonl");
  fs.mkdirSync(transcripts);
  const file = path.join(transcripts, "session-a.jsonl");
  fs.writeFileSync(
    file,
    [
      { type: "user", timestamp: "2026-08-03T10:00:00Z", cwd: "/work", message: { content: "hi" } },
      { type: "assistant", timestamp: "2026-08-03T10:05:00Z" },
    ].map(JSON.stringify).join("\n"),
    "utf8",
  );
  const env = {
    ...process.env,
    AGENT_HOURS_FILE: log,
    AGENT_HOURS_TRANSCRIPTS: transcripts,
    AGENT_HOURS_CODEX_TRANSCRIPTS: path.join(root, "missing-codex"),
  };
  const first = spawnSync(process.execPath, [script, "backfill"], { encoding: "utf8", env });
  assert.equal(first.status, 0, first.stderr);
  const original = fs.readFileSync(backfilled, "utf8");
  assert.match(original, /"turnId"/);
  if (process.platform !== "win32") assert.equal(fs.statSync(backfilled).mode & 0o777, 0o600);

  fs.rmSync(file);
  const pruned = spawnSync(process.execPath, [script, "backfill"], { encoding: "utf8", env });
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.equal(fs.readFileSync(backfilled, "utf8"), original);

  fs.writeFileSync(
    path.join(transcripts, "unreadable-format.jsonl"),
    JSON.stringify({ type: "user", timestamp: "2026-08-03T11:00:00Z", message: { content: "no reply" } }),
    "utf8",
  );
  const empty = spawnSync(process.execPath, [script, "backfill"], { encoding: "utf8", env });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /Recovered 0 turns/);
  assert.equal(fs.readFileSync(backfilled, "utf8"), original);
});

test("live capture and HTML snapshots use private files and tolerate corrupt JSONL", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hours-private-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, "hours.jsonl");
  const env = {
    ...process.env,
    AGENT_HOURS_FILE: log,
    AGENT_HOURS_TRANSCRIPTS: path.join(root, "missing-transcripts"),
    AGENT_HOURS_CODEX_TRANSCRIPTS: path.join(root, "missing-codex"),
    AGENT_HOURS_NO_OPEN: "1",
  };
  const hook = (event) =>
    spawnSync(process.execPath, [script, "hook", "claude"], {
      encoding: "utf8",
      env,
      input: JSON.stringify({ hook_event_name: event, session_id: "private", cwd: root }),
    });
  assert.equal(hook("UserPromptSubmit").status, 0);
  assert.equal(hook("Stop").status, 0);
  fs.appendFileSync(log, "{corrupt\n", "utf8");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(log).mode & 0o777, 0o600);
    // Simulate a pre-v1.0.1 log and make sure a read tightens it again.
    fs.chmodSync(log, 0o644);
  }

  const json = spawnSync(process.execPath, [script, "report", "--json"], { encoding: "utf8", env });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).turns, 1);
  if (process.platform !== "win32") assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  const terminal = spawnSync(process.execPath, [script, "report"], { encoding: "utf8", env });
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.match(terminal.stdout, /AGENT ACTIVE at least one turn running/);

  const html = spawnSync(process.execPath, [script, "report", "--html"], { encoding: "utf8", env });
  assert.equal(html.status, 0, html.stderr);
  const file = html.stdout.split(/\r?\n/)[0];
  assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(file, "utf8"), /Agent Active/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("a failed atomic replace leaves the original target intact", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hours-atomic-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "marker"), "original", "utf8");
  assert.throws(() => atomicWritePrivate(target, "replacement"));
  assert.equal(fs.readFileSync(path.join(target, "marker"), "utf8"), "original");
  assert.deepEqual(fs.readdirSync(root), ["target"]);
});
