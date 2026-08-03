#!/usr/bin/env node

/**
 * agent-hours — how much time your AI coding sessions actually take.
 *
 * Three hooks write metadata-only events to a JSONL file. Prompts, responses,
 * tool arguments, file contents and transcripts are never read or stored.
 * See DECISIONS.md for why each rule below exists.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const logPath = process.env.AGENT_HOURS_FILE || path.join(os.homedir(), ".agent-hours.jsonl");
const backfillPath = `${logPath.replace(/\.jsonl$/, "")}.backfill.jsonl`;
const transcriptRoot = process.env.AGENT_HOURS_TRANSCRIPTS || path.join(os.homedir(), ".claude", "projects");

const TURN_EVENTS = ["UserPromptSubmit", "Stop", "SessionEnd"];
const MAX_OPEN_TURN_MS = 4 * 60 * 60 * 1000;
const MAX_IDLE_MS = 30 * 60 * 1000;
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
  let lastActivity = null;
  let timeline = [];

  const close = () => {
    if (open) {
      // No reply usually means an interrupt — the work up to the last recorded
      // activity (a tool result, the Esc marker itself) still happened.
      const stop = lastReply ?? lastActivity;
      if (stop && Date.parse(stop) > Date.parse(open.start)) {
        // A dead gap in the timeline is the machine asleep or the user gone,
        // not the agent working. Audited: one slept-through pair held 14.7h.
        let segStart = open.start;
        let prev = open.start;
        for (const at of [...timeline.filter((t) => Date.parse(t) <= Date.parse(stop)), stop]) {
          if (Date.parse(at) - Date.parse(prev) > MAX_IDLE_MS) {
            if (Date.parse(prev) > Date.parse(segStart)) out.push({ start: segStart, cwd: open.cwd, stop: prev });
            segStart = at;
          }
          prev = at;
        }
        if (Date.parse(prev) > Date.parse(segStart)) out.push({ start: segStart, cwd: open.cwd, stop: prev });
      }
    }
    open = null;
    lastReply = null;
    lastActivity = null;
    timeline = [];
  };

  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry.timestamp) continue;
    const content = entry.message?.content;
    const isToolResult = Array.isArray(content) && content.some((part) => part.type === "tool_result");
    const isInterrupt = typeof content === "string" && content.startsWith("[Request interrupted");
    const isPrompt =
      entry.type === "user" && !isToolResult && !isInterrupt && !entry.isMeta && !entry.isCompactSummary;
    if (isPrompt) {
      close();
      open = { start: entry.timestamp, cwd: entry.cwd || "" };
    } else if (open) {
      timeline.push(entry.timestamp);
      lastActivity = entry.timestamp;
      if (entry.type === "assistant") lastReply = entry.timestamp;
    }
  }
  close();
  return out;
}

function backfill(silent = false) {
  if (!fs.existsSync(transcriptRoot)) {
    if (silent) return;
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
    if (silent) return;
    // Recursive readdir landed in Node 18.17 / 20.1 — the likeliest reason to
    // fail here is an old runtime, and a bare stack trace loses the user.
    process.stderr.write(`Could not read ${transcriptRoot}: ${error.message}\n`);
    process.stderr.write(`agent-hours needs Node 20.1 or newer; you have ${process.version}.\n`);
    process.exitCode = 1;
    return;
  }
  for (const name of names) {
    if (!String(name).endsWith(".jsonl")) continue;
    // Subagent transcripts live under <session>/subagents/ and run in the
    // background of a parent turn — machine time, not the user's session.
    if (/[\\/]subagents[\\/]/.test(String(name))) continue;
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
  // Rewritten in full every run, so re-running can never double-count. Claude
  // Code eventually prunes old transcripts, though — sessions recovered on an
  // earlier run must not vanish with them, so the rewrite unions with itself.
  const seen = new Set(rows.map((row) => row.sessionId));
  // ...but never resurrect subagent transcripts skipped above — their files
  // are named agent-<id>.jsonl, so their sessionId carries the prefix.
  const kept = readJsonl(backfillPath).filter(
    (event) => !seen.has(event.sessionId) && !event.sessionId.startsWith("agent-"),
  );
  fs.writeFileSync(
    backfillPath,
    [...rows, ...kept].map((row) => `${JSON.stringify(row)}\n`).join(""),
    "utf8",
  );
  if (silent) return;
  const note = kept.length ? ` (+${kept.length / 2} kept from pruned transcripts)` : "";
  process.stdout.write(`Recovered ${rows.length / 2} turns from ${files} transcripts${note}.\n`);
}

/**
 * Live hook pairs cannot see a sleeping machine inside themselves (decision
 * 13), so report and serve re-read the transcripts whenever the backfill is
 * stale. Nobody should have to remember a maintenance command.
 */
function autoBackfill() {
  try {
    if (Date.now() - fs.statSync(backfillPath).mtimeMs < 15 * 60 * 1000) return;
  } catch {
    // No backfill file yet — first run, build it.
  }
  backfill(true);
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
  const capped = (startEvent, at) =>
    addTurn(list, startEvent, Math.min(at, Date.parse(startEvent.at) + MAX_OPEN_TURN_MS));
  const ordered = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const event of ordered) {
    const key = `${event.source}:${event.sessionId}`;
    if (event.event === "UserPromptSubmit") {
      // Stop never fires on an Esc interrupt, so a pending prompt would pair
      // with the wrong Stop forever after — the next prompt closes it instead.
      const queue = pending.get(key) ?? [];
      for (const startEvent of queue.splice(0)) capped(startEvent, Date.parse(event.at));
      queue.push(event);
      pending.set(key, queue);
    } else if (event.event === "Stop") {
      const startEvent = pending.get(key)?.shift();
      if (startEvent) addTurn(list, startEvent, Date.parse(event.at));
    } else if (event.event === "SessionEnd") {
      // A clean exit closes whatever the session left open, at exit time.
      for (const startEvent of pending.get(key)?.splice(0) ?? []) capped(startEvent, Date.parse(event.at));
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

/**
 * Per session, the freshest source wins. Backfilled turns carry the full
 * activity timeline (idle gaps split out, interrupts recovered), so they beat
 * the live events they overlap; live events newer than the last backfill keep
 * the clock running in real time until the next backfill re-reads them better.
 */
function readEvents() {
  const backfilled = readJsonl(backfillPath);
  const newest = new Map();
  for (const event of backfilled) {
    const at = Date.parse(event.at);
    if (!(newest.get(event.sessionId) >= at)) newest.set(event.sessionId, at);
  }
  const live = readJsonl(logPath).filter(
    (event) => !newest.has(event.sessionId) || Date.parse(event.at) > newest.get(event.sessionId),
  );
  return [...live, ...backfilled];
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

/** Occupancy minutes per hour cell, one row per work day — the timesheet grid. */
function hourGrid(events, dates, now = Date.now()) {
  const grid = new Map(dates.map((day) => [day, Array(24).fill(0)]));
  for (const { start, stop } of merge(turns(events, now))) {
    const first = new Date(start);
    first.setMinutes(0, 0, 0);
    for (let t = first.getTime(); t < stop; t += 3600000) {
      const row = grid.get(workDay(t));
      if (!row) continue;
      row[new Date(t).getHours()] += Math.round(
        (Math.min(stop, t + 3600000) - Math.max(start, t)) / 60000,
      );
    }
  }
  return [...grid];
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
const WEEKDAYS_UK = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const docDate = (day) => day.split("-").reverse().join(".");

/** 2026-07-28..2026-08-03 is log syntax; a document says 28.07 — 03.08.2026. */
const docRange = (range) => {
  const [from, to] = range.split("..");
  return to ? `${docDate(from).slice(0, 5)} — ${docDate(to)}` : docDate(from);
};

function htmlReport(report, liveDays) {
  const line = (label, value, dimmed = false) =>
    `<div class="row"><span>${label}</span><span class="leader"></span><span class="mono${dimmed ? " zero" : ""}">${value}</span></div>`;
  // Both languages ship in the file; a CSS-only radio toggle picks one. No JS.
  const t = (en, uk) => `<span class="en">${en}</span><span class="uk">${uk}</span>`;
  const days = (report.byDay ?? [])
    .map(([day, hours]) => {
      const [year, month, date] = day.split("-").map(Number);
      const weekday = new Date(year, month - 1, date).getDay();
      const label = `${t(WEEKDAYS[weekday], WEEKDAYS_UK[weekday])} ${docDate(day).slice(0, 5)}`;
      const mins = hours.reduce((sum, value) => sum + value, 0);
      const cells = hours
        .map((value) => `<i style="--a:${(0.07 + (value / 60) * 0.83).toFixed(2)}"></i>`)
        .join("");
      return `<div class="dayrow"><span class="dlabel">${label}</span><span class="strip">${cells}</span><span class="mono${mins ? "" : " zero"}">${mins ? formatHours(mins) : "—"}</span></div>`;
    })
    .join("\n      ");
  const scale = days
    ? `\n      <div class="dayrow"><span class="dlabel"></span><span class="strip">${["00", "06", "12", "18"].map((hour) => `<em>${hour}</em>`).join("")}</span><span class="mono"></span></div>`
    : "";
  const rows = Object.entries(report.byProject)
    .map(([name, mins]) => line(escapeHtml(name), formatHours(mins)))
    .join("\n      ");
  // Period links only make sense when a server regenerates on request.
  const nav = liveDays
    ? [["1", t("today", "сьогодні")], ["7", t("7 days", "7 днів")], ["30", t("30 days", "30 днів")], ["90", t("90 days", "90 днів")]]
        .map(([n, label]) => `<a href="?days=${n}"${Number(n) === liveDays ? ' class="here"' : ""}>${label}</a>`)
        .join(" · ")
    : "";
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
    border-top: 2px solid var(--ink); padding-top: 12px; margin-bottom: 6px;
  }
  .brand { font-variant-caps: small-caps; letter-spacing: 0.2em; font-size: 16px; }
  header .mono { font-size: 13px; }
  .tagline { font-size: 14px; color: var(--half); margin-bottom: 28px; }
  .note {
    font-variant-caps: normal; text-transform: none; letter-spacing: 0.02em;
    font-size: 12px; color: var(--dim);
  }
  .caption { font-size: 12.5px; color: var(--half); margin-top: 12px; }
  input[name="lang"] { display: none; }
  .uk { display: none; }
  body:has(#lang-uk:checked) .uk { display: inline; }
  body:has(#lang-uk:checked) .en { display: none; }
  .topbar {
    display: flex; justify-content: space-between; align-items: baseline;
    font-size: 11px; letter-spacing: 0.08em; margin-bottom: 8px;
  }
  .topbar a { color: var(--dim); text-decoration: none; }
  .topbar a.here { color: var(--ink); border-bottom: 1px solid var(--ink); }
  .langs { display: flex; gap: 10px; }
  .langs label { cursor: pointer; color: var(--dim); }
  body:has(#lang-en:checked) label[for="lang-en"],
  body:has(#lang-uk:checked) label[for="lang-uk"] { color: var(--ink); border-bottom: 1px solid var(--ink); }
  .sec-label {
    font-variant-caps: small-caps; letter-spacing: 0.22em; font-size: 12px; color: var(--half);
    border-bottom: 1px solid var(--dim); padding-bottom: 4px; margin: 32px 0 6px;
  }
  .dayrow { display: flex; align-items: center; gap: 10px; padding: 3px 0; font-size: 14px; }
  .dlabel { width: 84px; }
  .dayrow .mono { width: 44px; text-align: right; font-size: 13px; }
  .strip { flex: 1; display: flex; gap: 2px; }
  .strip i { flex: 1; height: 12px; background: var(--ink); opacity: var(--a); }
  .strip em { flex: 6; font-style: normal; font-size: 10px; color: var(--half); letter-spacing: 0.08em; }
  @media print { body { padding: 24px; print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
  .row { display: flex; align-items: baseline; gap: 12px; padding: 6px 0; font-size: 16px; }
  .row .mono { font-size: 14px; }
  .leader { flex: 1; border-bottom: 1px dotted var(--dim); transform: translateY(-4px); }
  .zero { color: var(--dim); }
  .secondary { margin-top: 36px; border-top: 1px solid var(--dim); padding-top: 10px; color: var(--half); }
  .secondary .row { padding: 3px 0; font-size: 13px; }
  .secondary .row .mono { font-size: 12px; }
  .secondary .leader { border-bottom-color: transparent; }
  .method { margin-top: 36px; border-top: 1px solid var(--dim); padding-top: 10px; font-size: 13px; color: var(--half); }
  .method summary {
    cursor: pointer; font-variant-caps: small-caps; letter-spacing: 0.18em;
    font-size: 12px; list-style-position: outside;
  }
  .method p { margin: 8px 0 0; max-width: 54ch; }
  .total { margin: 12px 0 8px; text-align: right; }
  .total-label { font-variant-caps: small-caps; letter-spacing: 0.24em; font-size: 14px; margin-bottom: 10px; }
  .total .mono { font-size: clamp(64px, 15vw, 108px); line-height: 1; display: inline-block; border-bottom: 3px solid var(--oxide); padding-bottom: 12px; }
  footer { margin-top: 64px; font-size: 11px; color: var(--dim); letter-spacing: 0.04em; }
</style>
</head>
<body>
  <input type="radio" name="lang" id="lang-en" checked>
  <input type="radio" name="lang" id="lang-uk">
  <main>
    <div class="topbar"><nav>${nav}</nav><span class="langs"><label for="lang-en">EN</label><label for="lang-uk">UA</label></span></div>
    <header><span class="brand">Agent Hours</span><span class="mono">${escapeHtml(docRange(report.range))}</span></header>
    <p class="tagline">${t(
      "How long your AI coding agent actually worked — by hour, day and project.",
      "Скільки насправді працював твій AI-агент — по годинах, днях і проєктах.",
    )}</p>
    <div class="total">
      <div class="total-label">Wall Clock</div>
      <div class="mono">${formatHours(report.wallMinutes)}</div>
      <div class="caption">${t(
        "hours at least one session was running — parallel sessions counted once",
        "години, коли працювала хоча б одна сесія — паралельні рахуються один раз",
      )}</div>
    </div>
    ${days ? `<div class="sec-label">${t("Days", "Дні")} <span class="note">${t("— one cell per hour of the day, darker = more of it worked", "— одна клітинка = година доби, темніше = більше роботи")}</span></div>\n    <section>\n      ${days}${scale}\n    </section>` : ""}
    <div class="sec-label">${t("Projects", "Проєкти")} <span class="note">${t("— wall clock per project", "— wall clock по кожному проєкту")}</span></div>
    <section>
      ${rows || line(t("no sessions recorded", "сесій не записано"), "—", true)}
    </section>
    <div class="secondary">
      ${line(`Turn time <span class="note">${t("— every answer summed, parallel included", "— всі відповіді в сумі, паралельні включно")}</span>`, formatHours(report.turnMinutes))}
      ${line(`Turns <span class="note">${t("— prompts answered", "— відповідей на промпти")}</span>`, report.turns)}
      ${report.wallMinutes ? line(`Parallelism <span class="note">${t("— sessions running at once, on average", "— скільки сесій працювало одночасно, в середньому")}</span>`, `×${(report.turnMinutes / report.wallMinutes).toFixed(2)}`) : ""}
    </div>
    <details class="method"${liveDays ? "" : " open"}>
      <summary>${t("How is this counted?", "Як це пораховано?")}</summary>
      <p>${t(
        "Three Claude Code hooks record four fields per event — a timestamp, the event name, a session id and the working folder. Prompts, replies and file contents are never read or stored.",
        "Три хуки Claude Code записують чотири поля на подію — час, назву події, id сесії і робочу теку. Промпти, відповіді та вміст файлів не читаються і не зберігаються.",
      )}</p>
      <p>${t(
        "A turn runs from the moment you send a prompt to the moment the agent finishes answering. The pause after a reply — reading, thinking, editing by hand — is not counted, so every number here is a lower bound on your real time.",
        "Turn триває від відправки промпта до моменту, коли агент закінчив відповідати. Пауза після відповіді — читання, обдумування, ручні правки — не рахується, тому кожне число тут — нижня межа твого реального часу.",
      )}</p>
      <p>${t(
        "Wall clock merges overlapping turns, so two parallel sessions in the same hour count as one hour. Turn time sums them all. A silence of 30+ minutes inside a turn — a laptop asleep mid-run — is cut out, and a session killed without a trace is capped at 4 hours. The day starts at 05:00 — night work belongs to the evening it began.",
        "Wall clock зливає перетини: дві паралельні сесії в одну годину — це одна година. Turn time додає все. Тиша понад 30 хвилин усередині turn'а — ноутбук, що заснув посеред роботи — вирізається, а сесія, вбита без сліду, обрізається на 4 годинах. Доба починається о 05:00 — нічна робота належить вечору, з якого почалась.",
      )}</p>
      <p>${t(
        "History from before the install is recovered from the timestamped transcripts Claude Code already keeps on your machine. Every rule and its reasoning: DECISIONS.md in the repository.",
        "Історія до установки відновлена з транскриптів із таймстампами, які Claude Code і так тримає на твоїй машині. Кожне правило з обґрунтуванням — у DECISIONS.md в репозиторії.",
      )}</p>
    </details>
    <footer class="mono">${t("metadata only · nothing leaves your machine", "тільки метадані · нічого не покидає твою машину")} · agent-hours</footer>
  </main>
</body>
</html>
`;
}

function openInBrowser(target) {
  const [opener, openerArgs] =
    { darwin: ["open", [target]], win32: ["cmd", ["/c", "start", "", target]] }[process.platform] ??
    ["xdg-open", [target]];
  execFile(opener, openerArgs, () => {});
}

function writeHtml(report) {
  const file = path.join(os.tmpdir(), "agent-hours-report.html");
  fs.writeFileSync(file, htmlReport(report), "utf8");
  openInBrowser(file);
  process.stdout.write(`${file}\n`);
}

// --- serve ---------------------------------------------------------------

/**
 * The timesheet at a permanent local address: bookmark it, refresh for fresh
 * numbers, switch periods with the links on the page. Binds to loopback only —
 * "nothing leaves your machine" must stay true with the server running.
 */
function serve() {
  const port = Number(process.env.AGENT_HOURS_PORT) || 4747;
  const server = http.createServer((request, response) => {
    autoBackfill();
    const url = new URL(request.url, "http://localhost");
    const days = Math.min(365, Math.max(1, Number.parseInt(url.searchParams.get("days") ?? "", 10) || 7));
    const raw = url.searchParams.get("date") ?? "";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : workDay(Date.now());
    const events = readEvents();
    const dates = dateRange(date, days);
    const report = buildReport(events, dates);
    report.byDay = hourGrid(events, dates);
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(htmlReport(report, days));
  });
  server.listen(port, "127.0.0.1", () => {
    const address = `http://127.0.0.1:${port}`;
    process.stdout.write(`agent-hours · ${address} — refresh for fresh numbers, Ctrl+C to stop\n`);
    openInBrowser(address);
  });
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
  return { hooks: { UserPromptSubmit: hook, Stop: hook, SessionEnd: hook } };
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
  if (command === "serve") return serve();
  if (command === "report") {
    autoBackfill();
    const { date, days } = reportArgs(args);
    const events = readEvents();
    const dates = dateRange(date, days);
    const report = buildReport(events, dates);
    if (args.includes("--html")) {
      report.byDay = hourGrid(events, dates);
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
      "  node hours.mjs serve                   live report at http://127.0.0.1:4747",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main();

export { turns, merge, minutes, workDay, dateRange, buildReport, transcriptTurns, hookConfig, statuslineConfig, bar, hourGrid, htmlReport };
