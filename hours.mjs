#!/usr/bin/env node

/**
 * agent-hours — how much time your AI coding sessions actually take.
 *
 * Two hooks write metadata-only events to a JSONL file. Prompts, responses,
 * tool arguments, file contents and transcripts are never read or stored.
 * See DECISIONS.md for why each rule below exists.
 */

import { execFile } from "node:child_process";
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
    // A session run from ~ with no repo would surface the user's login as a
    // "project" — that reads as a bug on every screenshot.
    projectNames.set(cwd, dir === os.homedir() ? "(home)" : path.basename(dir) || "(unknown)");
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

// Datasheet, not dashboard: one accent (brass, on the billable number), labels
// recede, numbers stay bright, bars live inside the table. Pad first, paint
// second — ANSI codes would break padEnd arithmetic.
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (tty ? `\u001b[38;5;${code}m${text}\u001b[0m` : text);
const brass = paint(179);
const bone = paint(253);
const dim = paint(242);
const dark = paint(94);

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

function bar(value, max, cells) {
  const units = Math.round((value / Math.max(max, 1)) * cells * 8);
  return "█".repeat(Math.floor(units / 8)) + EIGHTHS[units % 8];
}

function printReport(report, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const projects = Object.entries(report.byProject);
  const nameWidth = Math.max(12, ...projects.map(([name]) => name.length));
  const width = nameWidth + 36;
  const rule = `  ${dim("─".repeat(width - 2))}`;
  const stat = (label, note, value, ink) =>
    `  ${dim(label.padEnd(12))}${dim(note.padEnd(width - 20))}${ink(String(value).padStart(6))}`;
  const max = Math.max(1, ...projects.map(([, mins]) => mins));
  const row = ([name, mins]) =>
    `  ${bone(name.padEnd(nameWidth + 2))}${dark(bar(mins, max, 24).padEnd(26))}${bone(formatHours(mins).padStart(6))}`;
  process.stdout.write(
    [
      `  ${bone("agent-hours")}${dim(report.range.padStart(width - 13))}`,
      rule,
      stat("WALL CLOCK", "at least one session working", formatHours(report.wallMinutes), brass),
      stat("TURN TIME", `every turn summed${ratio(report)}`, formatHours(report.turnMinutes), bone),
      stat("TURNS", "", report.turns, bone),
      rule,
      ...(report.turns ? projects.map(row) : [`  ${dim(emptyHint())}`]),
      rule,
      `  ${dim("no dependencies · nothing leaves your machine")}`,
      "",
    ].join("\n"),
  );
}

/** turn/wall — how many of you were effectively working in parallel. */
function ratio(report) {
  if (!report.wallMinutes) return "";
  return ` · ×${(report.turnMinutes / report.wallMinutes).toFixed(2)}`;
}

/** The likeliest reason for an empty report is a missed backfill, not hooks. */
function emptyHint() {
  if (!fs.existsSync(backfillPath) && fs.existsSync(transcriptRoot)) {
    return "No turns yet — run `node hours.mjs backfill` to import your history.";
  }
  return "No turns recorded yet. Did you install the hooks?";
}

// --- statusline ----------------------------------------------------------

/**
 * One line for the Claude Code status bar: today's wall clock, always in
 * sight, no command to remember. Must never break the UI it lives in.
 */
function statusline() {
  try {
    const report = buildReport(readEvents(), [workDay(Date.now())]);
    process.stdout.write(`⏱ ${formatHours(report.wallMinutes)} today`);
  } catch {
    process.stdout.write("⏱ agent-hours");
  }
}

// --- html ----------------------------------------------------------------

/**
 * The pitch is "hours you could put on an invoice", so the shareable report
 * *is* the invoice: warm paper, serif labels, mono numbers, dot leaders, one
 * red-oxide rule under the total. Self-contained file, no JS, no requests.
 */
const escapeHtml = (text) =>
  String(text).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const docDate = (day) => day.split("-").reverse().join(".");

/** 2026-07-28..2026-08-03 is log syntax; a document says 28.07 — 03.08.2026. */
const docRange = (range) => {
  const [from, to] = range.split("..");
  return to ? `${docDate(from).slice(0, 5)} — ${docDate(to)}` : docDate(from);
};

function htmlReport(report) {
  const line = (label, value, dimmed = false) =>
    `<div class="row"><span>${label}</span><span class="leader"></span><span class="mono${dimmed ? " zero" : ""}">${value}</span></div>`;
  const days = (report.byDay ?? [])
    .map(([day, mins]) => {
      const [year, month, date] = day.split("-").map(Number);
      const label = `${WEEKDAYS[new Date(year, month - 1, date).getDay()]} ${docDate(day).slice(0, 5)}`;
      return line(label, mins ? formatHours(mins) : "—", !mins);
    })
    .join("\n      ");
  const rows = Object.entries(report.byProject)
    .map(([name, mins]) => line(escapeHtml(name), formatHours(mins)))
    .join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-hours · ${escapeHtml(report.range)}</title>
<style>
  :root { --paper: #ede8de; --ink: #17150f; --oxide: #a6371f; --dim: #b4ac9b; --half: #57503f; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--paper); color: var(--ink);
    font-family: "Iowan Old Style", Charter, ui-serif, Georgia, Cambria, "Times New Roman", serif;
    display: flex; justify-content: center; padding: 64px 32px;
  }
  main { width: 100%; max-width: 600px; }
  .mono { font-family: ui-monospace, Menlo, "Andale Mono", "Cascadia Mono", Consolas, monospace; font-variant-numeric: tabular-nums; }
  header {
    display: flex; justify-content: space-between; align-items: baseline;
    border-top: 2px solid var(--ink); padding-top: 12px; margin-bottom: 24px;
  }
  .brand { font-variant-caps: small-caps; letter-spacing: 0.2em; font-size: 16px; }
  header .mono { font-size: 13px; }
  .sec-label {
    font-variant-caps: small-caps; letter-spacing: 0.22em; font-size: 12px; color: var(--half);
    border-bottom: 1px solid var(--dim); padding-bottom: 4px; margin: 32px 0 6px;
  }
  .row { display: flex; align-items: baseline; gap: 12px; padding: 6px 0; font-size: 16px; }
  .row .mono { font-size: 14px; }
  .leader { flex: 1; border-bottom: 1px dotted var(--dim); transform: translateY(-4px); }
  .zero { color: var(--dim); }
  .secondary { margin-top: 36px; border-top: 1px solid var(--dim); padding-top: 10px; color: var(--half); }
  .secondary .row { padding: 3px 0; font-size: 13px; }
  .secondary .row .mono { font-size: 12px; }
  .secondary .leader { border-bottom-color: transparent; }
  .total { margin-top: 64px; text-align: right; }
  .total-label { font-variant-caps: small-caps; letter-spacing: 0.24em; font-size: 14px; margin-bottom: 10px; }
  .total .mono { font-size: clamp(64px, 15vw, 108px); line-height: 1; display: inline-block; border-bottom: 3px solid var(--oxide); padding-bottom: 12px; }
  footer { margin-top: 64px; font-size: 11px; color: var(--dim); letter-spacing: 0.04em; }
</style>
</head>
<body>
  <main>
    <header><span class="brand">Agent Hours</span><span class="mono">${escapeHtml(docRange(report.range))}</span></header>
    ${days ? `<div class="sec-label">Days</div>\n    <section>\n      ${days}\n    </section>` : ""}
    <div class="sec-label">Projects</div>
    <section>
      ${rows || line("no sessions recorded", "—", true)}
    </section>
    <div class="secondary">
      ${line("Turn time", formatHours(report.turnMinutes))}
      ${line("Turns", report.turns)}
      ${report.wallMinutes ? line("Parallelism", `×${(report.turnMinutes / report.wallMinutes).toFixed(2)}`) : ""}
    </div>
    <div class="total">
      <div class="total-label">Wall Clock</div>
      <div class="mono">${formatHours(report.wallMinutes)}</div>
    </div>
    <footer class="mono">metadata only · nothing leaves your machine · agent-hours</footer>
  </main>
</body>
</html>
`;
}

function writeHtml(report) {
  const file = path.join(os.tmpdir(), "agent-hours-report.html");
  fs.writeFileSync(file, htmlReport(report), "utf8");
  const [opener, openerArgs] =
    { darwin: ["open", [file]], win32: ["cmd", ["/c", "start", "", file]] }[process.platform] ??
    ["xdg-open", [file]];
  execFile(opener, openerArgs, () => {});
  process.stdout.write(`${file}\n`);
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

function statuslineConfig(target = scriptPath) {
  return { statusLine: { type: "command", command: `node "${target}" statusline` } };
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
      "Optional — today's hours always visible in the Claude Code status bar.",
      "Only add this if you do not already have a statusLine set up:",
      "",
      JSON.stringify(statuslineConfig(), null, 2),
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
  if (command === "statusline") return statusline();
  if (command === "report") {
    const { date, days } = reportArgs(args);
    const events = readEvents();
    const dates = dateRange(date, days);
    const report = buildReport(events, dates);
    if (args.includes("--html")) {
      report.byDay = dates.map((day) => [day, buildReport(events, [day]).wallMinutes]);
      return writeHtml(report);
    }
    return printReport(report, args.includes("--json"));
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
      "  node hours.mjs report --html           paper timesheet, opens in the browser",
      "  node hours.mjs statusline              one line for the Claude Code status bar",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();

export { turns, merge, minutes, workDay, dateRange, buildReport, transcriptTurns, hookConfig, statuslineConfig, bar, htmlReport };
