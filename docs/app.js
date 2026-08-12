const DATA_URL = "./data/prs.json";
const CST = 8 * 3600 * 1000;          // UTC+8
const DAY = 86400000;

const $ = (s) => document.querySelector(s);

// All PRs from the rolling snapshot
let PRS = [];
let WINDOW_DAYS = 30;

// Filter state
const state = { author: "all", range: "this_week", status: "all", start: null, end: null };

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

  lucide.createIcons();
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
      <div class="w-10 h-10 rounded-xl ${bg} flex items-center justify-center flex-shrink-0">
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
      <div class="w-10 h-10 rounded-xl ${bg} flex items-center justify-center flex-shrink-0">
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

function prCard(pr, type) {
  const labels = pr.labels
    .slice(0, 3)
    .map((l) => `<span class="label-chip">${esc(l)}</span>`)
    .join("");
  const when = type === "merged"
    ? `merged ${fmtDate(pr.mergedAt)}`
    : `opened ${fmtDate(pr.createdAt)} · ${age(pr.createdAt)}`;
  const branch = pr.baseBranch ? `<span class="text-gray-600">→${esc(pr.baseBranch)}</span>` : "";

  return `
    <a href="${esc(pr.url)}" target="_blank" rel="noopener" class="pr-card ${type} block no-underline">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <h3 class="text-sm font-medium text-gray-200 leading-snug truncate">${esc(pr.title)}</h3>
          <div class="flex items-center gap-2 mt-1.5 flex-wrap">
            <span class="text-xs text-accent font-medium">@${esc(pr.author)}</span>
            <span class="text-xs text-gray-600">#${pr.number}</span>
            ${branch}
            <span class="text-xs text-gray-600">${when}</span>
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

// ── Init ─────────────────────────────────────────────────────
async function init() {
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
    lucide.createIcons();
  } catch (err) {
    console.error(err);
    $("#loading").style.display = "none";
    $("#error").classList.remove("hidden");
    $("#error").classList.add("flex");
    lucide.createIcons();
  }
}

document.addEventListener("DOMContentLoaded", init);
