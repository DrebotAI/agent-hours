#!/usr/bin/env node

/**
 * agent-hours — how much time your AI coding sessions actually take.
 *
 * Two hooks write metadata-only events to a JSONL file. Prompts, responses,
 * tool arguments, file contents and transcripts are never read or stored.
 * See DECISIONS.md for why each rule below exists.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const logPath = process.env.AGENT_HOURS_FILE || path.join(os.homedir(), ".agent-hours.jsonl");
const backfillPath = `${logPath.replace(/\.jsonl$/, "")}.backfill.jsonl`;
const transcriptRoot = process.env.AGENT_HOURS_TRANSCRIPTS || path.join(os.homedir(), ".claude", "projects");

const TURN_EVENTS = ["UserPromptSubmit", "Stop"];
const MAX_OPEN_TURN_MS = 4 * 60 * 60 * 1000;
const DAY_START_HOUR = Number(process.env.AGENT_HOURS_DAY_START ?? 5);

// --- capture -------------------------------------------------------------

async function capture(source) {
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw || "{}");
    const event = input.hook_event_name ?? input.hookEventName;
    if (!TURN_EVENTS.includes(event)) return;
    const row = {
      at: new Date().toISOString(),
      source,
      event,
      sessionId: String(input.session_id ?? input.sessionId ?? ""),
      cwd: typeof input.cwd === "string" ? input.cwd : "",
    };
    fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`, "utf8");
  } catch (error) {
    // Telemetry must never break the session it is measuring.
    if (process.env.AGENT_HOURS_DEBUG === "1") {
      process.stderr.write(`agent-hours: ${error.message}\n`);
    }
  }
}

// --- backfill ------------------------------------------------------------

/**
 * Claude Code already keeps timestamped transcripts on disk, so history is
 * available before the hooks have ever run. Only timestamps, roles and cwd are
 * read — message content is used solely to tell a real prompt from a tool
 * result, and is never stored.
 */
function transcriptTurns(text) {
  const out = [];
  let open = null;
  let lastReply = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry.timestamp) continue;
    if (entry.type === "user") {
      const content = entry.message?.content;
      const isToolResult = Array.isArray(content) && content.some((part) => part.type === "tool_result");
      if (isToolResult || entry.isMeta || entry.isCompactSummary) continue;
      if (open && lastReply) out.push({ ...open, stop: lastReply });
      open = { start: entry.timestamp, cwd: entry.cwd || "" };
      lastReply = null;
    } else if (entry.type === "assistant" && open) {
      lastReply = entry.timestamp;
    }
  }
  if (open && lastReply) out.push({ ...open, stop: lastReply });
  return out;
}

function backfill() {
  if (!fs.existsSync(transcriptRoot)) {
    process.stderr.write(`No transcripts at ${transcriptRoot}\n`);
    process.exitCode = 1;
    return;
  }
  const rows = [];
  let files = 0;
  let names;
  try {
    names = fs.readdirSync(transcriptRoot, { recursive: true });
  } catch (error) {
    // Recursive readdir landed in Node 18.17 / 20.1 — the likeliest reason to
    // fail here is an old runtime, and a bare stack trace loses the user.
    process.stderr.write(`Could not read ${transcriptRoot}: ${error.message}\n`);
    process.stderr.write(`agent-hours needs Node 20.1 or newer; you have ${process.version}.\n`);
    process.exitCode = 1;
    return;
  }
  for (const name of names) {
    if (!String(name).endsWith(".jsonl")) continue;
    const file = path.join(transcriptRoot, String(name));
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    files++;
    const sessionId = path.basename(String(name), ".jsonl");
    for (const turn of transcriptTurns(text)) {
      const base = { source: "claude", sessionId, cwd: turn.cwd };
      rows.push({ at: turn.start, event: "UserPromptSubmit", ...base });
      rows.push({ at: turn.stop, event: "Stop", ...base });
    }
  }
  // Rewritten in full every run, so re-running can never double-count.
  fs.writeFileSync(backfillPath, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "utf8");
  process.stdout.write(`Recovered ${rows.length / 2} turns from ${files} transcripts.\n`);
}

// --- turns ---------------------------------------------------------------

function addTurn(list, startEvent, stop) {
  const start = Date.parse(startEvent.at);
  if (stop > start) {
    list.push({ start, stop, source: startEvent.source, cwd: startEvent.cwd || "" });
  }
}

/** Pair UserPromptSubmit with the next Stop of the same session. */
function turns(events, now = Date.now()) {
  const pending = new Map();
  const list = [];
  const ordered = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const event of ordered) {
    const key = `${event.source}:${event.sessionId}`;
    if (event.event === "UserPromptSubmit") {
      const queue = pending.get(key) ?? [];
      queue.push(event);
      pending.set(key, queue);
    } else if (event.event === "Stop") {
      const startEvent = pending.get(key)?.shift();
      if (startEvent) addTurn(list, startEvent, Date.parse(event.at));
    }
  }
  // A turn with no Stop means the session was killed. Cap it instead of
  // billing until the end of time.
  for (const queue of pending.values()) {
    for (const event of queue) {
      addTurn(list, event, Math.min(now, Date.parse(event.at) + MAX_OPEN_TURN_MS));
    }
  }
  return list;
}

/** Collapse overlapping intervals — two parallel sessions are not double time. */
function merge(intervals) {
  const merged = [];
  for (const item of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (!last || item.start > last.stop) merged.push({ start: item.start, stop: item.stop });
    else last.stop = Math.max(last.stop, item.stop);
  }
  return merged;
}

function minutes(intervals) {
  return Math.round(intervals.reduce((sum, item) => sum + item.stop - item.start, 0) / 60000);
}

// --- days ----------------------------------------------------------------

function stamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Work past midnight belongs to the day it started. */
function workDay(ms) {
  return stamp(new Date(ms - DAY_START_HOUR * 60 * 60 * 1000));
}

function dateRange(end, days) {
  const [year, month, day] = end.split("-").map(Number);
  const out = [];
  for (let back = days - 1; back >= 0; back--) out.push(stamp(new Date(year, month - 1, day - back)));
  return out;
}

// --- report --------------------------------------------------------------

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return Number.isFinite(Date.parse(event.at)) ? [event] : [];
      } catch {
        return [];
      }
    });
}

/** Live hook events win; backfilled sessions only fill the gaps before them. */
function readEvents() {
  const live = readJsonl(logPath);
  const known = new Set(live.map((event) => event.sessionId));
  return [...live, ...readJsonl(backfillPath).filter((event) => !known.has(event.sessionId))];
}

const projectNames = new Map();

/** A session started in src/ still belongs to the repo, so walk up to the git root. */
function projectName(cwd) {
  if (!cwd) return "(unknown)";
  if (!projectNames.has(cwd)) {
    let dir = cwd;
    while (!fs.existsSync(path.join(dir, ".git"))) {
      const parent = path.dirname(dir);
      if (parent === dir) {
        dir = cwd;
        break;
      }
      dir = parent;
    }
    projectNames.set(cwd, path.basename(dir) || "(unknown)");
  }
  return projectNames.get(cwd);
}

function buildReport(events, dates, now = Date.now()) {
  const wanted = new Set(dates);
  const day = turns(events, now).filter((turn) => wanted.has(workDay(turn.start)));
  const byProject = new Map();
  for (const turn of day) {
    const name = projectName(turn.cwd);
    byProject.set(name, [...(byProject.get(name) ?? []), turn]);
  }
  return {
    range: dates.length === 1 ? dates[0] : `${dates[0]}..${dates.at(-1)}`,
    wallMinutes: minutes(merge(day)),
    turnMinutes: minutes(day),
    turns: day.length,
    byProject: Object.fromEntries(
      [...byProject]
        .map(([name, list]) => [name, minutes(merge(list))])
        .sort((a, b) => b[1] - a[1]),
    ),
  };
}

function formatHours(value) {
  const safe = Math.max(0, Math.round(value));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function printReport(report, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const width = Math.max(12, ...Object.keys(report.byProject).map((name) => name.length + 2));
  const pad = (text) => text.padEnd(width);
  process.stdout.write(
    [
      `agent-hours · ${report.range}`,
      "",
      `  ${pad("wall clock")}${formatHours(report.wallMinutes)}   at least one session working`,
      `  ${pad("turn time")}${formatHours(report.turnMinutes)}   every turn summed`,
      `  ${pad("turns")}${report.turns}`,
      ...(report.turns
        ? ["", ...Object.entries(report.byProject).map(([n, m]) => `  ${pad(n)}${formatHours(m)}`)]
        : ["", "  No turns recorded yet. Did you install the hooks?"]),
      "",
    ].join("\n"),
  );
}

// --- install -------------------------------------------------------------

/**
 * Quote the path for the shell with plain quotes, never JSON.stringify — the
 * surrounding settings.json encoding escapes backslashes itself, and doing it
 * twice turns a Windows path into C:\\Users\\... that cmd cannot resolve.
 */
function hookConfig(target = scriptPath) {
  const hook = [
    { hooks: [{ type: "command", command: `node "${target}" hook claude`, timeout: 3 }] },
  ];
  return { hooks: { UserPromptSubmit: hook, Stop: hook } };
}

function printInstall() {
  const settings = path.join(os.homedir(), ".claude", "settings.json");
  const exists = fs.existsSync(settings);
  process.stdout.write(
    [
      `Add this to ${settings}`,
      exists
        ? "(merge it into the existing object — keep any hooks already there):"
        : "(that file does not exist yet — create it with exactly this content):",
      "",
      JSON.stringify(hookConfig(), null, 2),
      "",
      "Then restart Claude Code and run:  node hours.mjs report",
      "",
    ].join("\n"),
  );
}

// --- cli -----------------------------------------------------------------

function reportArgs(args) {
  let date = null;
  let days = 1;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--days") days = Math.max(1, Number.parseInt(args[++index], 10) || 1);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(args[index])) date = args[index];
  }
  return { date: date ?? workDay(Date.now()), days };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "hook") return capture(args[0] === "codex" ? "codex" : "claude");
  if (command === "install") return printInstall();
  if (command === "backfill") return backfill();
  if (command === "report") {
    const { date, days } = reportArgs(args);
    return printReport(buildReport(readEvents(), dateRange(date, days)), args.includes("--json"));
  }
  process.stderr.write(
    [
      "agent-hours — how much time your AI coding sessions actually take",
      "",
      "  node hours.mjs backfill                read history from past transcripts",
      "  node hours.mjs install                 print the hook config to paste",
      "  node hours.mjs report [YYYY-MM-DD]     one day (default: today)",
      "  node hours.mjs report --days 7         last 7 days",
      "  node hours.mjs report --json           machine-readable",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();

export { turns, merge, minutes, workDay, dateRange, buildReport, transcriptTurns, hookConfig };
