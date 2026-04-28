import { Octokit } from "@octokit/rest";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_OWNER = "bosinc";
const REPO_NAME = "katana-server";

// ── Date helpers ──────────────────────────────────────────────
function getLastWorkday(now) {
  const d = new Date(now);
  const day = d.getDay();
  const diff = day === 1 ? 3 : day === 0 ? 2 : 1;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDate(d) {
  return d.toISOString().split("T")[0];
}

function formatDateCN(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── GitHub API ────────────────────────────────────────────────
async function fetchOpenPRs(octokit) {
  const prs = [];
  for await (const resp of octokit.paginate.iterator(octokit.rest.pulls.list, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    state: "open",
    per_page: 100,
  })) {
    prs.push(...resp.data);
  }
  return prs.map(formatPR);
}

async function fetchMergedPRs(octokit, since) {
  const prs = [];
  for await (const resp of octokit.paginate.iterator(octokit.rest.pulls.list, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    state: "closed",
    per_page: 100,
  })) {
    for (const pr of resp.data) {
      if (!pr.merged_at) continue;
      if (new Date(pr.merged_at) >= since) {
        prs.push(formatPR(pr));
      }
    }
  }
  return prs;
}

function formatPR(pr) {
  return {
    number: pr.number,
    title: pr.title,
    author: pr.user?.login || "unknown",
    url: pr.html_url,
    body: (pr.body || "").slice(0, 500),
    mergedAt: pr.merged_at,
    createdAt: pr.created_at,
    labels: (pr.labels || []).map((l) => l.name),
  };
}

// ── AI (OpenAI compatible) ────────────────────────────────────
async function generatePRSummary(pr) {
  const prompt = `用一句话中文总结这个 GitHub PR 的核心变更：
标题: ${pr.title}
描述: ${pr.body || "无描述"}
标签: ${pr.labels.join(", ") || "无"}
要求: 简洁明了，不超过50字。`;

  return callAI(prompt);
}

async function generateDailySummary(mergedPRs, openPRs) {
  const mergedList = mergedPRs
    .map((p) => `- #${p.number} ${p.title} (@${p.author})${p.aiSummary ? " — " + p.aiSummary : ""}`)
    .join("\n");
  const openList = openPRs
    .map((p) => `- #${p.number} ${p.title} (@${p.author})${p.aiSummary ? " — " + p.aiSummary : ""}`)
    .join("\n");

  const prompt = `你是项目日报助手。基于以下 PR 数据生成一份简洁的中文日报总结：
【已合并】
${mergedList || "无"}
【待合并】
${openList || "无"}
要求:
1. 总结今日合并的主要变更方向（1-2句）
2. 指出需要关注或优先 review 的 PR
3. 不超过150字`;

  return callAI(prompt);
}

function getAIConfig() {
  // Support generic AI_* env vars, fallback to OPENAI_* for backward compat
  const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || "";
  const model = process.env.AI_MODEL || process.env.OPENAI_MODEL || "";
  const maxTokens = parseInt(process.env.AI_MAX_TOKENS || "300", 10);

  return { apiKey, baseUrl, model, maxTokens };
}

async function callAI(prompt) {
  const { apiKey, baseUrl, model, maxTokens } = getAIConfig();
  if (!apiKey) return null;

  const url = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}/chat/completions`
    : "https://api.openai.com/v1/chat/completions";
  const resolvedModel = model || "gpt-4o-mini";

  console.log(`AI request: model=${resolvedModel} url=${url}`);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`AI API error: ${resp.status} ${text}`);
      return null;
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error("AI call failed:", err.message);
    return null;
  }
}

// ── Slack ─────────────────────────────────────────────────────
async function sendSlackDM(blocks) {
  const token = process.env.SLACK_BOT_TOKEN;
  const userId = process.env.SLACK_USER_ID;

  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel: userId,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });

  const data = await resp.json();
  if (!data.ok) {
    throw new Error(`Slack error: ${data.error}`);
  }

  console.log("Slack DM sent successfully");
}

// ── Message formatting ───────────────────────────────────────
function buildSlackBlocks(mergedPRs, openPRs, dailySummary, reportDate) {
  const blocks = [];

  // Header
  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: `📋 Katana Server PR 日报 — ${reportDate}`,
      emoji: true,
    },
  });

  blocks.push({ type: "divider" });

  // Merged PRs
  if (mergedPRs.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ *已合并（最近1个工作日）* — 共 ${mergedPRs.length} 个`,
      },
    });

    for (const pr of mergedPRs) {
      let text = `• *<${pr.url}|#${pr.number} ${escapeMarkdown(pr.title)}>* — @${pr.author}`;
      if (pr.labels.length > 0) {
        text += `  [${pr.labels.map((l) => `\`${l}\``).join(" ")}]`;
      }
      if (pr.aiSummary) {
        text += `\n  _${escapeMarkdown(pr.aiSummary)}_`;
      }
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text },
      });
    }
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "✅ *已合并（最近1个工作日）* — 无",
      },
    });
  }

  blocks.push({ type: "divider" });

  // Open PRs
  if (openPRs.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⏳ *待合并* — 共 ${openPRs.length} 个`,
      },
    });

    for (const pr of openPRs) {
      let text = `• *<${pr.url}|#${pr.number} ${escapeMarkdown(pr.title)}>* — @${pr.author}`;
      if (pr.labels.length > 0) {
        text += `  [${pr.labels.map((l) => `\`${l}\``).join(" ")}]`;
      }
      if (pr.aiSummary) {
        text += `\n  _${escapeMarkdown(pr.aiSummary)}_`;
      }
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text },
      });
    }
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "⏳ *待合并* — 无 🎉",
      },
    });
  }

  // AI Daily Summary
  if (dailySummary) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🤖 *AI 日报总结*\n\n${escapeMarkdown(dailySummary)}`,
      },
    });
  }

  // Footer
  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `📡 由 <https://github.com/bosinc/katana-server|katana-server> PR Report 自动生成`,
      },
    ],
  });

  return blocks;
}

function escapeMarkdown(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Save JSON data ───────────────────────────────────────────
function computeAnalytics(mergedPRs, openPRs) {
  const allPRs = [...mergedPRs, ...openPRs];

  const authorMap = {};
  const labelMap = {};
  for (const pr of allPRs) {
    authorMap[pr.author] = (authorMap[pr.author] || 0) + 1;
    for (const label of pr.labels) {
      labelMap[label] = (labelMap[label] || 0) + 1;
    }
  }

  const authors = Object.entries(authorMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const labels = Object.entries(labelMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { authors, labels, total: allPRs.length };
}

function saveReportJSON(reportDate, mergedPRs, openPRs, dailySummary) {
  const dataDir = resolve(process.env.DATA_DIR || "./data/reports");

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const analytics = computeAnalytics(mergedPRs, openPRs);

  const report = {
    date: reportDate,
    generatedAt: new Date().toISOString(),
    repo: `${REPO_OWNER}/${REPO_NAME}`,
    stats: {
      merged: mergedPRs.length,
      open: openPRs.length,
      total: analytics.total,
      authors: analytics.authors.length,
    },
    analytics,
    mergedPRs,
    openPRs,
    dailySummary,
  };

  const reportPath = resolve(dataDir, `${reportDate}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report saved: ${reportPath}`);

  // Update index
  const indexPath = resolve(dataDir, "index.json");
  let index = { reports: [] };
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, "utf-8"));
    } catch {
      index = { reports: [] };
    }
  }

  // Remove existing entry for same date, then prepend
  index.reports = index.reports.filter((r) => r.date !== reportDate);
  index.reports.unshift({
    date: reportDate,
    merged: mergedPRs.length,
    open: openPRs.length,
    total: analytics.total,
    authors: analytics.authors.length,
    hasAI: !!dailySummary,
  });

  // Keep last 90 days
  index.reports = index.reports.slice(0, 90);

  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`Index updated: ${indexPath}`);
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  const since = getLastWorkday(now);
  const reportDate = formatDateCN(now);

  console.log(`Report date: ${reportDate}`);
  console.log(`Fetching PRs merged since: ${formatDate(since)}`);

  // GitHub
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  console.log("Fetching open PRs...");
  const openPRs = await fetchOpenPRs(octokit);
  console.log(`Found ${openPRs.length} open PRs`);

  console.log("Fetching merged PRs...");
  const mergedPRs = await fetchMergedPRs(octokit, since);
  console.log(`Found ${mergedPRs.length} merged PRs since ${formatDate(since)}`);

  // AI summaries (optional)
  const { apiKey: aiKey } = getAIConfig();
  const hasAI = !!aiKey;
  let dailySummary = null;

  if (hasAI) {
    console.log("Generating AI summaries...");
    const allPRs = [...mergedPRs, ...openPRs];

    // Batch per-PR summaries (with concurrency limit)
    const tasks = allPRs.map(async (pr) => {
      pr.aiSummary = await generatePRSummary(pr);
    });
    await Promise.all(tasks);

    dailySummary = await generateDailySummary(mergedPRs, openPRs);
    console.log("AI summaries generated");
  } else {
    console.log("AI_API_KEY not set, skipping AI summaries");
  }

  // Save JSON data
  saveReportJSON(reportDate, mergedPRs, openPRs, dailySummary);

  // Slack
  const blocks = buildSlackBlocks(mergedPRs, openPRs, dailySummary, reportDate);
  console.log("Sending Slack DM...");
  await sendSlackDM(blocks);

  console.log("Done!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});