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
async function generateDailySummary(mergedPRs, openPRs) {
  const mergedList = mergedPRs
    .map((p) => `- #${p.number} ${p.title} (@${p.author}) [${p.labels.join(",") || "无标签"}]`)
    .join("\n");
  const openList = openPRs
    .map((p) => `- #${p.number} ${p.title} (@${p.author}) [${p.labels.join(",") || "无标签"}]`)
    .join("\n");

  const prompt = `你是项目日报助手。基于以下 PR 数据生成一份结构化的中文日报：

【已合并 PR】
${mergedList || "无"}

【待合并 PR】
${openList || "无"}

请按以下格式输出：

【变更概览】
用1-2句话总结今日合并的主要方向。

【分类归纳】
将已合并的 PR 按类型分组（如新功能、Bug修复、重构优化、性能优化、文档等），每组列出对应的 PR 编号和一句话描述。

【待关注】
指出需要优先 review 或有风险的待合并 PR。

要求：简洁专业，不超过300字。不要使用任何Markdown格式。`;

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

  const body = JSON.stringify({
    model: resolvedModel,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.3,
  });

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      });

      if (resp.status === 429 && attempt < maxRetries) {
        const delay = attempt * 3000;
        console.log(`Rate limited, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      if (!resp.ok) {
        const text = await resp.text();
        console.error(`AI API error: ${resp.status} ${text}`);
        return null;
      }

      const data = await resp.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (err) {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, attempt * 2000));
        continue;
      }
      console.error("AI call failed:", err.message);
      return null;
    }
  }
  return null;
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
    console.error("Slack full response:", JSON.stringify(data));
    throw new Error(`Slack error: ${data.error} needed: ${data.needed || "?"} provided: ${data.provided || "?"}`);
  }

  console.log("Slack DM sent successfully");
}

// ── Message formatting ───────────────────────────────────────
function buildSlackBlocks(mergedPRs, openPRs, dailySummary, reportDate) {
  const blocks = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `Katana Server PR Report — ${reportDate}`, emoji: true },
  });

  // Merged PRs — one section with all items as text
  const mergedLines = mergedPRs.length > 0
    ? mergedPRs.map((pr) => `• <${pr.url}|#${pr.number} ${escapeMarkdown(pr.title)}> — @${pr.author}`).join("\n")
    : "No merged PRs in this period.";
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Merged (${mergedPRs.length})*\n${mergedLines}` },
  });

  // Open PRs — one section with all items as text
  const openLines = openPRs.length > 0
    ? openPRs.map((pr) => `• <${pr.url}|#${pr.number} ${escapeMarkdown(pr.title)}> — @${pr.author}`).join("\n")
    : "All clear!";
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Pending (${openPRs.length})*\n${openLines}` },
  });

  // AI Summary
  if (dailySummary) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*AI Summary*\n${escapeMarkdown(dailySummary)}` },
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `From <https://github.com/bosinc/katana-server|katana-server> PR Report` }],
  });

  // Slack limit: max 50 blocks, max 3000 chars per text field
  // Each section text must be under 3000 chars — split if needed
  const result = [];
  for (const block of blocks) {
    if (block.text && block.text.text && block.text.text.length > 2900) {
      const chunks = splitText(block.text.text, 2900);
      for (const chunk of chunks) {
        result.push({ ...block, text: { ...block.text, text: chunk } });
      }
    } else {
      result.push(block);
    }
  }

  return result.slice(0, 50);
}

function splitText(text, maxLen) {
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
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
    console.log("Generating AI daily summary...");
    dailySummary = await generateDailySummary(mergedPRs, openPRs);
    console.log("AI daily summary generated");
  } else {
    console.log("AI_API_KEY not set, skipping AI summaries");
  }

  // Save JSON data
  saveReportJSON(reportDate, mergedPRs, openPRs, dailySummary);

  // Slack (non-fatal)
  try {
    const blocks = buildSlackBlocks(mergedPRs, openPRs, dailySummary, reportDate);
    console.log("Sending Slack DM...");
    await sendSlackDM(blocks);
  } catch (err) {
    console.error("Slack failed (non-fatal):", err.message);
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});