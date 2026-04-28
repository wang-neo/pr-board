const DATA_BASE = "../data/reports";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let reports = [];
let currentIndex = 0;

async function init() {
  const select = $("#date-select");

  select.addEventListener("change", () => {
    currentIndex = select.selectedIndex;
    loadReport(reports[currentIndex].date);
  });

  $("#prev-btn").addEventListener("click", () => {
    if (currentIndex < reports.length - 1) {
      currentIndex++;
      select.selectedIndex = currentIndex;
      loadReport(reports[currentIndex].date);
    }
  });

  $("#next-btn").addEventListener("click", () => {
    if (currentIndex > 0) {
      currentIndex--;
      select.selectedIndex = currentIndex;
      loadReport(reports[currentIndex].date);
    }
  });

  await loadIndex();
}

// ── Data fetching ──────────────────────────────────────────

async function loadIndex() {
  show("loading");
  try {
    const resp = await fetch(`${DATA_BASE}/index.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    reports = data.reports || [];

    if (reports.length === 0) {
      show("empty");
      lucide.createIcons();
      return;
    }

    populateDateSelect();
    currentIndex = 0;
    await loadReport(reports[0].date);
  } catch {
    show("empty");
    lucide.createIcons();
  }
}

async function loadReport(date) {
  show("loading");
  updateNav();

  try {
    const resp = await fetch(`${DATA_BASE}/${date}.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    renderReport(data);
    show("report");
  } catch {
    show("empty");
  }
}

// ── Rendering ──────────────────────────────────────────────

function renderReport(data) {
  renderStats(data);
  renderTrend();
  renderAI(data.dailySummary);
  renderAuthors(data.analytics);
  renderPRList("merged-list", data.mergedPRs, "merged");
  renderPRList("open-list", data.openPRs, "open");
  $("#merged-count").textContent = data.stats.merged;
  $("#open-count").textContent = data.stats.open;

  lucide.createIcons();
}

function renderStats(data) {
  const cards = [
    {
      icon: "git-merge",
      label: "Merged",
      value: data.stats.merged,
      color: "text-merged",
      bg: "bg-merged-bg",
    },
    {
      icon: "clock",
      label: "Pending",
      value: data.stats.open,
      color: "text-pending",
      bg: "bg-pending-bg",
    },
    {
      icon: "users",
      label: "Contributors",
      value: data.stats.authors || 0,
      color: "text-accent",
      bg: "bg-accent/10",
    },
    {
      icon: "calendar",
      label: "Date",
      value: formatDisplayDate(data.date),
      color: "text-gray-300",
      bg: "bg-surface-lighter",
      isText: true,
    },
  ];

  $("#stats-grid").innerHTML = cards
    .map((c) => `
      <div class="bento-card flex items-center gap-4">
        <div class="w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center flex-shrink-0">
          <i data-lucide="${c.icon}" class="w-5 h-5 ${c.color}"></i>
        </div>
        <div>
          <div class="text-[11px] font-medium text-gray-500 uppercase tracking-wider mb-0.5">${c.label}</div>
          <div class="stat-value ${c.color} ${c.isText ? "!text-lg !font-semibold" : ""}">${c.value}</div>
        </div>
      </div>
    `)
    .join("");
}

function renderTrend() {
  const canvas = $("#trend-canvas");
  if (!canvas || reports.length === 0) return;

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = 120 * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = 120;
  const last30 = reports.slice(0, 30).reverse();
  if (last30.length < 2) return;

  const maxVal = Math.max(...last30.map((r) => Math.max(r.merged, r.open)), 1);
  const pad = { top: 10, bottom: 20, left: 5, right: 5 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;

  // Draw merged area
  drawArea(ctx, last30.map((r) => r.merged), maxVal, chartW, chartH, pad, "rgba(63,185,80,0.15)", "#3fb950");
  // Draw open area
  drawArea(ctx, last30.map((r) => r.open), maxVal, chartW, chartH, pad, "rgba(210,153,34,0.1)", "#d29922");

  // Labels
  ctx.fillStyle = "#8b949e";
  ctx.font = "10px Inter, system-ui";
  ctx.textAlign = "center";
  const step = Math.max(1, Math.floor(last30.length / 6));
  for (let i = 0; i < last30.length; i += step) {
    const x = pad.left + (i / (last30.length - 1)) * chartW;
    const label = last30[i].date.slice(5);
    ctx.fillText(label, x, h - 4);
  }
}

function drawArea(ctx, values, max, chartW, chartH, pad, fillColor, strokeColor) {
  const n = values.length;
  if (n < 2) return;

  const points = values.map((v, i) => ({
    x: pad.left + (i / (n - 1)) * chartW,
    y: pad.top + chartH - (v / max) * chartH,
  }));

  // Fill
  ctx.beginPath();
  ctx.moveTo(points[0].x, pad.top + chartH);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.lineTo(points[n - 1].x, pad.top + chartH);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  // Stroke
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    if (i === 0) ctx.moveTo(points[i].x, points[i].y);
    else {
      const prev = points[i - 1];
      const cpx = (prev.x + points[i].x) / 2;
      ctx.bezierCurveTo(cpx, prev.y, cpx, points[i].y, points[i].x, points[i].y);
    }
  }
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function renderAI(summary) {
  const card = $("#ai-card");
  if (!summary) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  $("#ai-text").textContent = summary;
}

function renderAuthors(analytics) {
  const section = $("#authors-section");
  if (!analytics || !analytics.authors || analytics.authors.length === 0) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  const maxCount = analytics.authors[0].count;
  const colors = ["#3fb950", "#58a6ff", "#d29922", "#bc8cff", "#f78166", "#79c0ff"];

  $("#authors-bar").innerHTML = analytics.authors
    .slice(0, 6)
    .map((a, i) => {
      const pct = Math.round((a.count / maxCount) * 100);
      const color = colors[i % colors.length];
      return `
        <div class="flex items-center gap-3">
          <div class="w-20 text-xs text-gray-400 font-medium truncate text-right">@${esc(a.name)}</div>
          <div class="flex-1 bg-surface-lighter rounded-full overflow-hidden h-1.5">
            <div class="author-bar-fill" style="width:${pct}%; background:${color}"></div>
          </div>
          <div class="text-xs text-gray-500 w-6 text-right">${a.count}</div>
        </div>
      `;
    })
    .join("");
}

function renderPRList(containerId, prs, type) {
  const container = $(`#${containerId}`);

  if (prs.length === 0) {
    container.innerHTML = `
      <div class="flex items-center justify-center py-8 text-gray-600 text-sm">
        <i data-lucide="check-circle" class="w-4 h-4 mr-2"></i>
        ${type === "merged" ? "No merged PRs in this period" : "All clear — nothing pending"}
      </div>`;
    return;
  }

  container.innerHTML = prs
    .map((pr) => {
      const labels = pr.labels
        .slice(0, 3)
        .map((l) => `<span class="label-chip">${esc(l)}</span>`)
        .join("");
      const ai = pr.aiSummary
        ? `<p class="mt-2 text-xs text-gray-500 italic leading-relaxed">${esc(pr.aiSummary)}</p>`
        : "";

      return `
        <a href="${esc(pr.url)}" target="_blank" rel="noopener"
           class="pr-card ${type} block no-underline">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-medium text-gray-200 leading-snug truncate">${esc(pr.title)}</h3>
              <div class="flex items-center gap-2 mt-1.5 flex-wrap">
                <span class="text-xs text-accent font-medium">@${esc(pr.author)}</span>
                <span class="text-xs text-gray-600">#${pr.number}</span>
                ${labels}
              </div>
              ${ai}
            </div>
            <i data-lucide="external-link" class="w-3.5 h-3.5 text-gray-600 flex-shrink-0 mt-0.5"></i>
          </div>
        </a>`;
    })
    .join("");
}

// ── Helpers ────────────────────────────────────────────────

function populateDateSelect() {
  const select = $("#date-select");
  select.innerHTML = reports
    .map((r) => {
      const d = formatDisplayDate(r.date);
      return `<option value="${r.date}">${d} — ${r.merged} merged / ${r.open} open</option>`;
    })
    .join("");
}

function updateNav() {
  $("#prev-btn").disabled = currentIndex >= reports.length - 1;
  $("#next-btn").disabled = currentIndex <= 0;
}

function show(id) {
  ["loading", "empty", "report"].forEach((s) => {
    const el = document.getElementById(s);
    if (!el) return;
    if (s === id) {
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  });
}

function formatDisplayDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")} ${weekdays[dt.getDay()]}`;
}

function esc(s) {
  const el = document.createElement("span");
  el.textContent = s || "";
  return el.innerHTML;
}

// Handle trend canvas resize
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (reports.length > 0) renderTrend();
  }, 200);
});

document.addEventListener("DOMContentLoaded", init);
