#!/usr/bin/env node

/**
 * agent-hours — how much time your AI coding sessions actually take.
 *
 * Four hooks write metadata-only events to a JSONL file. Backfill reads local
 * transcripts, but message content is never copied, stored or sent anywhere.
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

const TURN_EVENTS = ["UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"];
const MAX_OPEN_TURN_MS = 4 * 60 * 60 * 1000;
const MAX_IDLE_MS = 30 * 60 * 1000;
const parseDayStart = (value) => {
  if (typeof value === "string" && value.trim() === "") return 5;
  const hour = Number(value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 5;
};
const DAY_START_HOUR = parseDayStart(process.env.AGENT_HOURS_DAY_START ?? 5);

function secureFile(file) {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Privacy hardening must not make capture or reporting fail.
  }
}

function appendPrivate(file, text) {
  fs.appendFileSync(file, text, { encoding: "utf8", mode: 0o600 });
  secureFile(file);
}

/** Replace a private file without exposing a truncated intermediate state. */
function atomicWritePrivate(file, text) {
  const temp = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temp, file);
    secureFile(file);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Keep the original error.
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // The temp may not have been created, or rename may have consumed it.
    }
    throw error;
  }
}

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
    appendPrivate(logPath, `${JSON.stringify(row)}\n`);
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
  let interrupted = false;
  let timeline = [];

  const close = () => {
    if (open) {
      // An interrupted tool-using turn has assistant messages before its final
      // tool result and Esc marker. In that case the last activity, not the
      // last assistant message, is the honest end.
      const stop = interrupted ? lastActivity : lastReply ?? lastActivity;
      if (stop && Date.parse(stop) > Date.parse(open.start)) {
        // A dead gap in the timeline is the machine asleep or the user gone,
        // not the agent working. Audited: one slept-through pair held 14.7h.
        let segStart = open.start;
        let prev = open.start;
        for (const at of [...timeline.filter((t) => Date.parse(t) <= Date.parse(stop)), stop]) {
          if (Date.parse(at) - Date.parse(prev) > MAX_IDLE_MS) {
            if (Date.parse(prev) > Date.parse(segStart)) {
              out.push({ start: segStart, cwd: open.cwd, stop: prev, turnId: open.turnId });
            }
            segStart = at;
          }
          prev = at;
        }
        if (Date.parse(prev) > Date.parse(segStart)) {
          out.push({ start: segStart, cwd: open.cwd, stop: prev, turnId: open.turnId });
        }
      }
    }
    open = null;
    lastReply = null;
    lastActivity = null;
    interrupted = false;
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
      open = { start: entry.timestamp, cwd: entry.cwd || "", turnId: entry.uuid || entry.timestamp };
    } else if (open) {
      timeline.push(entry.timestamp);
      lastActivity = entry.timestamp;
      if (isInterrupt) interrupted = true;
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
      const base = {
        source: "claude",
        sessionId,
        cwd: turn.cwd,
        turnId: `${sessionId}:${turn.turnId}`,
      };
      rows.push({ at: turn.start, event: "UserPromptSubmit", ...base });
      rows.push({ at: turn.stop, event: "Stop", ...base });
    }
  }
  if (files > 0 && rows.length === 0) {
    if (!silent) {
      process.stderr.write(
        `Recovered 0 turns from ${files} transcripts; their format may have changed. Previous history was left untouched.\n`,
      );
      process.exitCode = 1;
    }
    return false;
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
  atomicWritePrivate(
    backfillPath,
    [...rows, ...kept].map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
  if (silent) return true;
  const keptTurns =
    new Set(kept.filter((row) => row.turnId).map((row) => row.turnId)).size +
    kept.filter((row) => !row.turnId && row.event === "UserPromptSubmit").length;
  const note = keptTurns ? ` (+${keptTurns} kept from pruned transcripts)` : "";
  const recovered = new Set(rows.filter((row) => row.turnId).map((row) => row.turnId)).size;
  process.stdout.write(`Recovered ${recovered} turns from ${files} transcripts${note}.\n`);
  return true;
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
  if (Number.isFinite(start) && Number.isFinite(stop) && stop > start) {
    list.push({
      start,
      stop,
      source: startEvent.source,
      cwd: startEvent.cwd || "",
      turnId:
        startEvent.turnId ??
        `${startEvent.source}:${startEvent.sessionId}:${startEvent.at}`,
    });
  }
}

/** Pair UserPromptSubmit with the next Stop of the same session. */
function turns(events, now = Date.now()) {
  const pending = new Map();
  const list = [];
  const capped = (startEvent, at) =>
    addTurn(list, startEvent, Math.min(at, Date.parse(startEvent.at) + MAX_OPEN_TURN_MS));
  const ordered = events
    .filter((event) => Number.isFinite(Date.parse(event.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const event of ordered) {
    const key = `${event.source}:${event.sessionId}`;
    if (event.event === "UserPromptSubmit") {
      // Stop never fires on an Esc interrupt, so a pending prompt would pair
      // with the wrong Stop forever after — the next prompt closes it instead.
      const queue = pending.get(key) ?? [];
      for (const startEvent of queue.splice(0)) capped(startEvent, Date.parse(event.at));
      queue.push(event);
      pending.set(key, queue);
    } else if (event.event === "Stop" || event.event === "StopFailure") {
      const startEvent = pending.get(key)?.shift();
      if (startEvent) addTurn(list, startEvent, Date.parse(event.at));
    } else if (event.event === "SessionEnd") {
      // A clean exit closes whatever the session left open, at exit time.
      for (const startEvent of pending.get(key)?.splice(0) ?? []) capped(startEvent, Date.parse(event.at));
    }
  }
  // A turn with no completion means the session was killed. Cap it instead of
  // counting until the end of time.
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
  secureFile(file);
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

const projectRoots = new Map();

function canonicalPath(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** A session started in src/ still belongs to the repo, so walk up to the git root. */
function projectRoot(cwd) {
  if (!cwd) return "(unknown)";
  if (!projectRoots.has(cwd)) {
    let dir = cwd;
    while (!fs.existsSync(path.join(dir, ".git"))) {
      const parent = path.dirname(dir);
      if (parent === dir) {
        dir = cwd;
        break;
      }
      dir = parent;
    }
    dir = canonicalPath(dir);
    const home = canonicalPath(os.homedir());
    // A session run from ~ would otherwise surface the user's login as a
    // "project" — that reads as a bug on every screenshot.
    projectRoots.set(cwd, dir === home ? "(home)" : dir);
  }
  return projectRoots.get(cwd);
}

/** Use the shortest path suffix that distinguishes equal repository names. */
function projectLabels(roots) {
  const labels = new Map();
  const groups = new Map();
  for (const root of roots) {
    if (root.startsWith("(") && root.endsWith(")")) {
      labels.set(root, root);
      continue;
    }
    const name = path.basename(root) || "(unknown)";
    groups.set(name, [...(groups.get(name) ?? []), root]);
  }
  for (const [name, group] of groups) {
    if (group.length === 1) {
      labels.set(group[0], name);
      continue;
    }
    const parts = new Map(
      group.map((root) => [root, root.split(/[\\/]+/).filter(Boolean)]),
    );
    const maxDepth = Math.max(...[...parts.values()].map((item) => item.length));
    let resolved = false;
    for (let depth = 2; depth <= maxDepth; depth++) {
      const candidates = group.map((root) => parts.get(root).slice(-depth).join("/"));
      if (new Set(candidates).size === group.length) {
        group.forEach((root, index) => labels.set(root, candidates[index]));
        resolved = true;
        break;
      }
    }
    if (!resolved) group.forEach((root) => labels.set(root, root.replaceAll("\\", "/")));
  }
  return labels;
}

function buildReport(events, dates, now = Date.now()) {
  const wanted = new Set(dates);
  const day = turns(events, now).filter((turn) => wanted.has(workDay(turn.start)));
  const byProject = new Map();
  for (const turn of day) {
    const root = projectRoot(turn.cwd);
    byProject.set(root, [...(byProject.get(root) ?? []), turn]);
  }
  const labels = projectLabels(byProject.keys());
  return {
    range: dates.length === 1 ? dates[0] : `${dates[0]}..${dates.at(-1)}`,
    wallMinutes: minutes(merge(day)),
    turnMinutes: minutes(day),
    turns: new Set(day.map((turn) => turn.turnId)).size,
    byProject: Object.fromEntries(
      [...byProject]
        .map(([root, list]) => [labels.get(root), minutes(merge(list))])
        .sort((a, b) => b[1] - a[1]),
    ),
  };
}

function formatHours(value) {
  const safe = Math.max(0, Math.round(value));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

// Datasheet, not dashboard: one accent (brass, on agent-active time), labels
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
    `  ${dim(label.padEnd(13))}${dim(note.padEnd(width - 21))}${ink(String(value).padStart(6))}`;
  const max = Math.max(1, ...projects.map(([, mins]) => mins));
  const row = ([name, mins]) =>
    `  ${bone(name.padEnd(nameWidth + 2))}${dark(bar(mins, max, 24).padEnd(26))}${bone(formatHours(mins).padStart(6))}`;
  process.stdout.write(
    [
      `  ${bone("agent-hours")}${dim(report.range.padStart(width - 13))}`,
      rule,
      stat("AGENT ACTIVE", "at least one turn running", formatHours(report.wallMinutes), brass),
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
 * One line for the Claude Code status bar: today's agent-active time, always in
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
 * A shareable record of agent-active time: warm paper, serif labels, mono
 * numbers, dot leaders, one red-oxide rule under the total. Self-contained
 * file, no JS, no requests.
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
      <div class="total-label">Agent Active</div>
      <div class="mono">${formatHours(report.wallMinutes)}</div>
      <div class="caption">${t(
        "merged wall-clock time with at least one Claude Code turn running",
        "сумарний wall-clock, коли працював хоча б один turn Claude Code",
      )}</div>
    </div>
    ${days ? `<div class="sec-label">${t("Days", "Дні")} <span class="note">${t("— one cell per hour of the day, darker = more of it worked", "— одна клітинка = година доби, темніше = більше роботи")}</span></div>\n    <section>\n      ${days}${scale}\n    </section>` : ""}
    <div class="sec-label">${t("Projects", "Проєкти")} <span class="note">${t("— agent-active time per project", "— agent-active час по кожному проєкту")}</span></div>
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
        "Four Claude Code hooks record four fields per live event — a timestamp, the event name, a session id and the working folder. Backfill reads local transcripts, but message content is never copied, stored or sent.",
        "Чотири хуки Claude Code записують чотири поля на live-подію — час, назву події, id сесії і робочу теку. Backfill читає локальні транскрипти, але вміст повідомлень не копіюється, не зберігається і не надсилається.",
      )}</p>
      <p>${t(
        "A turn runs from the moment you send a prompt to the moment the agent finishes or fails. Reading, thinking and editing after the reply are not counted; this is agent activity, not human working time or an automatic billing total.",
        "Turn триває від відправки промпта до моменту, коли агент завершує роботу або падає з помилкою. Читання, обдумування й ручні правки після відповіді не рахуються: це активність агента, а не робочий час людини чи автоматична сума для рахунку.",
      )}</p>
      <p>${t(
        "Agent active merges overlapping turns, so two parallel sessions in the same hour count as one hour. Turn time sums them all. A silence over 30 minutes is cut out as idle, which can also omit a genuinely long silent tool call. An unclosed session is capped at 4 hours.",
        "Agent active зливає перетини: дві паралельні сесії в одну годину — це одна година. Turn time додає все. Тиша понад 30 хвилин вирізається як idle, тому справді довгий тихий tool call теж може бути пропущений. Незакрита сесія обрізається на 4 годинах.",
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
  if (process.env.AGENT_HOURS_NO_OPEN === "1") return;
  const [opener, openerArgs] =
    { darwin: ["open", [target]], win32: ["cmd", ["/c", "start", "", target]] }[process.platform] ??
    ["xdg-open", [target]];
  execFile(opener, openerArgs, () => {});
}

function writeHtml(report) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hours-"));
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  const file = path.join(dir, "report.html");
  fs.writeFileSync(file, htmlReport(report), { encoding: "utf8", mode: 0o600 });
  secureFile(file);
  openInBrowser(file);
  process.stdout.write(`${file}\nSnapshot remains on disk; delete that directory when you no longer need it.\n`);
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
  return hookConfigFor(TURN_EVENTS, target);
}

function hookConfigFor(events, target = scriptPath) {
  const hook = () => [
    { hooks: [{ type: "command", command: `node "${target}" hook claude`, timeout: 3 }] },
  ];
  return { hooks: Object.fromEntries(events.map((event) => [event, hook()])) };
}

function statuslineConfig(target = scriptPath) {
  return { statusLine: { type: "command", command: `node "${target}" statusline` } };
}

function installPlan(settings, target = scriptPath) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new TypeError("settings.json must contain a JSON object");
  }
  if (
    settings.hooks !== undefined &&
    (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))
  ) {
    throw new TypeError('the existing "hooks" value must be an object');
  }
  const command = `node "${target}" hook claude`;
  const missing = [];
  const duplicates = [];
  for (const event of TURN_EVENTS) {
    const configured = settings.hooks?.[event];
    if (configured !== undefined && !Array.isArray(configured)) {
      throw new TypeError(`the existing "hooks.${event}" value must be an array`);
    }
    const count = (configured ?? []).reduce(
      (total, matcher) =>
        total +
        (Array.isArray(matcher?.hooks)
          ? matcher.hooks.filter((item) => item?.type === "command" && item.command === command).length
          : 0),
      0,
    );
    if (count === 0) missing.push(event);
    if (count > 1) duplicates.push({ event, count });
  }
  return {
    config: hookConfigFor(missing, target),
    missing,
    duplicates,
    statuslineTaken: Object.hasOwn(settings, "statusLine"),
  };
}

function printInstall() {
  const settings = path.join(os.homedir(), ".claude", "settings.json");
  const exists = fs.existsSync(settings);
  let current = {};
  if (exists) {
    try {
      current = JSON.parse(fs.readFileSync(settings, "utf8"));
    } catch (error) {
      process.stderr.write(`Could not parse ${settings}: ${error.message}\nNo changes were suggested.\n`);
      process.exitCode = 1;
      return;
    }
  }
  let plan;
  try {
    plan = installPlan(current);
  } catch (error) {
    process.stderr.write(`Could not safely merge into ${settings}: ${error.message}\nNo changes were suggested.\n`);
    process.exitCode = 1;
    return;
  }
  const lines = [`Inspecting ${settings}`, ""];
  if (plan.missing.length) {
    lines.push(
      `Add only these missing hooks (${plan.missing.join(", ")}); keep every existing entry:`,
      "",
      JSON.stringify(plan.config, null, 2),
      "",
    );
  } else {
    lines.push("All four agent-hours hooks are already installed.", "");
  }
  if (plan.duplicates.length) {
    lines.push(
      `Warning: duplicate agent-hours hooks found: ${plan.duplicates.map(({ event, count }) => `${event} ×${count}`).join(", ")}.`,
      "Remove only duplicate entries with the exact agent-hours command; keep one per event and preserve all other hooks.",
      "",
    );
  }
  if (plan.statuslineTaken) {
    lines.push("The statusLine slot is already configured; agent-hours will not replace it.", "");
  } else {
    lines.push(
      "Optional — today's agent-active time in the Claude Code status bar:",
      "",
      JSON.stringify(statuslineConfig(), null, 2),
      "",
    );
  }
  lines.push("Then restart Claude Code and run:  node hours.mjs report", "");
  process.stdout.write(lines.join("\n"));
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

export {
  turns,
  merge,
  minutes,
  workDay,
  dateRange,
  buildReport,
  transcriptTurns,
  hookConfig,
  statuslineConfig,
  installPlan,
  atomicWritePrivate,
  parseDayStart,
  projectLabels,
  bar,
  hourGrid,
  htmlReport,
};
