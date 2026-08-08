/**
 * The trace page's own markup, styles, and view code — kept apart from the
 * journal→data mapping in trace.ts so neither file is mostly a string literal.
 * The timeline itself is vis-timeline (vendored and inlined at render time, so
 * a trace works offline and inside a strict CSP).
 */

export const STYLES = String.raw`
  :root {
    color-scheme: light dark;
    --surface: #fbfbfa; --panel: #ffffff; --rule: #e3e4e2; --rule-strong: #cfd1ce;
    --ink: #16181d; --ink-2: #4a4f58; --ink-3: #7b8189;
    --reasoner: #3b6fe0; --verification: #0e9b94; --worker: #8b5cf6; --technician: #d97706;
    --pass: #157f3b; --fail: #c2321f; --lost: #7b8189;
    --shadow: 0 1px 2px rgba(20,22,26,.06), 0 8px 24px -18px rgba(20,22,26,.5);
    --display: ui-serif, "Iowan Old Style", "Charter", Georgia, serif;
    --body: system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface: #14161a; --panel: #1a1d22; --rule: #2a2e35; --rule-strong: #3b4048;
      --ink: #eceef1; --ink-2: #b3b9c2; --ink-3: #848b95;
      --reasoner: #4a7fe8; --verification: #0e9c90; --worker: #8a6fe0; --technician: #c97a08;
      --pass: #35a15c; --fail: #e0604c; --lost: #848b95;
      --shadow: 0 1px 2px rgba(0,0,0,.5), 0 10px 30px -20px rgba(0,0,0,.9);
    }
  }
  :root[data-theme="light"] {
    --surface: #fbfbfa; --panel: #ffffff; --rule: #e3e4e2; --rule-strong: #cfd1ce;
    --ink: #16181d; --ink-2: #4a4f58; --ink-3: #7b8189;
    --reasoner: #3b6fe0; --verification: #0e9b94; --worker: #8b5cf6; --technician: #d97706;
    --pass: #157f3b; --fail: #c2321f; --lost: #7b8189;
  }
  :root[data-theme="dark"] {
    --surface: #14161a; --panel: #1a1d22; --rule: #2a2e35; --rule-strong: #3b4048;
    --ink: #eceef1; --ink-2: #b3b9c2; --ink-3: #848b95;
    --reasoner: #4a7fe8; --verification: #0e9c90; --worker: #8a6fe0; --technician: #c97a08;
    --pass: #35a15c; --fail: #e0604c; --lost: #848b95;
  }

  body { margin: 0; background: var(--surface); color: var(--ink); font-family: var(--body); font-size: 15px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1240px; margin: 0 auto; padding: 40px 24px 72px; display: flex; flex-direction: column; gap: 26px; }
  header { display: flex; flex-direction: column; gap: 9px; border-bottom: 1px solid var(--rule); padding-bottom: 20px; }
  .eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: .13em; text-transform: uppercase; color: var(--ink-3); }
  h1 { font-family: var(--display); font-weight: 600; font-size: clamp(26px, 3.6vw, 37px); line-height: 1.13; margin: 0; text-wrap: balance; letter-spacing: -.01em; }
  .sub { color: var(--ink-2); max-width: 68ch; margin: 0; }
  .sub code { font-family: var(--mono); font-size: .87em; color: var(--ink); }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(126px, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); border-radius: 3px; overflow: hidden; }
  .tile { background: var(--panel); padding: 13px 15px; display: flex; flex-direction: column; gap: 2px; }
  .tile .n { font-family: var(--mono); font-size: 24px; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
  .tile .l { font-size: 11.5px; color: var(--ink-3); }
  .tile .l.dim { opacity: .74; }

  .panel { background: var(--panel); border: 1px solid var(--rule); border-radius: 3px; box-shadow: var(--shadow); }
  .panel-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 12px; padding: 15px 18px 12px; border-bottom: 1px solid var(--rule); }
  h2 { font-family: var(--display); font-size: 18px; font-weight: 600; margin: 0; }
  .note { font-size: 12.5px; color: var(--ink-3); margin: 0; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

  .legend { display: flex; flex-wrap: wrap; gap: 13px; font-size: 12.5px; color: var(--ink-2); padding: 10px 18px; border-top: 1px solid var(--rule); }
  .key { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 11px; height: 11px; border-radius: 2px; flex: none; }
  .swatch.hollow { background: transparent; border: 1.5px dashed var(--lost); }
  .swatch.dot { border-radius: 50%; }

  button.ctl { font-family: var(--mono); font-size: 11.5px; letter-spacing: .04em; background: transparent; color: var(--ink-2); border: 1px solid var(--rule-strong); border-radius: 2px; padding: 5px 10px; cursor: pointer; }
  button.ctl:hover { color: var(--ink); border-color: var(--ink-3); }
  button.ctl:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  button.ctl[aria-pressed="true"] { color: var(--ink); border-color: var(--ink-3); background: color-mix(in oklab, var(--ink) 7%, transparent); }

  /* vis-timeline, themed through our tokens */
  #tl { padding: 4px 6px 0; }
  .vis-timeline { border: none; font-family: var(--body); font-size: 12.5px; color: var(--ink-2); }
  .vis-panel.vis-center, .vis-panel.vis-left, .vis-panel.vis-right, .vis-panel.vis-top, .vis-panel.vis-bottom { border-color: var(--rule); }
  .vis-time-axis .vis-text { color: var(--ink-3); font-family: var(--mono); font-size: 10.5px; }
  .vis-time-axis .vis-grid.vis-minor { border-color: var(--rule); }
  .vis-time-axis .vis-grid.vis-major { border-color: var(--rule-strong); }
  .vis-labelset .vis-label { color: var(--ink-2); font-family: var(--mono); font-size: 11px; border-bottom: 1px solid var(--rule); }
  .vis-labelset .vis-label .vis-inner { padding: 5px 8px; }
  .vis-foreground .vis-group { border-bottom: 1px solid var(--rule); }
  .vis-item { border-radius: 2px; border-width: 1px; color: #fff; font-family: var(--mono); font-size: 10.5px; }
  .vis-item.vis-range { border-color: transparent; }
  .vis-item .vis-item-content { padding: 1px 5px; }
  .vis-item.vis-selected { box-shadow: 0 0 0 2px var(--ink); border-color: transparent; }
  .vis-item.role-reasoner { background: var(--reasoner); }
  .vis-item.role-worker { background: var(--worker); }
  .vis-item.role-technician { background: var(--technician); }
  .vis-item.role-verification { background: var(--verification); }
  .vis-item.lost { background: transparent; border: 1.5px dashed var(--lost); color: var(--ink-3); }
  .vis-item.vis-point.stage .vis-dot { border-width: 5px; }
  .vis-item.stage-pass .vis-dot { border-color: var(--pass); }
  .vis-item.stage-fail .vis-dot { border-color: var(--fail); }
  .vis-item.stage-none .vis-dot { border-color: var(--ink-3); }
  .vis-item.vis-point .vis-item-content { color: var(--ink-2); }
  .vis-item.vis-background.wake { background: color-mix(in oklab, var(--ink) 6%, transparent); }
  .vis-item.vis-point.gapmark { color: color-mix(in oklab, var(--ink) 55%, transparent); font-style: italic; }
  .vis-tooltip { font-family: var(--body) !important; font-size: 12.5px !important; background: var(--panel) !important; color: var(--ink) !important; border: 1px solid var(--rule-strong) !important; border-radius: 3px !important; box-shadow: var(--shadow) !important; padding: 9px 11px !important; max-width: 340px !important; white-space: normal !important; }
  .vis-tooltip .t-mono { font-family: var(--mono); font-size: 11.5px; color: var(--ink-3); }
  .vis-tooltip .t-task { color: var(--ink-2); margin-top: 4px; }
  .vis-current-time { background-color: transparent; }

  .inspect { display: grid; grid-template-columns: 190px 1fr; gap: 0 18px; padding: 16px 18px 20px; border-top: 1px solid var(--rule); font-size: 13.5px; }
  .inspect .k { font-family: var(--mono); font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-3); padding: 7px 0 0; }
  .inspect .v { padding: 5px 0; color: var(--ink); min-width: 0; }
  .inspect .v.mono { font-family: var(--mono); font-size: 12px; color: var(--ink-2); overflow-wrap: anywhere; }
  .inspect .v pre { margin: 4px 0 0; padding: 10px 12px; background: var(--surface); border: 1px solid var(--rule); border-radius: 3px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 300px; overflow-y: auto; font-family: var(--mono); font-size: 12px; line-height: 1.5; color: var(--ink-2); }
  .inspect .absent { color: var(--ink-3); font-style: italic; }
  .inspect .pill { display: inline-block; font-family: var(--mono); font-size: 10.5px; padding: 2px 7px; border-radius: 10px; border: 1px solid var(--rule-strong); color: var(--ink-2); }
  .empty-inspect { padding: 16px 18px; color: var(--ink-3); font-size: 13px; border-top: 1px solid var(--rule); }
  .status { font-family: var(--mono); font-size: 11px; color: var(--ink-3); }

  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  caption { text-align: left; padding: 11px 14px; color: var(--ink-3); font-size: 12.5px; }
  th, td { text-align: left; padding: 7px 14px; border-bottom: 1px solid var(--rule); }
  th { font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); font-weight: 500; }
  td.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  .verdict { font-family: var(--mono); font-size: 11.5px; }
  .verdict.p { color: var(--pass); }
  .verdict.f { color: var(--fail); }
  .scroll-x { overflow-x: auto; }
  .hidden { display: none; }

  .findings { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 18px; }
  .finding { display: flex; flex-direction: column; gap: 5px; }
  .finding h3 { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); margin: 0; font-weight: 500; }
  .finding p { margin: 0; font-size: 13.5px; color: var(--ink-2); }
  .finding b { color: var(--ink); font-weight: 600; }
  footer { color: var(--ink-3); font-size: 12.5px; border-top: 1px solid var(--rule); padding-top: 15px; }
  @media (prefers-reduced-motion: reduce) { * { animation-duration: .001ms !important; transition-duration: .001ms !important; } }
`;

export const BODY = String.raw`
<div class="wrap">
  <header>
    <div class="eyebrow">Coverify &middot; campaign trace</div>
    <h1>__TITLE__</h1>
    <p class="sub">Every dispatch, verification call, and coordinator wake recorded in
      <code>__JOURNAL__</code>. __WINDOW__. Bars are agent lifetimes; the coordinator sits between them,
      waking only when work lands. Drag to pan, ctrl/&#8984;-scroll to zoom.</p>
  </header>

  <section class="tiles" id="tiles"></section>

  <section class="panel">
    <div class="panel-head">
      <div>
        <h2>Agent lifetimes and verification calls</h2>
        <p class="note" id="hint">Shaded bands mark coordinator wakes (hover for live/report counts;
          the band's width is a fixed marker, not the turn's duration).</p>
        <p class="note" id="gapnote"></p>
      </div>
      <div class="controls">
        <button class="ctl" id="fit">Fit all</button>
        <button class="ctl" id="byRole" aria-pressed="false">Group by role</button>
      </div>
    </div>
    <div id="tl"></div>
    <div class="legend" id="legend"></div>
    <div id="inspect" class="empty-inspect">Click any bar or mark to inspect it &mdash; the packet it was given, its
      model, and its report.</div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>The same trace as a table</h2>
      <button class="ctl" id="tableToggle" aria-expanded="false" aria-controls="tableWrap">Show table</button>
    </div>
    <div id="tableWrap" class="hidden scroll-x"></div>
  </section>

  <section class="findings" id="findings"></section>

  <footer>Rendered by <code>coverify trace</code> from the campaign's own append-only journal &mdash; harness
    audit metadata, never campaign state. Times are UTC.</footer>
</div>
`;

export const VIEW = String.raw`
(() => {
  const H = 3600;
  const base = Date.parse(DATA.t0);
  const ms = (t) => base + t * 1000;
  const agents = DATA.agents.slice().sort((a, b) => a.start - b.start);
  const ev = DATA.events;
  const wakes = ev.filter((e) => e.type === "wake");
  const verifies = ev.filter((e) => e.type === "verify");
  const gates = ev.filter((e) => e.type === "gate");
  const proms = ev.filter((e) => e.type === "promotion");
  // "Reported back" means a report exists. A cancelled run and an
  // infrastructure failure both have an end time and no report; counting them
  // as completions inflates the tile and poisons the lifetime stats.
  const ended = agents.filter((a) => a.end != null);
  const done = ended.filter((a) => !a.cancelled && a.failed == null);
  const stopped = ended.filter((a) => a.cancelled || a.failed != null);
  const openAgents = agents.filter((a) => a.end == null);
  const ROLES = {
    reasoner: "Reasoner", technician: "Technician", verification: "Verification",
    "gate-critic": "Gate critic", worker: "Worker (pre-rename)",
  };
  const roleOf = (a) => (ROLES[a.role] ? a.role : "worker");
  const multiDay = DATA.span > 86400;
  const clock = (t) => {
    const iso = new Date(ms(t)).toISOString();
    return multiDay ? iso.slice(5, 16).replace("T", " ") + "Z" : iso.slice(11, 16) + "Z";
  };
  const fmtH = (h) => (h < 1 ? Math.round(h * 60) + "m" : h.toFixed(1) + "h");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const STAGE = { audit: "hostile audit", "bundle-cert": "bundle certification", reconstruction: "blind reconstruction", comparison: "comparison" };

  // ---- summary tiles ----
  const med = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const lifetimes = done.map((a) => (a.end - a.start) / H);
  const verdicts = verifies.filter((v) => v.verdict);
  const tiles = [
    ["Agents dispatched", agents.length, Object.keys(ROLES).filter((r) => agents.some((a) => roleOf(a) === r)).map((r) => ROLES[r].toLowerCase()).join(", ")],
    ["Reported back", done.length,
      [stopped.length ? stopped.length + " cancelled/failed" : "",
       openAgents.length ? openAgents.length + " with no completion record" : ""].filter(Boolean).join(", ") || "all accounted for"],
    ["Median lifetime", lifetimes.length ? fmtH(med(lifetimes)) : "&mdash;", lifetimes.length ? "longest " + fmtH(Math.max(...lifetimes)) : ""],
    ["Coordinator wakes", wakes.length, "event-driven, never polling"],
    ["Verification calls", verifies.length,
      verdicts.filter((v) => v.verdict === "FAIL").length + " FAIL of " + verdicts.length + " verdicts"],
    ["Idea gates", gates.length, gates.filter((g) => g.verdict === "IDEA PASS").length + " passed"],
    ["Promotions", proms.length, "reached PROVED.md"],
  ];
  // Campaign-shape metrics (issue #15): ledger-citation coverage of worker
  // artifacts, and worker-idle share of the dispatch window.
  const M = DATA.metrics;
  if (M.citation) {
    tiles.push(["Cited by ledgers", M.citation.cited + "/" + M.citation.workers,
      M.citation.orphaned.length
        ? M.citation.orphaned.length + " uncited: " + esc(M.citation.orphaned.join(", "))
        : "every report is cited"]);
  }
  if (M.idle && M.idle.windowSec > 0) {
    tiles.push(["Workers idle", Math.round((M.idle.idleSec / M.idle.windowSec) * 100) + "%",
      M.idle.largestGapsSec.length
        ? "largest gap " + fmtH(M.idle.largestGapsSec[0] / H)
        : "no gaps in the worker window"]);
  }
  document.getElementById("tiles").innerHTML = tiles
    .map(([l, n, s]) => '<div class="tile"><span class="n">' + n + '</span><span class="l">' + l + '</span><span class="l dim">' + s + "</span></div>")
    .join("");

  // ---- timeline items ----
  const items = [];
  const groups = [];
  const usedRoles = [...new Set(agents.map(roleOf))];
  agents.forEach((a, i) => {
    const role = roleOf(a);
    const lost = a.end == null;
    const end = lost ? a.start + 90 : a.end;
    items.push({
      id: "a" + i,
      group: "agents",
      subgroup: role,
      start: ms(a.start),
      end: ms(end),
      type: "range",
      className: "role-" + role + (lost ? " lost" : ""),
      content: a.id,
      kind: "agent",
      role,
      agent: a,
      title:
        "<strong class='t-mono'>" + esc(a.id) + "</strong> " + ROLES[role] +
        "<div class='t-mono'>" + clock(a.start) + " &rarr; " +
        (lost ? "no completion recorded (still running, or lost to a restart)" : clock(a.end) + " &middot; " + fmtH((a.end - a.start) / H)) + "</div>" +
        (a.mechanism ? "<div class='t-task'><b>" + esc(a.mechanism) + "</b></div>" : "") +
        (a.task ? "<div class='t-task'>" + esc(a.task.slice(0, 150)) + (a.task.length > 150 ? "&hellip;" : "") + "</div>" : "") +
        "<div class='t-mono'>click to inspect</div>",
    });
  });
  verifies.forEach((v, i) => {
    const cls = v.verdict === "PASS" ? "stage-pass" : v.verdict === "FAIL" ? "stage-fail" : "stage-none";
    items.push({
      id: "v" + i,
      group: "verify",
      start: ms(v.t),
      type: "point",
      className: "stage " + cls,
      content: "",
      kind: "verify",
      ev: v,
      title:
        "<strong>" + STAGE[v.stage] + "</strong>" +
        "<div class='t-mono'>" + esc(v.revision) + " &middot; " + clock(v.t) + "</div>" +
        (v.verdict ? "<div class='t-task'>verdict " + v.verdict + "</div>" : "") +
        (v.model ? "<div class='t-mono'>" + esc(v.model) + "</div>" : ""),
    });
  });
  gates.forEach((g, i) => {
    items.push({
      id: "g" + i,
      group: "gates",
      start: ms(g.t),
      type: "point",
      className: "stage " + (g.verdict === "IDEA PASS" ? "stage-pass" : g.verdict === "IDEA FAIL" ? "stage-fail" : "stage-none"),
      content: "",
      kind: "gate",
      ev: g,
      title: "<strong>" + esc(g.verdict) + "</strong><div class='t-mono'>" + clock(g.t) + "</div><div class='t-task'>" + esc(g.mechanism) + "&hellip;</div>",
    });
  });
  proms.forEach((p, i) => {
    items.push({
      id: "p" + i,
      group: "gates",
      start: ms(p.t),
      type: "point",
      className: "stage stage-pass",
      content: "promoted " + esc(p.revision),
      kind: "promotion",
      ev: p,
      title: "<strong>promotion</strong><div class='t-mono'>" + esc(p.revision) + " &middot; " + clock(p.t) + "</div>",
    });
  });
  wakes.forEach((w, i) => {
    items.push({
      id: "w" + i,
      start: ms(w.t),
      end: ms(w.t + 60),
      type: "background",
      className: "wake",
      content: "",
      kind: "wake",
      ev: w,
      title: "<strong>wake " + w.n + "</strong><div class='t-mono'>" + clock(w.t) + " &middot; " + w.live + " live &middot; " + w.reports + " new report(s)</div>",
    });
  });

  const flatGroups = [
    { id: "agents", content: "dispatched agents" },
    { id: "verify", content: "verification stages" },
    { id: "gates", content: "idea gates & promotions" },
  ];
  const roleGroups = usedRoles.map((r) => ({ id: r, content: ROLES[r].toLowerCase() }))
    .concat([{ id: "verify", content: "verification stages" }, { id: "gates", content: "idea gates & promotions" }]);

  // ---- idle-gap compression ----
  // Long stretches with no events (harness stopped, overnight pauses)
  // otherwise dominate the axis and flatten all activity into slivers.
  // Gaps > 20 min are hidden (vis-timeline hiddenDates), keeping 60s of
  // margin on each side, with a labeled marker at each cut.
  const stamps = [];
  items.forEach((it) => {
    if (it.start != null) stamps.push(+it.start);
    if (it.end != null) stamps.push(+it.end);
  });
  stamps.sort((a, b) => a - b);
  const GAP_MS = 20 * 60 * 1000, KEEP_MS = 60 * 1000;
  const hiddenDates = [];
  let hiddenMs = 0;
  for (let i = 1; i < stamps.length; i++) {
    const a = stamps[i - 1], b = stamps[i];
    if (b - a > GAP_MS + 2 * KEEP_MS) {
      hiddenDates.push({ start: a + KEEP_MS, end: b - KEEP_MS });
      hiddenMs += b - a - 2 * KEEP_MS;
      items.push({
        id: "gap" + i,
        start: a + KEEP_MS,
        type: "point",
        group: "gates",
        className: "gapmark",
        content: "&#8987; " + fmtH((b - a) / 3600000) + " idle (collapsed)",
        title: "<strong>idle gap collapsed</strong><div class='t-mono'>" + fmtH((b - a) / 3600000) + " with no journal events</div>",
        kind: "gap",
      });
    }
  }
  const gapNote = document.getElementById("gapnote");
  if (gapNote && hiddenDates.length > 0) {
    gapNote.textContent = hiddenDates.length + " idle gap(s) collapsed (" + fmtH(hiddenMs / 3600000) + " hidden); drag or shift-scroll to pan, ctrl-scroll to zoom";
  }

  const container = document.getElementById("tl");
  const dataset = new vis.DataSet(items);
  const groupSet = new vis.DataSet(flatGroups);
  const pad = Math.max(DATA.span * 0.02, 120) * 1000;
  const options = {
    hiddenDates: hiddenDates,
    // Pan when zoomed: plain wheel/trackpad scrolls the time axis
    // horizontally (vertical stays on the group panel's own scrollbar);
    // ctrl+wheel zooms, drag pans too.
    horizontalScroll: true,
    stack: true,
    stackSubgroups: true,
    showCurrentTime: false,
    verticalScroll: true,
    maxHeight: 560,
    zoomKey: "ctrlKey",
    orientation: { axis: "top" },
    margin: { item: { vertical: 3, horizontal: 0 }, axis: 6 },
    min: ms(0) - pad,
    max: ms(DATA.span) + pad,
    start: ms(0) - pad,
    end: ms(DATA.span) + pad,
    zoomMin: 60 * 1000,
    tooltip: { followMouse: true, overflowMethod: "cap", delay: 60 },
    template: (item) => item.content || "",
  };
  const timeline = new vis.Timeline(container, dataset, groupSet, options);

  // ---- inspector ----
  const box = document.getElementById("inspect");
  const row = (k, v, cls) => '<div class="k">' + k + '</div><div class="v ' + (cls || "") + '">' + v + "</div>";
  const absent = (why) => '<span class="absent">' + why + "</span>";
  const block = (s) => "<pre>" + esc(s) + "</pre>";
  // Packet fields older harness revisions never journaled; say that plainly
  // rather than rendering an empty box.
  const NOT_RECORDED = "not recorded by the harness revision that ran this campaign";

  function inspectAgent(a) {
    const role = roleOf(a);
    const lost = a.end == null;
    const parts = [
      row("agent", "<b>" + esc(a.id) + "</b> &middot; " + ROLES[role] + (a.cancelled ? ' <span class="pill">cancelled</span>' : "") + (a.failed ? ' <span class="pill">failed: ' + esc(a.failed) + "</span>" : "")),
      row("window", clock(a.start) + " &rarr; " + (lost ? absent("no completion recorded (lost to a restart)") : clock(a.end) + " &middot; " + fmtH((a.end - a.start) / H)), "mono"),
      row("model", a.model ? esc(a.model) : absent(NOT_RECORDED), "mono"),
      row("mechanism", a.mechanism ? esc(a.mechanism) : absent("none")),
      row("task", a.task ? block(a.task) : absent(NOT_RECORDED)),
      row("deliverable", a.deliverable ? block(a.deliverable) : absent(NOT_RECORDED)),
      row("context", a.context ? block(a.context) : absent(NOT_RECORDED)),
      row("FAILED.md check", a.failedCheck ? esc(a.failedCheck) : absent(NOT_RECORDED)),
    ];
    if (a.computation) parts.push(row("preregistered computation", block(a.computation)));
    if (a.literature) parts.push(row("literature question", block(a.literature)));
    parts.push(row("evidence", a.evidenceDir ? esc(a.evidenceDir) + "/" : absent(NOT_RECORDED), "mono"));
    parts.push(row("report", a.report
      ? esc(a.report)
      : a.failed != null
        ? absent("infrastructure failure: " + esc(a.failed) + " &mdash; no report artifact by design")
        : a.cancelled
          ? absent("cancelled before it reported")
          : lost
            ? absent("no report yet")
            : absent("not recorded"), "mono"));
    if (a.reportText) parts.push(row("report text", block(a.reportText)));
    box.className = "inspect";
    box.innerHTML = parts.join("");
  }

  function inspectEvent(item) {
    const e = item.ev;
    const parts = [];
    if (item.kind === "verify") {
      parts.push(row("stage", "<b>" + STAGE[e.stage] + "</b>" + (e.verdict ? ' <span class="pill">' + e.verdict + "</span>" : "")));
      parts.push(row("candidate", esc(e.revision), "mono"));
      parts.push(row("recorded", clock(e.t), "mono"));
      parts.push(row("verifier model", e.model ? esc(e.model) : absent(NOT_RECORDED), "mono"));
      parts.push(row("note", "This is one call inside a verification cadence. In current runs the cadence " +
        "itself is a dispatched agent (v###) and appears in the agents lane; these marks are the verdicts it recorded."));
    } else if (item.kind === "gate") {
      parts.push(row("idea gate", "<b>" + esc(e.verdict) + "</b>"));
      parts.push(row("recorded", clock(e.t), "mono"));
      parts.push(row("mechanism", block(e.mechanism)));
    } else if (item.kind === "promotion") {
      parts.push(row("promotion", "<b>" + esc(e.revision) + "</b>"));
      parts.push(row("recorded", clock(e.t), "mono"));
    }
    box.className = "inspect";
    box.innerHTML = parts.join("");
  }

  function inspect(id, scroll) {
    const item = dataset.get(id);
    if (!item) return false;
    if (item.kind === "agent") inspectAgent(item.agent);
    else inspectEvent(item);
    if (scroll !== false) box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return true;
  }
  timeline.on("select", (props) => {
    const id = props.items && props.items[0];
    if (id != null) inspect(id);
  });
  // Small handle for scripting the view (and for the render test).
  window.coverifyTrace = { timeline, dataset, inspect, data: DATA };

  document.getElementById("fit").addEventListener("click", () => timeline.fit({ animation: false }));
  const byRole = document.getElementById("byRole");
  byRole.addEventListener("click", () => {
    const on = byRole.getAttribute("aria-pressed") !== "true";
    byRole.setAttribute("aria-pressed", String(on));
    dataset.update(items.filter((i) => i.kind === "agent").map((i) => ({ id: i.id, group: on ? i.role : "agents", subgroup: on ? undefined : i.role })));
    groupSet.clear();
    groupSet.add(on ? roleGroups : flatGroups);
  });

  // ---- legend ----
  document.getElementById("legend").innerHTML =
    usedRoles.map((r) => '<span class="key"><span class="swatch" style="background:var(--' + r + ')"></span>' + ROLES[r] + "</span>").join("") +
    '<span class="key"><span class="swatch hollow"></span>No completion recorded</span>' +
    '<span class="key"><span class="swatch dot" style="background:var(--pass)"></span>PASS</span>' +
    '<span class="key"><span class="swatch dot" style="background:var(--fail)"></span>FAIL</span>' +
    '<span class="key"><span class="swatch dot" style="background:var(--ink-3)"></span>repair / no verdict</span>';

  // ---- table view (accessibility + copy/paste) ----
  const agentRows = agents.map((a) =>
    "<tr><td class='num'>" + a.id + "</td><td>" + ROLES[roleOf(a)] + "</td><td class='num'>" + clock(a.start) +
    "</td><td class='num'>" + (a.end == null ? "&mdash;" : clock(a.end)) + "</td><td class='num'>" +
    (a.end == null ? "no completion" : fmtH((a.end - a.start) / H)) + "</td><td>" + esc(a.mechanism) + "</td></tr>").join("");
  const verifyRows = verifies.map((v) =>
    "<tr><td class='num'>" + clock(v.t) + "</td><td>" + STAGE[v.stage] + "</td><td class='num'>" + esc(v.revision) +
    "</td><td class='verdict " + (v.verdict === "PASS" ? "p" : v.verdict === "FAIL" ? "f" : "") + "'>" + (v.verdict || "&mdash;") + "</td></tr>").join("");
  document.getElementById("tableWrap").innerHTML =
    "<table><caption>Agents</caption><thead><tr><th>ID</th><th>Role</th><th>Start</th><th>End</th><th>Alive</th><th>Mechanism</th></tr></thead><tbody>" + agentRows + "</tbody></table>" +
    "<table style='margin-top:18px'><caption>Verification calls</caption><thead><tr><th>Time</th><th>Stage</th><th>Revision</th><th>Verdict</th></tr></thead><tbody>" + verifyRows + "</tbody></table>";
  const tbtn = document.getElementById("tableToggle");
  tbtn.addEventListener("click", () => {
    const hidden = document.getElementById("tableWrap").classList.toggle("hidden");
    tbtn.textContent = hidden ? "Show table" : "Hide table";
    tbtn.setAttribute("aria-expanded", String(!hidden));
  });

  // ---- what the trace shows ----
  const gaps = wakes.slice(1).map((w, i) => (w.t - wakes[i].t) / H);
  const failPct = verdicts.length ? Math.round((verdicts.filter((v) => v.verdict === "FAIL").length / verdicts.length) * 100) : 0;
  const lost = openAgents.length;
  const findings = [
    ["Where the calls went", "<b>" + verifies.length + " verification calls</b> against " + agents.length +
      " dispatches &mdash; the cadence, not exploration, is where a campaign spends itself. " + failPct +
      "% of verdicts were FAIL, and each one costs a fresh revision plus a re-run."],
    ["Work outlives the wakes", gaps.length
      ? "The longest quiet stretch between coordinator wakes was <b>" + fmtH(Math.max(...gaps)) +
        "</b>. Agents ran through it; the coordinator was asleep, not polling."
      : "Only one wake is on record."],
  ];
  if (lost > 0) {
    findings.push(["Dispatches without a completion", "<b>" + lost + " of " + agents.length +
      "</b> dispatches have no completion record: they were either still running when this trace was " +
      "taken, or lost to a restart. The harness surfaces the same list at the next wake, where " +
      "genuinely lost work can be re-dispatched."]);
  }
  document.getElementById("findings").innerHTML = findings
    .map(([h, p]) => '<div class="finding"><h3>' + h + "</h3><p>" + p + "</p></div>").join("");

})();
`;
