import assert from "node:assert/strict";
import test from "node:test";

import { bar, dateRange, hookConfig, htmlReport, merge, minutes, transcriptTurns, turns, workDay } from "./hours.mjs";

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

test("work before the 05:00 cutoff belongs to the previous day", () => {
  assert.equal(workDay(new Date(2026, 7, 3, 3, 0).getTime()), "2026-08-02");
  assert.equal(workDay(new Date(2026, 7, 3, 6, 0).getTime()), "2026-08-03");
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
    { start: "2026-08-03T10:00:00Z", cwd: "/work", stop: "2026-08-03T10:05:00Z" },
  ]);
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
    byProject: { "<evil> & co": 60 },
    byDay: [["2026-08-03", 60]],
  });
  assert.ok(html.includes("&lt;evil&gt; &amp; co"), "markup in a project name is escaped");
  assert.ok(!html.includes("<evil>"), "raw markup never reaches the page");
  assert.ok(html.includes("1:00"), "the wall clock total is rendered");
  assert.ok(html.includes("28.07 — 03.08.2026"), "the range reads like a document, not a log");
  assert.ok(html.includes("Mon 03.08"), "each day gets its own timesheet row");
  assert.ok(!html.includes("<script"), "no scripts in a self-contained report");
});

test("a Windows path survives the settings.json round trip", () => {
  const target = "C:\\Users\\Ivan\\agent-hours\\hours.mjs";
  const written = JSON.stringify(hookConfig(target), null, 2);
  const command = JSON.parse(written).hooks.Stop[0].hooks[0].command;
  assert.equal(command, `node "${target}" hook claude`);
  assert.ok(!command.includes("\\\\"), "backslashes must not be escaped twice");
});
