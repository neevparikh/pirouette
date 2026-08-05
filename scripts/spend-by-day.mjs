#!/usr/bin/env node
/** Chart what pirouette agents actually spent, per calendar day.
 *
 *  The state file only knows a lifetime total per agent, so "spend by day"
 *  derived from it can only mean "by the day the agent was created" — which
 *  smears a week-long agent onto its birthday. The session transcripts carry a
 *  timestamp and a cost on every assistant message, so we bucket those instead:
 *  each dollar lands on the day it was actually burned.
 *
 *  Usage:
 *    node scripts/spend-by-day.mjs [--data-dir DIR] [--out FILE.svg]
 *                                  [--since YYYY-MM-DD] [--until YYYY-MM-DD]
 *                                  [--tz utc|local] [--by project|model|none]
 *                                  [--csv FILE.csv]
 */

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

const dataDir = flag("data-dir", process.env.PIROUETTE_DATA_DIR ?? "/data/pirouette/data");
const outPath = flag("out", "spend-by-day.svg");
const csvPath = flag("csv", null);
const since = flag("since", null);
const until = flag("until", null);
const tz = flag("tz", "utc");
const groupBy = flag("by", "project");

const sessionsDir = path.join(dataDir, "sessions");
const statePath = path.join(dataDir, "state", "pirouette-state.json");

/** sessionDir basename -> {project, name} from the state file, so bars can be
 *  split by project. Agents deleted from state still show up, as "unknown". */
function loadAgentIndex() {
  const index = new Map();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return index;
  }
  const agents = Array.isArray(raw.agents) ? raw.agents : Object.values(raw.agents ?? {});
  for (const a of agents) {
    if (!a?.sessionDir) continue;
    index.set(path.basename(a.sessionDir), {
      project: a.projectName ?? "unknown",
      name: a.name ?? "?",
      model: a.model ?? "unknown",
    });
  }
  return index;
}

function dayOf(iso) {
  if (tz === "utc") return iso.slice(0, 10);
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const agentIndex = loadAgentIndex();

/** day -> group -> dollars, plus per-day message counts. */
const spend = new Map();
const messages = new Map();
const groupTotals = new Map();
let scanned = 0;
let unparsable = 0;

function bucket(day, group, cost) {
  if (!spend.has(day)) spend.set(day, new Map());
  const row = spend.get(day);
  row.set(group, (row.get(group) ?? 0) + cost);
  groupTotals.set(group, (groupTotals.get(group) ?? 0) + cost);
  messages.set(day, (messages.get(day) ?? 0) + 1);
}

for (const dirent of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
  if (!dirent.isDirectory()) continue;
  const slug = dirent.name;
  const meta = agentIndex.get(slug);
  const dir = path.join(sessionsDir, slug);
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        unparsable++;
        continue;
      }
      const msg = entry.message;
      // Cost is only ever attached to a finished assistant message; user and
      // tool entries repeat no usage, so this is a clean, dedup-free pass.
      if (!msg || msg.role !== "assistant" || !msg.usage) continue;
      const cost = msg.usage.cost?.total ?? 0;
      if (!cost) continue;
      const day = dayOf(entry.timestamp ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (since && day < since) continue;
      if (until && day > until) continue;
      const group =
        groupBy === "none"
          ? "spend"
          : groupBy === "model"
            ? `${msg.provider ? `${msg.provider}/` : ""}${msg.model ?? meta?.model ?? "unknown"}`
            : (meta?.project ?? "unknown");
      bucket(day, group, cost);
      scanned++;
    }
  }
}

if (spend.size === 0) {
  console.error(`No priced assistant messages found under ${sessionsDir}`);
  process.exit(1);
}

// Fill the calendar gaps so weekends read as gaps rather than being squeezed out.
const days = [...spend.keys()].sort();
const allDays = [];
for (let d = new Date(`${days[0]}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
  const iso = d.toISOString().slice(0, 10);
  allDays.push(iso);
  if (iso === days[days.length - 1]) break;
}

// Biggest projects keep their own colour; the tail collapses into "other".
const ranked = [...groupTotals.entries()].sort((a, b) => b[1] - a[1]);
const named = ranked.slice(0, 8).map(([g]) => g);
const groups = ranked.length > named.length ? [...named, "other"] : named;
const groupOf = (g) => (named.includes(g) ? g : "other");

const stacked = allDays.map((day) => {
  const row = new Map();
  for (const [g, v] of spend.get(day) ?? []) {
    const key = groupOf(g);
    row.set(key, (row.get(key) ?? 0) + v);
  }
  return { day, row, total: [...row.values()].reduce((a, b) => a + b, 0) };
});

const grandTotal = stacked.reduce((a, d) => a + d.total, 0);
const peak = Math.max(...stacked.map((d) => d.total));

// ---- text report -----------------------------------------------------------
console.log(`sessions: ${sessionsDir}`);
console.log(`priced assistant messages: ${scanned}${unparsable ? ` (${unparsable} bad lines)` : ""}`);
console.log("");
console.log("day          spend    msgs  ");
for (const { day, total } of stacked) {
  const bar = "#".repeat(Math.round((total / peak) * 40));
  console.log(
    `${day}  ${total.toFixed(2).padStart(8)}  ${String(messages.get(day) ?? 0).padStart(6)}  ${bar}`,
  );
}
console.log("");
console.log(`total: $${grandTotal.toFixed(2)} over ${stacked.filter((d) => d.total > 0).length} active days`);
console.log(`mean active day: $${(grandTotal / Math.max(1, stacked.filter((d) => d.total > 0).length)).toFixed(2)}`);
if (groupBy !== "none") {
  console.log("");
  for (const [g, v] of ranked.slice(0, 12)) {
    console.log(`  ${g.padEnd(24)} $${v.toFixed(2).padStart(9)}  ${((v / grandTotal) * 100).toFixed(1)}%`);
  }
}

if (csvPath) {
  const header = ["day", "total_usd", "messages", ...groups].join(",");
  const rows = stacked.map(({ day, row, total }) =>
    [day, total.toFixed(4), messages.get(day) ?? 0, ...groups.map((g) => (row.get(g) ?? 0).toFixed(4))].join(","),
  );
  fs.writeFileSync(csvPath, `${header}\n${rows.join("\n")}\n`);
  console.log(`\nwrote ${csvPath}`);
}

// ---- svg -------------------------------------------------------------------
const W = Math.max(900, 90 + stacked.length * 56);
const M = { top: 70, right: 30, bottom: 110, left: 80 };
const plotW = W - M.left - M.right;
const plotH = 340;

function niceMax(v) {
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const step of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (step * mag >= v) return step * mag;
  }
  return 10 * mag;
}
const yMax = niceMax(peak);
const y = (v) => M.top + plotH - (v / yMax) * plotH;
const bandW = plotW / stacked.length;
const barW = Math.min(46, bandW * 0.68);

// Lay the legend out first: it decides how tall the image needs to be.
const legendItems = groups.map((g) => {
  const total =
    g === "other" ? ranked.slice(named.length).reduce((a, [, v]) => a + v, 0) : (groupTotals.get(g) ?? 0);
  const label = `${g} ($${total.toFixed(0)})`;
  return { g, label, width: 28 + label.length * 6.6 };
});
let legendRows = 1;
{
  let x = M.left;
  for (const item of legendItems) {
    if (x + item.width > W - M.right && x > M.left) {
      x = M.left;
      legendRows++;
    }
    x += item.width;
  }
}
const H = M.top + plotH + M.bottom + (legendRows - 1) * 18;

const palette = [
  "#4c78a8",
  "#f58518",
  "#54a24b",
  "#e45756",
  "#b279a2",
  "#72b7b2",
  "#eeca3b",
  "#9d755d",
  "#bab0ac",
];
const colour = new Map(groups.map((g, i) => [g, palette[i % palette.length]]));

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const parts = [];
parts.push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-sans-serif, -apple-system, Segoe UI, Helvetica, Arial, sans-serif">`,
);
parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
parts.push(
  `<text x="${M.left}" y="32" font-size="20" font-weight="600" fill="#1a1a1a">Pirouette agent spend by day</text>`,
);
parts.push(
  `<text x="${M.left}" y="52" font-size="13" fill="#666">$${grandTotal.toFixed(0)} total · ${allDays[0]} to ${allDays[allDays.length - 1]} · ${tz.toUpperCase()} days · stacked by ${groupBy}</text>`,
);

// gridlines + y axis
const ticks = 5;
for (let i = 0; i <= ticks; i++) {
  const v = (yMax / ticks) * i;
  const yy = y(v);
  parts.push(
    `<line x1="${M.left}" y1="${yy.toFixed(1)}" x2="${M.left + plotW}" y2="${yy.toFixed(1)}" stroke="#e6e6e6"/>`,
  );
  parts.push(
    `<text x="${M.left - 10}" y="${(yy + 4).toFixed(1)}" font-size="12" fill="#666" text-anchor="end">$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}</text>`,
  );
}

stacked.forEach(({ day, row, total }, i) => {
  const x = M.left + bandW * i + (bandW - barW) / 2;
  let cursor = 0;
  for (const g of groups) {
    const v = row.get(g) ?? 0;
    if (!v) continue;
    const top = y(cursor + v);
    const h = y(cursor) - top;
    parts.push(
      `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" fill="${colour.get(g)}"><title>${esc(day)} · ${esc(g)} · $${v.toFixed(2)}</title></rect>`,
    );
    cursor += v;
  }
  if (total > 0) {
    parts.push(
      `<text x="${(x + barW / 2).toFixed(1)}" y="${(y(total) - 6).toFixed(1)}" font-size="11" fill="#333" text-anchor="middle">${total >= 1000 ? `$${(total / 1000).toFixed(1)}k` : `$${total.toFixed(0)}`}</text>`,
    );
  }
  const label = day.slice(5);
  parts.push(
    `<text x="${(x + barW / 2).toFixed(1)}" y="${M.top + plotH + 18}" font-size="11" fill="#444" text-anchor="middle">${label}</text>`,
  );
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${day}T00:00:00Z`).getUTCDay()];
  parts.push(
    `<text x="${(x + barW / 2).toFixed(1)}" y="${M.top + plotH + 32}" font-size="10" fill="#999" text-anchor="middle">${dow}</text>`,
  );
});

parts.push(
  `<line x1="${M.left}" y1="${M.top + plotH}" x2="${M.left + plotW}" y2="${M.top + plotH}" stroke="#333"/>`,
);

// legend, wrapping onto extra rows when the projects don't fit on one line
let lx = M.left;
let ly = H - 34 - (legendRows - 1) * 18;
for (const item of legendItems) {
  if (lx + item.width > W - M.right && lx > M.left) {
    lx = M.left;
    ly += 18;
  }
  parts.push(`<rect x="${lx.toFixed(1)}" y="${ly - 9}" width="11" height="11" rx="2" fill="${colour.get(item.g)}"/>`);
  parts.push(`<text x="${(lx + 17).toFixed(1)}" y="${ly}" font-size="12" fill="#333">${esc(item.label)}</text>`);
  lx += item.width;
}

parts.push("</svg>");
fs.writeFileSync(outPath, parts.join("\n"));
console.log(`\nwrote ${outPath}`);
