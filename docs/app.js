const DATA_URL = "./data/prs.json";
const CST = 8 * 3600 * 1000;          // UTC+8
const DAY = 86400000;

const $ = (s) => document.querySelector(s);

// All PRs from the rolling snapshot
let PRS = [];
let WINDOW_DAYS = 30;

// Filter state
const state = { author: "all", range: "this_week", status: "all", start: null, end: null };

// Stable per-author color — same person gets the same color everywhere
const AUTHOR_COLORS = ["#3fb950", "#58a6ff", "#d29922", "#bc8cff", "#f78166", "#79c0ff", "#56d4dd", "#ffa657"];
function authorColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AUTHOR_COLORS[h % AUTHOR_COLORS.length];
}

// ── Icons (inlined lucide-static v1.31.0 markup — no CDN) ────
const ICONS = {
  "git-pull-request": `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>`,
  "git-merge": `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>`,
  "git-branch": `<path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>`,
  "clock": `<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`,
  "users": `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>`,
  "calendar": `<path d="M8 2v3"/><path d="M16 2v3"/><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>`,
  "external-link": `<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`,
  "bar-chart-3": `<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>`,
  "alert-triangle": `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
  "check-circle": `<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>`,
};

function iconSvg(name, cls = "") {
  const inner = ICONS[name];
  if (!inner) return "";
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// Replace declarative <i data-lucide="name" class="..."> nodes with inline SVG.
function renderIcons(root = document) {
  root.querySelectorAll("[data-lucide]").forEach((el) => {
    const name = el.getAttribute("data-lucide");
    const cls = el.getAttribute("class") || "";
    const svg = iconSvg(name, cls);
    if (svg) el.replaceWith(document.createRange().createContextualFragment(svg));
    else el.remove();
  });
}

// ── Date helpers (CST = UTC+8) ───────────────────────────────
function cstWall(date = new Date()) {
  return new Date(date.getTime() + CST); // its UTC fields == CST wall clock
}
function cstDayStartMs(wall) {
  return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()) - CST;
}
function ymdToCstMs(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - CST;
}
function cstToYmd(ms) {
  const w = cstWall(new Date(ms));
  return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, "0")}-${String(w.getUTCDate()).padStart(2, "0")}`;
}
function thisWeekRange() {
  const now = cstWall();
  const monOffset = (now.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = new Date(now.getTime() - monOffset * DAY);
  const start = cstDayStartMs(monday);
  return { start, end: start + 7 * DAY - 1 };
}
function computeRange(preset) {
  const todayStart = () => cstDayStartMs(cstWall());
  if (preset === "today") { const t = todayStart(); return { start: t, end: t + DAY - 1 }; }
  if (preset === "yesterday") { const t = todayStart() - DAY; return { start: t, end: t + DAY - 1 }; }
  if (preset === "day_before") { const t = todayStart() - 2 * DAY; return { start: t, end: t + DAY - 1 }; }
  if (preset === "this_week") return thisWeekRange();
  if (preset === "last_week") {
    const tw = thisWeekRange();
    return { start: tw.start - 7 * DAY, end: tw.start - 1 };
  }
  if (preset === "7d") return { start: Date.now() - 7 * DAY, end: Date.now() };
  if (preset === "30d") return { start: Date.now() - 30 * DAY, end: Date.now() };
  return null; // custom — uses state.start/end
}

// ── Filtering ────────────────────────────────────────────────
function authorMatch(p) {
  return state.author === "all" || p.author === state.author;
}
function inWindow(ts) {
  return ts >= state.start && ts <= state.end;
}

function compute() {
  const range = state.range === "custom"
    ? { start: state.start ?? -Infinity, end: state.end ?? Infinity }
    : computeRange(state.range);
  state.start = range.start;
  state.end = range.end;

  const merged = PRS.filter(
    (p) => p.state === "merged" && p.mergedAt && inWindow(new Date(p.mergedAt).getTime()) && authorMatch(p),
  );
  // Pending = currently open, independent of the historical range
  const pending = PRS.filter((p) => p.state === "open" && authorMatch(p));

  return { merged, pending };
}

// ── Rendering ────────────────────────────────────────────────
function render() {
  const { merged, pending } = compute();

  // Stats
  const contributors = new Set(merged.map((p) => p.author)).size;
  $("#stats-grid").innerHTML = statCard("git-merge", "Merged", merged.length, "text-merged", "bg-merged-bg")
    + statCard("clock", "Pending", pending.length, "text-pending", "bg-pending-bg")
    + statCard("users", "Contributors", contributors, "text-accent", "bg-accent/10")
    + statCardText("calendar", "范围", rangeLabel(), "text-gray-300", "bg-surface-lighter");

  $("#merged-count").textContent = merged.length;
  $("#pending-count").textContent = pending.length;

  // Section visibility by status filter
  $("#merged-section").style.display = state.status === "pending" ? "none" : "";
  $("#pending-section").style.display = state.status === "merged" ? "none" : "";

  renderPRList("#merged-list", merged, "merged");
  renderPRList("#pending-list", pending, "open");
  renderActivity(merged);
  renderContributors(merged);

  renderIcons();
}

function rangeLabel() {
  if (state.start === -Infinity || state.end === Infinity) return "自定义";
  return `${fmtMd(state.start)} ~ ${fmtMd(state.end)}`;
}
function fmtMd(ms) {
  const w = cstWall(new Date(ms));
  return `${String(w.getUTCMonth() + 1).padStart(2, "0")}/${String(w.getUTCDate()).padStart(2, "0")}`;
}

function statCard(icon, label, value, color, bg) {
  return `
    <div class="bento-card flex items-center gap-4">
      <div class="w-10 h-10 rounded-xl ${bg} ${color} stat-icon flex items-center justify-center flex-shrink-0">
        <i data-lucide="${icon}" class="w-5 h-5 ${color}"></i>
      </div>
      <div>
        <div class="text-[11px] font-medium text-gray-500 uppercase tracking-wider mb-0.5">${label}</div>
        <div class="stat-value ${color}">${value}</div>
      </div>
    </div>`;
}
function statCardText(icon, label, value, color, bg) {
  return `
    <div class="bento-card flex items-center gap-4">
      <div class="w-10 h-10 rounded-xl ${bg} ${color} stat-icon flex items-center justify-center flex-shrink-0">
        <i data-lucide="${icon}" class="w-5 h-5 ${color}"></i>
      </div>
      <div>
        <div class="text-[11px] font-medium text-gray-500 uppercase tracking-wider mb-0.5">${label}</div>
        <div class="stat-value text-gray-200 !text-lg !font-semibold">${value}</div>
      </div>
    </div>`;
}

function renderPRList(sel, prs, type) {
  const container = $(sel);
  if (prs.length === 0) {
    container.innerHTML = `
      <div class="flex items-center justify-center py-8 text-gray-600 text-sm">
        <i data-lucide="check-circle" class="w-4 h-4 mr-2"></i>
        ${type === "merged" ? "该范围无已合并 PR" : "没有进行中的 PR"}
      </div>`;
    return;
  }
  // Merged: newest first by mergedAt. Pending: oldest first (longest waiting on top).
  const sorted = [...prs].sort((a, b) =>
    type === "merged"
      ? new Date(b.mergedAt) - new Date(a.mergedAt)
      : new Date(a.createdAt) - new Date(b.createdAt),
  );

  container.innerHTML = sorted.map((pr) => prCard(pr, type)).join("");
}

function branchClass(b) {
  if (b === "main") return "branch-main";
  if (b === "release") return "branch-release";
  return "branch-other";
}

function prCard(pr, type) {
  const labels = pr.labels
    .slice(0, 3)
    .map((l) => `<span class="label-chip">${esc(l)}</span>`)
    .join("");
  const when = type === "merged"
    ? `merged ${fmtDate(pr.mergedAt)}`
    : `opened ${fmtDate(pr.createdAt)} · ${age(pr.createdAt)}`;
  const branch = pr.baseBranch
    ? `<span class="branch-chip ${branchClass(pr.baseBranch)}"><i data-lucide="git-branch"></i>${esc(pr.baseBranch)}</span>`
    : "";

  return `
    <a href="${esc(pr.url)}" target="_blank" rel="noopener" class="pr-card ${type} block no-underline">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-medium text-gray-200 leading-snug truncate">${esc(pr.title)}</h3>
          <div class="flex items-center gap-2 mt-1.5 flex-wrap">
            <span class="flex items-center gap-1.5">
              <span style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${authorColor(pr.author)}"></span>
              <span class="text-xs font-medium" style="color:${authorColor(pr.author)}">@${esc(pr.author)}</span>
            </span>
            <span class="text-xs text-gray-600">#${pr.number}</span>
            ${branch}
            <span class="text-xs text-gray-400">${when}</span>
            ${labels}
          </div>
        </div>
        <i data-lucide="external-link" class="w-3.5 h-3.5 text-gray-600 flex-shrink-0 mt-0.5"></i>
      </div>
    </a>`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  const w = cstWall(d);
  return `${String(w.getUTCMonth() + 1).padStart(2, "0")}/${String(w.getUTCDate()).padStart(2, "0")}`;
}
function age(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
  if (days <= 0) return "今天";
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo+`;
}
function esc(s) {
  const el = document.createElement("span");
  el.textContent = s || "";
  return el.innerHTML;
}

// ── Filter bar wiring ────────────────────────────────────────
function populateAuthors() {
  const counts = {};
  for (const p of PRS) counts[p.author] = (counts[p.author] || 0) + 1;
  const authors = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  $("#f-author").innerHTML =
    `<option value="all">全部 (${PRS.length})</option>` +
    authors.map(([name, n]) => `<option value="${esc(name)}">${esc(name)} (${n})</option>`).join("");
}

function syncCustomInputs() {
  const custom = $("#custom-range");
  if (state.range === "custom") {
    custom.classList.remove("hidden");
    custom.classList.add("flex");
    if (!$("#f-start").value || !$("#f-end").value) {
      const tw = thisWeekRange();
      $("#f-start").value = cstToYmd(tw.start);
      $("#f-end").value = cstToYmd(Date.now());
    }
  } else {
    custom.classList.add("hidden");
    custom.classList.remove("flex");
  }
}

function wireEvents() {
  $("#f-author").addEventListener("change", (e) => { state.author = e.target.value; render(); });
  $("#f-status").addEventListener("change", (e) => { state.status = e.target.value; render(); });

  $("#f-range").addEventListener("change", (e) => {
    state.range = e.target.value;
    syncCustomInputs();
    render();
  });
  $("#f-start").addEventListener("change", (e) => {
    state.start = e.target.value ? ymdToCstMs(e.target.value) : null;
    render();
  });
  $("#f-end").addEventListener("change", (e) => {
    // end date inclusive → end of that CST day
    state.end = e.target.value ? ymdToCstMs(e.target.value) + DAY - 1 : null;
    render();
  });

  $("#f-reset").addEventListener("click", () => {
    state.author = "all";
    state.range = "this_week";
    state.status = "all";
    $("#f-author").value = "all";
    $("#f-range").value = "this_week";
    $("#f-status").value = "all";
    $("#f-start").value = "";
    $("#f-end").value = "";
    syncCustomInputs();
    render();
  });
}

// ── Activity chart (merges per day in range, interactive) ────
function renderActivity(merged) {
  const wrap = $("#activity-chart");
  if (!wrap) return;

  const map = {};
  for (const p of merged) {
    const d = cstDayStartMs(cstWall(new Date(p.mergedAt)));
    map[d] = (map[d] || 0) + 1;
  }
  const first = cstDayStartMs(cstWall(new Date(state.start)));
  const last = cstDayStartMs(cstWall(new Date(state.end)));
  const days = [];
  for (let d = first; d <= last; d += DAY) {
    const dow = cstWall(new Date(d)).getUTCDay(); // 0=Sun … 6=Sat
    days.push({ d, n: map[d] || 0, weekend: dow === 0 || dow === 6 });
  }

  const total = days.reduce((s, x) => s + x.n, 0);
  $("#activity-total").textContent = `${total} merged`;

  if (days.length === 0 || total === 0) {
    wrap.innerHTML = `<div class="act-empty">该范围无合并记录</div>`;
    return;
  }

  const max = Math.max(...days.map((x) => x.n), 1);
  const showCount = days.length <= 14;          // counts only when bars are wide enough
  const step = Math.max(1, Math.ceil(days.length / 7));

  wrap.innerHTML =
    `<div class="act-bars">` +
    days
      .map((x, i) => {
        const h = Math.round((x.n / max) * 100);
        const lbl = i % step === 0 || i === days.length - 1
          ? `<span class="act-x">${fmtMd(x.d)}</span>`
          : `<span class="act-x"></span>`;
        const count = x.n && showCount ? `<span class="act-count">${x.n}</span>` : "";
        return `<div class="act-col${x.weekend ? " weekend" : ""}">
            <div class="act-track" data-tip="${fmtMd(x.d)} · ${x.n} merged">
              <div class="act-bar" style="height:${Math.max(h, x.n ? 6 : 0)}%">${count}</div>
            </div>
            ${lbl}
          </div>`;
      })
      .join("") +
    `</div>`;
}

// ── Contributors (top authors in range) ─────────────────────
function renderContributors(merged) {
  const wrap = $("#contributors-bar");
  const counts = {};
  for (const p of merged) counts[p.author] = (counts[p.author] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (top.length === 0) {
    wrap.innerHTML = `<div class="flex items-center justify-center py-8 text-gray-600 text-sm">无贡献者</div>`;
    return;
  }
  const max = top[0][1];
  wrap.innerHTML = top
    .map(([name, n]) => {
      const pct = Math.round((n / max) * 100);
      const color = authorColor(name);
      return `
        <div class="flex items-center gap-3">
          <div class="w-24 text-xs font-medium truncate text-right" style="color:${color}">@${esc(name)}</div>
          <div class="bar-track flex-1"><div class="bar-fill" style="width:${pct}%; background:${color}"></div></div>
          <div class="text-xs text-gray-400 w-8 text-right" style="font-variant-numeric:tabular-nums">${n}</div>
        </div>`;
    })
    .join("");
}

// Redraw chart on resize
let rzTimer;
window.addEventListener("resize", () => {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(() => {
    if (PRS.length) render();
  }, 200);
});

// ── Init ─────────────────────────────────────────────────────
async function init() {
  renderIcons(); // render static icons (navbar etc.) right away

  try {
    const resp = await fetch(DATA_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    PRS = data.prs || [];
    WINDOW_DAYS = data.windowDays || 30;

    $("#window-label").textContent = WINDOW_DAYS;
    $("#capture-meta").textContent =
      `最近 ${WINDOW_DAYS}d · ${PRS.length} PRs · ${new Date(data.capturedAt).toISOString().slice(0, 10)} 抓取`;

    populateAuthors();
    syncCustomInputs();
    wireEvents();
    render();

    $("#loading").style.display = "none";
    $("#app").classList.remove("hidden");
    renderIcons();
  } catch (err) {
    console.error(err);
    $("#loading").style.display = "none";
    $("#error").classList.remove("hidden");
    $("#error").classList.add("flex");
    renderIcons();
  }
}

document.addEventListener("DOMContentLoaded", init);
