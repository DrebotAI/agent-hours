#!/usr/bin/env node

/**
 * agent-hours — how much time your AI coding sessions actually take.
 *
 * Lifecycle hooks write metadata-only events to a JSONL file. Backfill reads local
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
const claudeTranscriptRoot =
  process.env.AGENT_HOURS_CLAUDE_TRANSCRIPTS ??
  process.env.AGENT_HOURS_TRANSCRIPTS ??
  path.join(os.homedir(), ".claude", "projects");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const codexTranscriptRoot =
  process.env.AGENT_HOURS_CODEX_TRANSCRIPTS || path.join(codexHome, "sessions");

const CLAUDE_TURN_EVENTS = ["UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"];
const CODEX_TURN_EVENTS = ["UserPromptSubmit", "Stop", "SessionEnd"];
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
    const allowed = source === "codex" ? CODEX_TURN_EVENTS : CLAUDE_TURN_EVENTS;
    if (!allowed.includes(event)) return;
    const row = {
      at: new Date().toISOString(),
      source,
      event,
      sessionId: String(input.session_id ?? input.sessionId ?? ""),
      cwd: typeof input.cwd === "string" ? input.cwd : "",
    };
    const turnId = input.turn_id ?? input.turnId;
    if (turnId !== undefined && turnId !== null && String(turnId)) row.turnId = String(turnId);
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
 * Claude Code and Codex already keep timestamped transcripts on disk, so history is
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

/** Split a completed turn around dead gaps while preserving one logical id. */
function splitCompletedTurn(out, turn, stop, timeline) {
  if (!turn || !Number.isFinite(Date.parse(stop)) || Date.parse(stop) <= Date.parse(turn.start)) return;
  let segmentStart = turn.start;
  let previous = turn.start;
  const activity = [...timeline, stop]
    .filter((at) => Number.isFinite(Date.parse(at)) && Date.parse(at) <= Date.parse(stop));
  for (const at of activity) {
    if (Date.parse(at) - Date.parse(previous) > MAX_IDLE_MS) {
      if (Date.parse(previous) > Date.parse(segmentStart)) {
        out.push({ start: segmentStart, cwd: turn.cwd, stop: previous, turnId: turn.turnId });
      }
      segmentStart = at;
    }
    previous = at;
  }
  if (Date.parse(previous) > Date.parse(segmentStart)) {
    out.push({ start: segmentStart, cwd: turn.cwd, stop: previous, turnId: turn.turnId });
  }
}

/**
 * Codex rollouts expose explicit task_started/task_complete/turn_aborted events.
 * Content fields are ignored; session metadata, turn ids, cwd and timestamps are
 * enough to reconstruct the same prompt-to-stop metric as the live hooks.
 */
function codexTranscript(text, fallbackSessionId = "") {
  const turns = [];
  let sessionId = fallbackSessionId;
  let cwd = "";
  let isSubagent = false;
  let starts = 0;
  let closes = 0;
  let recognized = false;
  let open = null;
  let timeline = [];

  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = entry.timestamp;
    if (!Number.isFinite(Date.parse(timestamp))) continue;
    const payload = entry.payload ?? {};
    if (entry.type === "session_meta") {
      recognized = true;
      if (payload.id !== undefined && payload.id !== null) sessionId = String(payload.id);
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      if (payload.source && typeof payload.source === "object" && payload.source.subagent) {
        isSubagent = true;
      }
    }
    if (entry.type === "event_msg" && payload.type === "task_started") {
      starts++;
      open = {
        start: timestamp,
        cwd,
        turnId: String(payload.turn_id ?? timestamp),
      };
      timeline = [];
      continue;
    }
    if (!open) continue;
    if (entry.type === "turn_context") {
      if (typeof payload.cwd === "string") {
        cwd = payload.cwd;
        open.cwd = payload.cwd;
      }
    }
    timeline.push(timestamp);
    const closesTurn =
      entry.type === "event_msg" &&
      (payload.type === "task_complete" || payload.type === "turn_aborted") &&
      String(payload.turn_id ?? open.turnId) === open.turnId;
    if (closesTurn) {
      closes++;
      splitCompletedTurn(turns, open, timestamp, timeline);
      open = null;
      timeline = [];
    }
  }
  return { sessionId, isSubagent, starts, closes, recognized, turns: isSubagent ? [] : turns };
}

function transcriptNames(root, silent) {
  try {
    return fs.readdirSync(root, { recursive: true });
  } catch (error) {
    if (!silent) {
      process.stderr.write(`Could not read ${root}: ${error.message}\n`);
      process.stderr.write(`agent-hours needs Node 20.1 or newer; you have ${process.version}.\n`);
      process.exitCode = 1;
    }
    return null;
  }
}

function collectClaudeBackfill(root, silent) {
  const rows = [];
  let files = 0;
  const names = transcriptNames(root, silent);
  if (!names) return null;
  for (const name of names) {
    if (!String(name).endsWith(".jsonl")) continue;
    if (/[\\/]subagents[\\/]/.test(String(name))) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, String(name)), "utf8");
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
  return { source: "claude", files, rows, allowEmpty: false };
}

function collectCodexBackfill(root, silent) {
  const rows = [];
  let files = 0;
  let starts = 0;
  let closes = 0;
  let recognized = false;
  const names = transcriptNames(root, silent);
  if (!names) return null;
  for (const name of names) {
    if (!String(name).endsWith(".jsonl")) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, String(name)), "utf8");
    } catch {
      continue;
    }
    const basename = path.basename(String(name), ".jsonl");
    const fallback =
      basename.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)?.[0] ?? basename;
    const parsed = codexTranscript(text, fallback);
    if (parsed.isSubagent) continue;
    files++;
    starts += parsed.starts;
    closes += parsed.closes;
    recognized = recognized || parsed.recognized;
    for (const turn of parsed.turns) {
      const base = {
        source: "codex",
        sessionId: parsed.sessionId,
        cwd: turn.cwd,
        turnId: `${parsed.sessionId}:${turn.turnId}`,
      };
      rows.push({ at: turn.start, event: "UserPromptSubmit", ...base });
      rows.push({ at: turn.stop, event: "Stop", ...base });
    }
  }
  // A lone transcript with zero closed turns is normal, not a parse failure:
  // it's either a turn still in flight (starts === 1) or a session Codex has
  // only just created, before the first task_started lands (starts === 0).
  // The latter still counts as "recognized" via session_meta, which is what
  // separates it from a genuinely unparseable/changed format below.
  const singleFreshOrOpenSession =
    files === 1 && closes === 0 && (starts === 1 || (starts === 0 && recognized));
  return { source: "codex", files, rows, allowEmpty: singleFreshOrOpenSession };
}

function backfill(silent = false) {
  const available = [
    ["claude", claudeTranscriptRoot, collectClaudeBackfill],
    ["codex", codexTranscriptRoot, collectCodexBackfill],
  ].filter(([, root]) => fs.existsSync(root));
  if (!available.length) {
    if (silent) return;
    process.stderr.write(`No transcripts at ${claudeTranscriptRoot} or ${codexTranscriptRoot}\n`);
    process.exitCode = 1;
    return;
  }
  const results = available.map(([, root, collect]) => collect(root, silent)).filter(Boolean);
  if (results.length !== available.length) return false;
  const failed = results.find(
    (result) => result.files > 0 && result.rows.length === 0 && !result.allowEmpty,
  );
  if (failed) {
    if (!silent) {
      process.stderr.write(
        `Recovered 0 turns from ${failed.files} ${failed.source} transcripts; their format may have changed. Previous history was left untouched.\n`,
      );
      process.exitCode = 1;
    }
    return false;
  }
  const rows = results.flatMap((result) => result.rows);
  const files = results.reduce((sum, result) => sum + result.files, 0);
  // Rewritten in full every run, so re-running can never double-count. Agents
  // eventually prune old transcripts, though — sessions recovered on an
  // earlier run must not vanish with them, so the rewrite unions with itself.
  const sessionKey = (event) => `${event.source ?? "claude"}:${event.sessionId}`;
  const seen = new Set(rows.map(sessionKey));
  // Never resurrect legacy Claude subagent transcripts skipped above.
  const kept = readJsonl(backfillPath).filter(
    (event) =>
      !seen.has(sessionKey(event)) &&
      !(event.source === "claude" && event.sessionId.startsWith("agent-")),
  );
  atomicWritePrivate(
    backfillPath,
    [...rows, ...kept].map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
  if (silent) return true;
  const logicalTurnCount = (events) =>
    new Set(
      events
        .filter((row) => row.turnId)
        .map((row) => `${row.source ?? "claude"}:${row.turnId}`),
    ).size + events.filter((row) => !row.turnId && row.event === "UserPromptSubmit").length;
  const keptTurns = logicalTurnCount(kept);
  const note = keptTurns ? ` (+${keptTurns} kept from pruned transcripts)` : "";
  const recovered = logicalTurnCount(rows);
  const detail = results.map((result) => `${result.source} ${logicalTurnCount(result.rows)}`).join(", ");
  process.stdout.write(`Recovered ${recovered} turns from ${files} transcripts (${detail})${note}.\n`);
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
    const source = startEvent.source ?? "claude";
    list.push({
      start,
      stop,
      source,
      cwd: startEvent.cwd || "",
      turnId: `${source}:${startEvent.turnId ?? `${startEvent.sessionId}:${startEvent.at}`}`,
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
    const key = `${event.source ?? "claude"}:${event.sessionId}`;
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
  const shifted = new Date(ms);
  shifted.setHours(shifted.getHours() - DAY_START_HOUR);
  return stamp(shifted);
}

function dateRange(end, days) {
  const [year, month, day] = end.split("-").map(Number);
  const out = [];
  for (let back = days - 1; back >= 0; back--) out.push(stamp(new Date(year, month - 1, day - back)));
  return out;
}

/** Clip activity to shifted work-day boundaries so totals and the hour grid agree. */
function turnsInDates(list, dates) {
  const bounds = dates.map((date) => {
    const [year, month, day] = date.split("-").map(Number);
    return {
      start: new Date(year, month - 1, day, DAY_START_HOUR).getTime(),
      stop: new Date(year, month - 1, day + 1, DAY_START_HOUR).getTime(),
    };
  });
  return list.flatMap((turn) =>
    bounds.flatMap((bound) => {
      const start = Math.max(turn.start, bound.start);
      const stop = Math.min(turn.stop, bound.stop);
      return stop > start ? [{ ...turn, start, stop }] : [];
    }),
  );
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
    const key = `${event.source ?? "claude"}:${event.sessionId}`;
    const at = Date.parse(event.at);
    if (!(newest.get(key) >= at)) newest.set(key, at);
  }
  const live = readJsonl(logPath).filter((event) => {
    const key = `${event.source ?? "claude"}:${event.sessionId}`;
    return !newest.has(key) || Date.parse(event.at) > newest.get(key);
  });
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
  const day = turnsInDates(turns(events, now), dates);
  const byProject = new Map();
  const bySource = new Map();
  for (const turn of day) {
    const root = projectRoot(turn.cwd);
    byProject.set(root, [...(byProject.get(root) ?? []), turn]);
    bySource.set(turn.source, [...(bySource.get(turn.source) ?? []), turn]);
  }
  const labels = projectLabels(byProject.keys());
  return {
    range: dates.length === 1 ? dates[0] : `${dates[0]}..${dates.at(-1)}`,
    wallMinutes: minutes(merge(day)),
    turnMinutes: minutes(day),
    turns: new Set(day.map((turn) => turn.turnId)).size,
    bySource: Object.fromEntries(
      [...bySource]
        .map(([source, list]) => [source, minutes(merge(list))])
        .sort((a, b) => b[1] - a[1]),
    ),
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
  const sources = Object.entries(report.bySource ?? {});
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
      ...sources.map(([source, mins]) =>
        stat(
          source === "claude" ? "CLAUDE CODE" : source.toUpperCase(),
          "agent active",
          formatHours(mins),
          bone,
        ),
      ),
      rule,
      ...(report.turns ? projects.map(row) : [`  ${dim(emptyHint())}`]),
      rule,
      `  ${dim("no dependencies · nothing leaves your machine")}`,
      "",
    ].join("\n"),
  );
}

/** Bucket merged intervals into occupancy minutes per hour cell, one row per work day. */
function bucketByHour(intervals, dates) {
  const grid = new Map(dates.map((day) => [day, Array(24).fill(0)]));
  for (const { start, stop } of merge(intervals)) {
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
  return grid;
}

/**
 * Occupancy minutes per hour cell, one row per work day — the timesheet grid —
 * plus, per cell, Claude Code's share of that occupancy. Two same-source
 * parallel sessions merge before bucketing, exactly like the total does, so a
 * source's own overlap is never double-counted; two *different* sources
 * covering the same minutes still both count toward their own share, which is
 * what lets a mixed cell render as mixed rather than picking one arbitrarily.
 */
function hourGrid(events, dates, now = Date.now()) {
  const day = turnsInDates(turns(events, now), dates);
  const claude = day.filter((turn) => turn.source === "claude");
  const other = day.filter((turn) => turn.source !== "claude");
  const totalGrid = bucketByHour(day, dates);
  const claudeGrid = bucketByHour(claude, dates);
  const otherGrid = bucketByHour(other, dates);
  const bySourceShare = dates.map((date) => [
    date,
    claudeGrid.get(date).map((claudeMins, hour) => {
      const contributed = claudeMins + otherGrid.get(date)[hour];
      return contributed ? claudeMins / contributed : 0;
    }),
  ]);
  const labels = projectLabels(new Set(day.map((turn) => projectRoot(turn.cwd))));
  const cells = new Map();
  for (const turn of day) {
    const project = labels.get(projectRoot(turn.cwd));
    const first = new Date(turn.start);
    first.setMinutes(0, 0, 0);
    for (let t = first.getTime(); t < turn.stop; t += 3600000) {
      const date = workDay(t);
      if (!dates.includes(date)) continue;
      const mins = Math.round((Math.min(turn.stop, t + 3600000) - Math.max(turn.start, t)) / 60000);
      if (mins <= 0) continue;
      const key = `${date}-${new Date(t).getHours()}`;
      const cell = cells.get(key) ?? { bySource: new Map(), byProject: new Map() };
      cell.bySource.set(turn.source, (cell.bySource.get(turn.source) ?? 0) + mins);
      cell.byProject.set(project, (cell.byProject.get(project) ?? 0) + mins);
      cells.set(key, cell);
    }
  }
  // No content, same as everywhere else — just which agent and which project
  // touched this hour and for how long, from the metadata already on hand.
  const hourDetails = [...cells].map(([key, cell]) => [
    key,
    { bySource: [...cell.bySource], byProject: [...cell.byProject] },
  ]);
  return { byDay: [...totalGrid], bySourceShare, hourDetails };
}

/** turn/wall — how many of you were effectively working in parallel. */
function ratio(report) {
  if (!report.wallMinutes) return "";
  return ` · ×${(report.turnMinutes / report.wallMinutes).toFixed(2)}`;
}

/** The likeliest reason for an empty report is a missed backfill, not hooks. */
function emptyHint() {
  if (
    !fs.existsSync(backfillPath) &&
    (fs.existsSync(claudeTranscriptRoot) || fs.existsSync(codexTranscriptRoot))
  ) {
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
  const shareByDay = new Map(report.bySourceShare ?? []);
  // Darkness still tracks how full the hour is. Hue tracks who filled it:
  // solid orange is a Claude-only hour, solid ink a Codex/other-only hour. A
  // cell split between two agents — even by turns taken minutes apart, not
  // literally in parallel — gets a hard-edged two-tone split rather than a
  // blended third color, so which agent did how much stays legible instead
  // of being flattened into one ambiguous hue.
  const cellStyle = (value, share) => {
    const opacity = (0.07 + (value / 60) * 0.83).toFixed(2);
    if (!value || share <= 0) return `--a:${opacity}`;
    if (share >= 1) return `--a:${opacity};background:var(--claude)`;
    const split = Math.round(share * 100);
    return `--a:${opacity};background:linear-gradient(90deg, var(--claude) ${split}%, var(--ink) ${split}%)`;
  };
  const detailsByHour = new Map(report.hourDetails ?? []);
  const sourceLabel = (source) =>
    source === "claude" ? "Claude Code" : escapeHtml(source === "codex" ? "Codex" : source);
  // Metadata only, same as everywhere else in this report — which agent and
  // which project touched the hour, and for how long. No prompt or reply text
  // exists to show even if this popover wanted to.
  const popovers = [...detailsByHour]
    .map(([key, cell]) => {
      const [day, hourText] = [key.slice(0, 10), key.slice(11)];
      const hour = Number(hourText);
      const next = (hour + 1) % 24;
      const pad = (n) => String(n).padStart(2, "0");
      const rows = (entries) =>
        entries
          .map(
            ([name, mins]) =>
              `<div class="prow"><span>${name}</span><span class="mono">${mins}${t(" min", " хв")}</span></div>`,
          )
          .join("");
      return `<div id="h-${key}" class="popover">
        <a href="#" class="pclose">×</a>
        <div class="ptime mono">${docDate(day).slice(0, 5)} · ${pad(hour)}:00–${pad(next)}:00</div>
        ${rows(cell.bySource.map(([source, mins]) => [sourceLabel(source), mins]))}
        <div class="psep"></div>
        ${rows(cell.byProject.map(([project, mins]) => [escapeHtml(project), mins]))}
      </div>`;
    })
    .join("\n      ");
  const days = (report.byDay ?? [])
    .map(([day, hours]) => {
      const [year, month, date] = day.split("-").map(Number);
      const weekday = new Date(year, month - 1, date).getDay();
      const label = `${t(WEEKDAYS[weekday], WEEKDAYS_UK[weekday])} ${docDate(day).slice(0, 5)}`;
      const mins = hours.reduce((sum, value) => sum + value, 0);
      const shares = shareByDay.get(day) ?? [];
      const cells = hours
        .map((value, hour) => {
          const style = cellStyle(value, shares[hour] ?? 0);
          const key = `${day}-${hour}`;
          return detailsByHour.has(key)
            ? `<a href="#h-${key}" class="cell" style="${style}"></a>`
            : `<i style="${style}"></i>`;
        })
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
  const sourceRows = Object.entries(report.bySource ?? {})
    .map(([source, mins]) =>
      line(
        source === "claude" ? "Claude Code" : escapeHtml(source === "codex" ? "Codex" : source),
        formatHours(mins),
      ),
    )
    .join("\n      ");
  // The grid's colors only need explaining once more than one agent has ever
  // run — a single-agent history is one hue throughout and self-explanatory.
  const legend =
    Object.keys(report.bySource ?? {}).length > 1
      ? `<span class="legend"><span class="lg"><i class="lg-claude"></i>${t("Claude Code", "Claude Code")}</span><span class="lg"><i class="lg-other"></i>${t("Codex", "Codex")}</span><span class="lg"><i class="lg-mixed"></i>${t("both", "обидва")}</span></span>`
      : "";
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
  :root { --paper: #ede8de; --ink: #17150f; --oxide: #a6371f; --dim: #b4ac9b; --half: #57503f; --claude: #b9702c; }
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
  .legend { display: inline-flex; gap: 10px; margin-left: 10px; vertical-align: middle; font-variant-caps: normal; text-transform: none; letter-spacing: 0.02em; }
  .legend .lg { display: inline-flex; align-items: center; gap: 4px; }
  .legend i { width: 8px; height: 8px; border-radius: 1px; display: inline-block; }
  .lg-claude { background: var(--claude); }
  .lg-other { background: var(--ink); }
  .lg-mixed { background: linear-gradient(90deg, var(--claude) 50%, var(--ink) 50%); }
  .dayrow { display: flex; align-items: center; gap: 10px; padding: 3px 0; font-size: 14px; }
  .dlabel { width: 84px; }
  .dayrow .mono { width: 44px; text-align: right; font-size: 13px; }
  .strip { flex: 1; display: flex; gap: 2px; }
  .strip i, .strip a.cell { flex: 1; height: 12px; background: var(--ink); opacity: var(--a); display: block; }
  .strip a.cell { cursor: pointer; }
  .strip a.cell:hover { outline: 1px solid var(--ink); outline-offset: 1px; }
  .popover {
    display: none; position: fixed; z-index: 1; top: 50%; left: 50%; transform: translate(-50%, -50%);
    background: var(--paper); border: 1px solid var(--ink); padding: 16px 18px; min-width: 220px;
    box-shadow: 4px 4px 0 var(--dim); font-size: 13px;
  }
  .popover:target { display: block; }
  .pclose { position: absolute; top: 8px; right: 12px; color: var(--half); text-decoration: none; font-size: 16px; }
  .ptime { font-size: 12px; color: var(--half); margin-bottom: 8px; }
  .prow { display: flex; justify-content: space-between; gap: 16px; padding: 2px 0; }
  .psep { border-top: 1px solid var(--dim); margin: 8px 0; }
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
        "merged wall-clock time with at least one Claude Code or Codex turn running",
        "сумарний wall-clock, коли працював хоча б один turn Claude Code або Codex",
      )}</div>
    </div>
    ${sourceRows ? `<div class="sec-label">${t("Agents", "Агенти")} <span class="note">${t("— agent-active time per coding agent", "— agent-active час по кожному coding agent")}</span></div>\n    <section>\n      ${sourceRows}\n    </section>` : ""}
    ${days ? `<div class="sec-label">${t("Days", "Дні")} <span class="note">${t("— one cell per hour of the day, darker = more of it worked, click an hour for details", "— одна клітинка = година доби, темніше = більше роботи, клікни на годину для деталей")}</span>${legend}</div>\n    <section>\n      ${days}${scale}\n    </section>${popovers}` : ""}
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
        "Claude Code and Codex lifecycle hooks record metadata for each live event — a timestamp, source, event name, session and turn ids, and the working folder. Backfill reads local transcripts, but message content is never copied, stored or sent.",
        "Lifecycle-хуки Claude Code і Codex записують метадані live-подій — час, джерело, назву події, id сесії й turn та робочу теку. Backfill читає локальні транскрипти, але вміст повідомлень не копіюється, не зберігається і не надсилається.",
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
        "History from before the install is recovered from the timestamped transcripts Claude Code and Codex already keep on your machine. Every rule and its reasoning: DECISIONS.md in the repository.",
        "Історія до установки відновлена з транскриптів із таймстампами, які Claude Code і Codex і так тримають на твоїй машині. Кожне правило з обґрунтуванням — у DECISIONS.md в репозиторії.",
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
    Object.assign(report, hourGrid(events, dates));
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
  return hookConfigFor(CLAUDE_TURN_EVENTS, "claude", target);
}

function codexHookConfig(target = scriptPath) {
  return hookConfigFor(CODEX_TURN_EVENTS, "codex", target);
}

function hookConfigFor(events, source, target = scriptPath) {
  const hook = () => [
    { hooks: [{ type: "command", command: `node "${target}" hook ${source}`, timeout: 3 }] },
  ];
  return { hooks: Object.fromEntries(events.map((event) => [event, hook()])) };
}

function statuslineConfig(target = scriptPath) {
  return { statusLine: { type: "command", command: `node "${target}" statusline` } };
}

function jsonHookCounts(settings, events, command, label) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new TypeError(`${label} must contain a JSON object`);
  }
  if (
    settings.hooks !== undefined &&
    (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))
  ) {
    throw new TypeError('the existing "hooks" value must be an object');
  }
  const counts = new Map();
  for (const event of events) {
    const configured = settings.hooks?.[event];
    if (configured !== undefined && !Array.isArray(configured)) {
      throw new TypeError(`the existing "hooks.${event}" value must be an array`);
    }
    counts.set(
      event,
      (configured ?? []).reduce(
        (total, matcher) =>
          total +
          (Array.isArray(matcher?.hooks)
            ? matcher.hooks.filter((item) => item?.type === "command" && item.command === command).length
            : 0),
        0,
      ),
    );
  }
  return counts;
}

function installPlan(settings, target = scriptPath) {
  const command = `node "${target}" hook claude`;
  const counts = jsonHookCounts(settings, CLAUDE_TURN_EVENTS, command, "settings.json");
  const missing = [];
  const duplicates = [];
  for (const event of CLAUDE_TURN_EVENTS) {
    const count = counts.get(event);
    if (count === 0) missing.push(event);
    if (count > 1) duplicates.push({ event, count });
  }
  return {
    config: hookConfigFor(missing, "claude", target),
    missing,
    duplicates,
    statuslineTaken: Object.hasOwn(settings, "statusLine"),
  };
}

function codexTomlInfo(text, target = scriptPath) {
  const command = `node "${target}" hook codex`;
  const counts = new Map(CODEX_TURN_EVENTS.map((event) => [event, 0]));
  let currentEvent = null;
  let inFeatures = false;
  let hasInlineHooks = false;
  let hooksDisabled = false;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+)\]\]?\s*(?:#.*)?$/);
    if (header) {
      const name = header[1].trim();
      hasInlineHooks ||= name === "hooks" || name.startsWith("hooks.");
      inFeatures = name === "features";
      const event = name.match(/^hooks\.([A-Za-z]+)\.hooks$/)?.[1];
      currentEvent = CODEX_TURN_EVENTS.includes(event) ? event : null;
      continue;
    }
    if (inFeatures && /^\s*(?:hooks|codex_hooks)\s*=\s*false\s*(?:#.*)?$/.test(line)) {
      hooksDisabled = true;
    }
    if (currentEvent) {
      const raw = line.match(/^\s*command\s*=\s*(.*)$/)?.[1]?.trim();
      let value = null;
      try {
        const basic = raw?.match(/^"(?:\\.|[^"\\])*"/)?.[0];
        if (basic) value = JSON.parse(basic);
        else value = raw?.match(/^'([^']*)'/)?.[1] ?? null;
      } catch {
        // An unrelated or malformed TOML value is not an exact agent-hours hook.
      }
      if (value === command) counts.set(currentEvent, counts.get(currentEvent) + 1);
    }
  }
  return { counts, hasInlineHooks, hooksDisabled };
}

function codexTomlConfig(events, target = scriptPath) {
  const command = JSON.stringify(`node "${target}" hook codex`);
  return events
    .map(
      (event) =>
        `[[hooks.${event}]]\n\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${command}\ntimeout = 3`,
    )
    .join("\n\n");
}

function codexInstallPlan(hooksJson, configToml = "", target = scriptPath, preferToml = false) {
  const command = `node "${target}" hook codex`;
  const jsonCounts = jsonHookCounts(hooksJson, CODEX_TURN_EVENTS, command, "hooks.json");
  const toml = codexTomlInfo(configToml, target);
  const missing = [];
  const duplicates = [];
  for (const event of CODEX_TURN_EVENTS) {
    const count = jsonCounts.get(event) + toml.counts.get(event);
    if (count === 0) missing.push(event);
    if (count > 1) duplicates.push({ event, count });
  }
  const format = preferToml ? "toml" : "json";
  return {
    config: format === "toml" ? codexTomlConfig(missing, target) : hookConfigFor(missing, "codex", target),
    missing,
    duplicates,
    format,
    hooksDisabled: toml.hooksDisabled,
    hasInlineHooks: toml.hasInlineHooks,
  };
}

function readJsonConfig(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function claudeInstallLines() {
  const settings = path.join(os.homedir(), ".claude", "settings.json");
  let current;
  let plan;
  try {
    current = readJsonConfig(settings);
    plan = installPlan(current);
  } catch (error) {
    return {
      error: `Could not parse or safely inspect ${settings}: ${error.message}\nNo Claude Code changes were suggested.`,
    };
  }
  const lines = [`Claude Code — inspecting ${settings}`, ""];
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
  lines.push("Then restart Claude Code.", "");
  return { lines };
}

function codexInstallLines() {
  const hooksFile = path.join(codexHome, "hooks.json");
  const configFile = path.join(codexHome, "config.toml");
  let hooksJson;
  let configToml = "";
  try {
    hooksJson = readJsonConfig(hooksFile);
    if (fs.existsSync(configFile)) configToml = fs.readFileSync(configFile, "utf8");
  } catch (error) {
    return {
      error: `Could not parse or safely inspect Codex config: ${error.message}\nNo Codex changes were suggested.`,
    };
  }
  let plan;
  try {
    const preferToml = !fs.existsSync(hooksFile) && codexTomlInfo(configToml).hasInlineHooks;
    plan = codexInstallPlan(hooksJson, configToml, scriptPath, preferToml);
  } catch (error) {
    return {
      error: `Could not safely merge into ${hooksFile}: ${error.message}\nNo Codex changes were suggested.`,
    };
  }
  const target = plan.format === "toml" ? configFile : hooksFile;
  const lines = [`Codex — inspecting ${hooksFile} and ${configFile}`, ""];
  if (plan.missing.length) {
    lines.push(
      `Add only these missing hooks (${plan.missing.join(", ")}) to ${target}; keep every existing entry:`,
      "",
      plan.format === "json" ? JSON.stringify(plan.config, null, 2) : plan.config,
      "",
    );
  } else {
    lines.push("All three agent-hours Codex hooks are already installed.", "");
  }
  if (plan.duplicates.length) {
    lines.push(
      `Warning: duplicate agent-hours Codex hooks found: ${plan.duplicates.map(({ event, count }) => `${event} ×${count}`).join(", ")}.`,
      "Remove only duplicate entries with the exact agent-hours command; preserve every other hook.",
      "",
    );
  }
  if (plan.hooksDisabled) {
    lines.push(
      "Warning: Codex lifecycle hooks are disabled under [features]; enable hooks before relying on live capture.",
      "",
    );
  }
  lines.push("Then restart Codex and use /hooks to review and trust the new commands.", "");
  return { lines };
}

function printInstall(scope = "all") {
  if (!["all", "claude", "codex"].includes(scope)) {
    process.stderr.write("Usage: node hours.mjs install [claude|codex]\n");
    process.exitCode = 1;
    return;
  }
  const sections = [];
  if (scope === "all" || scope === "claude") sections.push(claudeInstallLines());
  if (scope === "all" || scope === "codex") sections.push(codexInstallLines());
  const output = sections.filter((section) => section.lines).flatMap((section) => section.lines);
  const errors = sections.filter((section) => section.error).map((section) => section.error);
  if (output.length) {
    output.push("Run after configuring:  node hours.mjs backfill && node hours.mjs report", "");
    process.stdout.write(output.join("\n"));
  }
  if (errors.length) {
    process.stderr.write(`${errors.join("\n\n")}\n`);
    process.exitCode = 1;
  }
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
  if (command === "install") return printInstall(args[0] ?? "all");
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
      Object.assign(report, hourGrid(events, dates));
      return writeHtml(report);
    }
    return printReport(report, args.includes("--json"));
  }
  process.stderr.write(
    [
      "agent-hours — how much time your AI coding sessions actually take",
      "",
      "  node hours.mjs backfill                read history from past transcripts",
      "  node hours.mjs install [claude|codex]  print missing hook config for both or one",
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
  codexTranscript,
  hookConfig,
  codexHookConfig,
  statuslineConfig,
  installPlan,
  codexInstallPlan,
  codexTomlConfig,
  atomicWritePrivate,
  parseDayStart,
  projectLabels,
  bar,
  hourGrid,
  htmlReport,
};
