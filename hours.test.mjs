import assert from "node:assert/strict";
import test from "node:test";

import { dateRange, hookConfig, merge, minutes, transcriptTurns, turns, workDay } from "./hours.mjs";

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

test("a Windows path survives the settings.json round trip", () => {
  const target = "C:\\Users\\Ivan\\agent-hours\\hours.mjs";
  const written = JSON.stringify(hookConfig(target), null, 2);
  const command = JSON.parse(written).hooks.Stop[0].hooks[0].command;
  assert.equal(command, `node "${target}" hook claude`);
  assert.ok(!command.includes("\\\\"), "backslashes must not be escaped twice");
});
