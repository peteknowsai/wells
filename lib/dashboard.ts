// Operator dashboard — visibility-only surface at localhost:7878/dashboard.
//
// Two exports:
//   - buildDashboardData() — aggregates state from healthz-equivalent
//     sources (lume stats, vz count, leases, wells list, log tail).
//     Returns a JSON-serializable object.
//   - renderDashboardHtml() — returns the self-contained HTML page. The
//     page fetches /dashboard/data every few seconds and updates the DOM
//     in place. No external CSS/JS — single artifact, ships from welld.
//
// Both are public (no bearer token). Welld binds to 127.0.0.1, so the
// dashboard is local-only by construction. Anyone with shell access on
// the host can read /var/db/dhcpd_leases and welld.log directly anyway.

import { LumeClient, type VMSummary } from "../engine/vwell.ts";
import { lumeRespawnStats } from "../engine/lumeProcess.ts";
import { countVzXpcProcesses } from "./vzXpcCount.ts";
import { listWells, lumeNameOf } from "./registry.ts";
import { computeOrphanLeases, dumpDhcpLeases, resolveWellIp } from "./dhcp.ts";
import { loadDefaults } from "./defaults.ts";
import { listImages, listAliases } from "./imageStore.ts";
import { PATHS } from "./state.ts";
import { readRuntime, type WellState } from "./wellRuntime.ts";
import { residentBytesByPid } from "./processMemory.ts";
import { readHostMemory } from "./hostMemory.ts";
import type { WedgeLabel } from "./wedge.ts";

export interface DashboardData {
  generated_at: string;
  daemon: {
    version: string;
    started_at: string;
    uptime_seconds: number;
    degraded: boolean;
    lume: {
      base_url: string;
      owned: boolean;
      respawns_last_hour: number;
      respawns_last_5min: number;
      respawns_last_1min: number;
    };
    vz_xpc_count: number;
  };
  // Host (Mac) memory snapshot. Both can be null on parse failure — the
  // dashboard treats null as "unknown" and labels the figure as estimated.
  host: {
    memory_total_bytes: number | null;
    memory_used_bytes: number | null;
  };
  wells: Array<{
    name: string;
    status: "running" | "stopped" | "missing";
    // Wells's own lifecycle state machine, finer-grained than `status`.
    // Distinguishes hibernating, alive_paused, restoring, error_orphaned
    // — values cells's pool-asleep model + the dashboard need. null when
    // the well has no runtime record (legacy/missing).
    runtime_state: WellState | null;
    ip: string | null;
    created_at: string;
    last_running_at: string | null;
    resident_bytes: number | null;
    // Wedge-detection label. "ok" for any well that hasn't failed the
    // SSH-banner probe enough times to cross thresholds (including
    // stopped/hibernating wells, which aren't probed).
    wedge: WedgeLabel;
  }>;
  vmnet_leases: {
    total: number;
    orphan_count: number;
    orphans: Array<{ name: string; ip: string }>;
  };
  images: Array<{
    name: string;
    aliases: string[];
    size_bytes: number | null;
    created_at: string;
    from_well: string | null;
    rinsed: boolean;
    firstboot_supports_static_ip: boolean;
  }>;
  events: string[]; // most recent first
}

export interface BuildDashboardOpts {
  version: string;
  started_at: string;
  lume_base_url: string;
  lume_owned: boolean;
  logPath?: string;
  eventLimit?: number;
  // Project welld's wedgeStates map to a per-well label. Defaults to a
  // no-op returning "ok" so tests + legacy callers keep working.
  getWedgeLabel?: (name: string) => WedgeLabel;
}

// Reverse the alias→target map so each target image carries the list of
// aliases that point at it. e.g. {"ubuntu-base": "ubuntu-25.10-base"} →
// {"ubuntu-25.10-base": ["ubuntu-base"]}. Multiple aliases per target stack.
export function invertAliasMap(
  aliases: Record<string, string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [alias, target] of Object.entries(aliases)) {
    const arr = out.get(target) ?? [];
    arr.push(alias);
    out.set(target, arr);
  }
  return out;
}

export async function buildDashboardData(
  opts: BuildDashboardOpts,
): Promise<DashboardData> {
  const lume = new LumeClient();
  const respawn = lumeRespawnStats();
  const [vzCount, vmList, wells, leases, orphans, images, aliases, rssByPid, hostMem] =
    await Promise.all([
      countVzXpcProcesses().catch(() => -1),
      lume.list().catch(() => [] as VMSummary[]),
      listWells(),
      dumpDhcpLeases(),
      computeOrphanLeases(),
      listImages().catch(() => []),
      listAliases().catch(() => ({} as Record<string, string>)),
      residentBytesByPid(),
      readHostMemory().catch(() => ({ memory_total_bytes: null, memory_used_bytes: null })),
    ]);

  const aliasesByTarget = invertAliasMap(aliases);

  const lumeByName = new Map(vmList.map((v) => [v.name, v]));
  const wellRows = await Promise.all(
    wells.map(async (s) => {
      const lv = lumeByName.get(lumeNameOf(s));
      const status =
        typeof lv?.status === "string"
          ? (lv.status as "running" | "stopped")
          : ("missing" as const);
      const rt = await readRuntime(s.name);
      const resident_bytes =
        rt?.xpc_child_pid != null
          ? (rssByPid.get(rt.xpc_child_pid) ?? null)
          : null;
      return {
        name: s.name,
        status,
        runtime_state: rt?.state ?? null,
        ip: await resolveWellIp(s.name),
        created_at: s.created_at,
        last_running_at: null,
        resident_bytes,
        wedge: (opts.getWedgeLabel ?? (() => "ok" as const))(s.name),
      };
    }),
  );

  const now = Date.now();
  const startedMs = Date.parse(opts.started_at);
  const uptime = Number.isFinite(startedMs) ? Math.max(0, Math.floor((now - startedMs) / 1000)) : 0;

  const logPath = opts.logPath ?? `${PATHS.root()}/welld.log`;
  const events = await tailLog(logPath, opts.eventLimit ?? 40);

  return {
    generated_at: new Date(now).toISOString(),
    daemon: {
      version: opts.version,
      started_at: opts.started_at,
      uptime_seconds: uptime,
      degraded: respawn.degraded,
      lume: {
        base_url: opts.lume_base_url,
        owned: opts.lume_owned,
        respawns_last_hour: respawn.totalRespawnsLastHour,
        respawns_last_5min: respawn.respawnsLast5Min,
        respawns_last_1min: respawn.respawnsLast1Min,
      },
      vz_xpc_count: vzCount,
    },
    host: hostMem,
    wells: wellRows.sort((a, b) => a.name.localeCompare(b.name)),
    vmnet_leases: {
      total: leases.length,
      orphan_count: orphans.length,
      orphans: orphans.slice(0, 50).map((l) => ({ name: l.name, ip: l.ip })),
    },
    images: images.map((m) => ({
      name: m.name,
      aliases: (aliasesByTarget.get(m.name) ?? []).sort(),
      size_bytes: typeof m.size_bytes === "number" ? m.size_bytes : null,
      created_at: m.created_at,
      from_well: m.from_well,
      rinsed: m.rinsed === true,
      firstboot_supports_static_ip: m.firstboot_supports_static_ip === true,
    })),
    events,
  };
}

// Tail the last N lines of a log file. Reads up to the last 64KiB so we
// don't fault in a multi-MB log on every dashboard poll. The newest line
// is index 0 (so the UI doesn't have to reverse client-side).
export async function tailLog(path: string, lines: number): Promise<string[]> {
  try {
    const file = Bun.file(path);
    const size = file.size;
    if (size === 0) return [];
    const cap = 64 * 1024;
    const start = size > cap ? size - cap : 0;
    const buf = await file.slice(start).text();
    const split = buf.split("\n").filter((l) => l.length > 0);
    // If we truncated mid-line, drop the leading partial.
    const clean = start > 0 ? split.slice(1) : split;
    return clean.slice(-lines).reverse();
  } catch {
    return [];
  }
}

export function renderDashboardHtml(): string {
  // Self-contained: no external CSS, no external JS. Polls /dashboard/data
  // every 4s; the page is the thinnest possible client over the JSON.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>wells dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --ok: #2d7050;
    --ok-bg: #e8f5ee;
    --warn: #b87a18;
    --warn-bg: #fff5e0;
    --err: #b13838;
    --err-bg: #fce8e8;
    --ink: #1a1a1a;
    --muted: #6a6a66;
    --bg: #fafaf8;
    --paper: #ffffff;
    --rule: #e8e7e2;
    --code-bg: #f0efec;
    --blue: #1e5a8e;
    --blue-bg: #e6f0fb;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, sans-serif;
    background: var(--bg);
    color: var(--ink);
    margin: 0;
    padding: 0;
    line-height: 1.45;
    font-size: 14px;
  }
  header {
    background: var(--paper);
    border-bottom: 1px solid var(--rule);
    padding: 14px 24px;
    display: flex;
    align-items: baseline;
    gap: 18px;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  header h1 { margin: 0; font-size: 18px; font-weight: 700; }
  header .ver { color: var(--muted); font-size: 12px; font-family: "SF Mono", Monaco, monospace; }
  header .updated { margin-left: auto; color: var(--muted); font-size: 12px; }
  main { max-width: 1180px; margin: 0 auto; padding: 20px 24px 80px; }
  .row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 14px;
    margin: 0 0 22px;
  }
  .tile {
    background: var(--paper);
    border-radius: 8px;
    padding: 14px 16px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    border: 1px solid var(--rule);
  }
  .tile h3 {
    margin: 0 0 6px;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 600;
  }
  .tile .v { font-size: 22px; font-weight: 700; line-height: 1.1; }
  .tile .sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .pill {
    display: inline-block;
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .pill.ok { background: var(--ok-bg); color: var(--ok); }
  .pill.warn { background: var(--warn-bg); color: var(--warn); }
  .pill.err { background: var(--err-bg); color: var(--err); }
  .pill.muted { background: var(--code-bg); color: var(--muted); }
  section.panel {
    background: var(--paper);
    border-radius: 8px;
    border: 1px solid var(--rule);
    padding: 0;
    margin: 0 0 22px;
    overflow: hidden;
  }
  section.panel > h2 {
    margin: 0;
    padding: 12px 16px;
    font-size: 11px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    border-bottom: 1px solid var(--rule);
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  section.panel > h2 .count { font-size: 12px; color: var(--ink); font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td {
    text-align: left;
    padding: 8px 16px;
    border-bottom: 1px solid var(--rule);
    vertical-align: middle;
  }
  th { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  td.mono, .mono { font-family: "SF Mono", Monaco, monospace; font-size: 12px; }
  td.name { font-weight: 600; }
  td.ip { color: var(--blue); }
  td.dim { color: var(--muted); }
  .events {
    max-height: 420px;
    overflow-y: auto;
    font-family: "SF Mono", Monaco, monospace;
    font-size: 11px;
    line-height: 1.45;
    padding: 0;
  }
  .events .line {
    padding: 4px 16px;
    border-bottom: 1px solid var(--rule);
    color: var(--ink);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .events .line:last-child { border-bottom: none; }
  .events .line.err { background: var(--err-bg); color: var(--err); }
  .events .line.warn { background: var(--warn-bg); color: var(--warn); }
  .empty { padding: 24px 16px; text-align: center; color: var(--muted); font-style: italic; font-size: 13px; }
  footer { text-align: center; color: var(--muted); font-size: 11px; padding: 20px 0 40px; }
  footer code { background: var(--code-bg); padding: 1px 6px; border-radius: 3px; font-family: "SF Mono", Monaco, monospace; }
</style>
</head>
<body>
<header>
  <h1>wells</h1>
  <span class="ver" id="ver">·</span>
  <span class="updated" id="updated">connecting…</span>
</header>
<main>
  <div class="row" id="health"></div>
  <section class="panel">
    <h2>Wells <span class="count" id="wells-count">·</span></h2>
    <div id="wells-body"><div class="empty">loading…</div></div>
  </section>
  <section class="panel">
    <h2>Base images <span class="count" id="images-count">·</span></h2>
    <div id="images-body"><div class="empty">loading…</div></div>
  </section>
  <section class="panel">
    <h2>vmnet leases <span class="count" id="leases-count">·</span></h2>
    <div id="leases-body"><div class="empty">loading…</div></div>
  </section>
  <section class="panel">
    <h2>Recent events <span class="count" id="events-count">·</span></h2>
    <div class="events" id="events-body"><div class="empty">loading…</div></div>
  </section>
</main>
<footer>welld dashboard · polls every 4s · <code>GET /dashboard/data</code></footer>

<script>
const POLL_MS = 4000;

function fmtUptime(s) {
  if (!Number.isFinite(s) || s < 0) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m " + (s % 60) + "s";
  return s + "s";
}

function fmtAge(iso) {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === "class") e.className = attrs[k];
    else if (k === "text") e.textContent = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  if (children) for (const c of children) e.appendChild(c);
  return e;
}

function pill(text, cls) {
  return el("span", { class: "pill " + cls, text });
}

function tile(label, value, subtext, cls) {
  const t = el("div", { class: "tile" });
  t.appendChild(el("h3", { text: label }));
  if (cls === "pill") {
    const v = el("div", { class: "v" });
    v.appendChild(pill(value.text, value.cls));
    t.appendChild(v);
  } else {
    t.appendChild(el("div", { class: "v", text: value }));
  }
  if (subtext) t.appendChild(el("div", { class: "sub", text: subtext }));
  return t;
}

function renderHealth(d) {
  const c = document.getElementById("health");
  c.innerHTML = "";

  const healthCls = d.daemon.degraded ? "err" : "ok";
  const healthText = d.daemon.degraded ? "DEGRADED" : "OK";
  c.appendChild(tile("daemon", { text: healthText, cls: healthCls }, "uptime " + fmtUptime(d.daemon.uptime_seconds), "pill"));

  const lumeText = d.daemon.lume.respawns_last_5min > 0 ? "FLAPPING" : "OK";
  const lumeCls = d.daemon.lume.respawns_last_5min > 0 ? "warn" : "ok";
  const lumeSub = "respawns: " + d.daemon.lume.respawns_last_1min + " (1m) / " + d.daemon.lume.respawns_last_5min + " (5m)";
  c.appendChild(tile("lume", { text: lumeText, cls: lumeCls }, lumeSub, "pill"));

  c.appendChild(tile("vz processes", d.daemon.vz_xpc_count >= 0 ? String(d.daemon.vz_xpc_count) : "?", "host VZ XPC count"));

  c.appendChild(tile("wells", String(d.wells.length), d.wells.filter(w => w.status === "running").length + " running"));

  const orph = d.vmnet_leases.orphan_count;
  c.appendChild(tile("leases", String(d.vmnet_leases.total), orph > 0 ? orph + " orphan(s)" : "no orphans"));

  const imgCount = d.images.length;
  const imgBytes = d.images.reduce((acc, i) => acc + (i.size_bytes || 0), 0);
  c.appendChild(tile("images", String(imgCount), imgBytes > 0 ? fmtBytes(imgBytes) + " on disk" : "—"));
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + " " + units[i];
}

function renderWells(d) {
  const c = document.getElementById("wells-body");
  document.getElementById("wells-count").textContent = String(d.wells.length);
  if (d.wells.length === 0) {
    c.innerHTML = "";
    c.appendChild(el("div", { class: "empty", text: "no wells registered" }));
    return;
  }
  const tbl = el("table");
  const head = el("tr");
  ["name", "status", "ip", "created"].forEach(h => head.appendChild(el("th", { text: h })));
  tbl.appendChild(el("thead", null, [head]));
  const body = el("tbody");
  for (const w of d.wells) {
    const row = el("tr");
    row.appendChild(el("td", { class: "name mono", text: w.name }));
    let cls = "muted";
    if (w.status === "running") cls = "ok";
    else if (w.status === "missing") cls = "err";
    const statusCell = el("td");
    statusCell.appendChild(pill(w.status, cls));
    row.appendChild(statusCell);
    row.appendChild(el("td", { class: "ip mono", text: w.ip || "—" }));
    row.appendChild(el("td", { class: "dim", text: fmtAge(w.created_at) }));
    body.appendChild(row);
  }
  tbl.appendChild(body);
  c.innerHTML = "";
  c.appendChild(tbl);
}

function renderImages(d) {
  const c = document.getElementById("images-body");
  document.getElementById("images-count").textContent = String(d.images.length);
  c.innerHTML = "";
  if (d.images.length === 0) {
    c.appendChild(el("div", { class: "empty", text: "no images" }));
    return;
  }
  const tbl = el("table");
  const head = el("tr");
  ["name", "aliases", "size", "from", "flags", "created"].forEach(h => head.appendChild(el("th", { text: h })));
  tbl.appendChild(el("thead", null, [head]));
  const body = el("tbody");
  for (const i of d.images) {
    const row = el("tr");
    row.appendChild(el("td", { class: "name mono", text: i.name }));

    const aliasCell = el("td", { class: "mono dim" });
    aliasCell.textContent = i.aliases.length ? i.aliases.join(", ") : "—";
    row.appendChild(aliasCell);

    row.appendChild(el("td", { class: "mono", text: i.size_bytes ? fmtBytes(i.size_bytes) : "—" }));
    row.appendChild(el("td", { class: "mono dim", text: i.from_well || "(prebuilt)" }));

    const flagsCell = el("td");
    if (i.rinsed) flagsCell.appendChild(pill("rinsed", "ok"));
    if (i.firstboot_supports_static_ip) {
      if (flagsCell.childNodes.length) flagsCell.appendChild(document.createTextNode(" "));
      flagsCell.appendChild(pill("static-ip", "ok"));
    }
    if (!flagsCell.childNodes.length) flagsCell.appendChild(el("span", { class: "dim", text: "—" }));
    row.appendChild(flagsCell);

    row.appendChild(el("td", { class: "dim", text: fmtAge(i.created_at) }));
    body.appendChild(row);
  }
  tbl.appendChild(body);
  c.appendChild(tbl);
}

function renderLeases(d) {
  const c = document.getElementById("leases-body");
  const total = d.vmnet_leases.total;
  const orph = d.vmnet_leases.orphan_count;
  document.getElementById("leases-count").textContent = total + " total" + (orph > 0 ? " · " + orph + " orphan" : "");
  c.innerHTML = "";
  if (orph === 0) {
    c.appendChild(el("div", { class: "empty", text: "no orphan leases" }));
    return;
  }
  const tbl = el("table");
  const head = el("tr");
  ["name", "ip"].forEach(h => head.appendChild(el("th", { text: h })));
  tbl.appendChild(el("thead", null, [head]));
  const body = el("tbody");
  for (const o of d.vmnet_leases.orphans) {
    const row = el("tr");
    row.appendChild(el("td", { class: "name mono", text: o.name }));
    row.appendChild(el("td", { class: "ip mono", text: o.ip }));
    body.appendChild(row);
  }
  tbl.appendChild(body);
  c.appendChild(tbl);
}

function classifyEvent(line) {
  const m = /"level":"(\\w+)"/.exec(line);
  if (m) {
    const lv = m[1];
    if (lv === "error" || lv === "fatal") return "err";
    if (lv === "warn") return "warn";
  }
  if (/\\bERROR\\b|\\bFAILED\\b/.test(line)) return "err";
  if (/\\bWARN\\b/.test(line)) return "warn";
  return "";
}

function renderEvents(d) {
  const c = document.getElementById("events-body");
  document.getElementById("events-count").textContent = String(d.events.length);
  c.innerHTML = "";
  if (d.events.length === 0) {
    c.appendChild(el("div", { class: "empty", text: "no recent events" }));
    return;
  }
  for (const line of d.events) {
    const cls = classifyEvent(line);
    c.appendChild(el("div", { class: "line " + cls, text: line }));
  }
}

async function poll() {
  try {
    const r = await fetch("/dashboard/data", { cache: "no-store" });
    if (!r.ok) throw new Error("status " + r.status);
    const d = await r.json();
    document.getElementById("ver").textContent = "v" + d.daemon.version;
    document.getElementById("updated").textContent = "updated " + new Date(d.generated_at).toLocaleTimeString();
    renderHealth(d);
    renderWells(d);
    renderImages(d);
    renderLeases(d);
    renderEvents(d);
  } catch (err) {
    document.getElementById("updated").textContent = "fetch failed: " + err.message;
  }
}

poll();
setInterval(poll, POLL_MS);
</script>
</body>
</html>`;
}
