// /up — the always-on degradation page.
//
// Welld serves this directly. No agent, no SQLite, no Convex, no cell.
// When the rich wells.cells.md dashboard is asleep, hibernating, or broken,
// /up still answers — that's the load-bearing part. Self-contained HTML,
// no external CSS or JS, ~1 KB on the wire.

export interface UpData {
  version: string;
  wells_count: number;
  uptime: string;         // human-readable, e.g. "5h 12m"
  degraded: boolean;
  respawns_last_hour: number;
}

export function renderUpHtml(d: UpData): string {
  const status = d.degraded ? "degraded" : "up";
  const statusColor = d.degraded ? "#b8541a" : "#2f7d4f";
  const note = d.degraded
    ? `vwell has bounced ${d.respawns_last_hour}× this hour — fragile`
    : "everything operational on the substrate";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>wells · ${status}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body {
    background: #faf8f4; color: #21201c;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    line-height: 1.5; margin: 0; padding: 0; font-size: 16px;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #eee; }
    .ground { border-top-color: #444; color: #aaa; }
  }
  .wrap { max-width: 540px; margin: 8vh auto; padding: 0 24px; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.02em; }
  .dot { color: ${statusColor}; }
  .status { color: ${statusColor}; font-weight: 600; }
  .row { display: flex; gap: 10px; padding: 9px 0; border-bottom: 1px solid #ddd8ca; font-size: 14px; }
  .row .k { width: 110px; color: #8a8578; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
  .row .v { font-variant-numeric: tabular-nums; }
  .note { margin: 10px 0 18px; font-size: 13.5px; color: #5a564c; }
  .ground { margin-top: 24px; padding-top: 14px; border-top: 1px solid #ddd8ca; font-size: 12.5px; color: #8a8578; }
  a { color: #1e6f5c; }
</style>
</head>
<body>
<div class="wrap">
  <h1>wells<span class="dot">.</span></h1>
  <p class="note">substrate is <span class="status">${status}</span> — ${esc(note)}</p>
  <div class="row"><div class="k">welld</div><div class="v">v${esc(d.version)}</div></div>
  <div class="row"><div class="k">wells</div><div class="v">${d.wells_count}</div></div>
  <div class="row"><div class="k">uptime</div><div class="v">${esc(d.uptime)}</div></div>
  <div class="ground">
    The rich dashboard at <code>wells.cells.md</code> lives inside a cell. If you're seeing this page
    instead, that cell is asleep, hibernating, or unreachable — welld is still healthy and answering.
    This page is served by welld directly with no dependencies.
  </div>
</div>
</body>
</html>
`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}
