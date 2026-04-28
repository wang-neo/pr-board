import { Octokit } from "@octokit/rest";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Config (all via env vars) ────────────────────────────────
const REPO_OWNER = process.env.REPO_OWNER || "itisaowner";
const REPO_NAME = process.env.REPO_NAME || "itisarepo";

// Target branches: "main:🚀,release:🛠️" → { main: "🚀", release: "🛠️" }
const TARGET_BRANCHES = (process.env.TARGET_BRANCHES || "main:🚀,release:🛠️")
  .split(",")
  .reduce((map, entry) => {
    const [branch, icon] = entry.split(":").map((s) => s.trim());
    if (branch) map[branch] = icon || "";
    return map;
  }, {});

// ── Date helpers ──────────────────────────────────────────────
function getReportRange(now) {
  const today = new Date(now);
  const day = today.getDay();
  const diff = day === 1 ? 3 : day === 0 ? 2 : 1;

  const since = new Date(today);
  since.setDate(today.getDate() - diff);
  since.setHours(0, 0, 0, 0);

  const until = new Date(since);
  until.setDate(since.getDate() + 1);

  return { since, until };
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateTime(d) {
  return `${formatDate(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── GitHub API ────────────────────────────────────────────────
const targetBranchSet = new Set(Object.keys(TARGET_BRANCHES));

function matchTargetBranch(pr) {
  const base = pr.base?.ref || "";
  return targetBranchSet.has(base);
}

async function fetchMergedPRs(octokit, since, until) {
  const prs = [];
  for await (const resp of octokit.paginate.iterator(octokit.rest.pulls.list, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    state: "closed",
    per_page: 100,
  })) {
    for (const pr of resp.data) {
      if (!pr.merged_at) continue;
      const mergedAt = new Date(pr.merged_at);
      if (mergedAt >= since && mergedAt < until && matchTargetBranch(pr)) {
        prs.push(pr);
      }
    }
  }

  // Fetch code stats for each merged PR
  const formatted = [];
  for (const pr of prs) {
    const detail = await octokit.rest.pulls.get({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      pull_number: pr.number,
    }).catch(() => null);

    formatted.push({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login || "unknown",
      url: pr.html_url,
      body: (pr.body || "").slice(0, 500),
      mergedAt: pr.merged_at,
      createdAt: pr.created_at,
      labels: (pr.labels || []).map((l) => l.name),
      baseBranch: pr.base?.ref || "",
      additions: detail?.data?.additions || 0,
      deletions: detail?.data?.deletions || 0,
      changedFiles: detail?.data?.changed_files || 0,
    });
  }
  return formatted;
}

async function fetchOpenPRs(octokit) {
  const prs = [];
  for await (const resp of octokit.paginate.iterator(octokit.rest.pulls.list, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    state: "open",
    per_page: 100,
  })) {
    for (const pr of resp.data) {
      if (matchTargetBranch(pr)) prs.push(pr);
    }
  }
  return prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    author: pr.user?.login || "unknown",
    url: pr.html_url,
    body: (pr.body || "").slice(0, 500),
    mergedAt: pr.merged_at,
    createdAt: pr.created_at,
    labels: (pr.labels || []).map((l) => l.name),
    baseBranch: pr.base?.ref || "",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
  }));
}

// ── AI (OpenAI compatible) ────────────────────────────────────
async function generateDailySummary(mergedPRs, openPRs) {
  const mergedList = mergedPRs
    .map((p) => `- #${p.number} ${p.title} (@${p.author}) [${p.labels.join(",") || "无标签"}]`)
    .join("\n");
  const openList = openPRs
    .map((p) => `- #${p.number} ${p.title} (@${p.author}) [${p.labels.join(",") || "无标签"}]`)
    .join("\n");

  const prompt = `你是项目日报助手。基于以下 PR 数据生成一份结构化的中文日报。

【已合并 PR】
${mergedList || "无"}

【待合并 PR】
${openList || "无"}

请严格按以下两部分输出：

第一部分：个人贡献
按贡献者分组，每人列出今天合并了什么，一句话概括。格式：
@某人：做了xxx（#123），修复了yyy（#124）

第二部分：项目变更概览
1. 用1-2句话总结今日合并的主要方向
2. 将已合并的 PR 按类型分组（如新功能、Bug修复、重构优化、性能优化、文档等）
3. 指出需要优先 review 或有风险的待合并 PR

要求：简洁专业，不超过400字。不要使用任何Markdown格式（不要用#、**、-等符号）。`;

  return callAI(prompt);
}

async function generateRiskAlert(openPRs) {
  if (openPRs.length === 0) return null;

  const now = new Date();
  const prList = openPRs.map((p) => {
    const days = Math.round((now - new Date(p.createdAt)) / 86400000);
    return `- #${p.number} ${p.title} (@${p.author}) 已开${days}天`;
  }).join("\n");

  const prompt = `你是项目风险分析助手。以下是目前待合并的 PR 列表：

${prList}

请用1-3句话指出：哪些 PR 可能存在风险（如等待时间过长、涉及重要模块等）。不要使用Markdown格式。直接输出分析，不要寒暄。`;

  return callAI(prompt);
}

function getAIConfig() {
  const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || "";
  const model = process.env.AI_MODEL || process.env.OPENAI_MODEL || "";
  const maxTokens = parseInt(process.env.AI_MAX_TOKENS || "8000", 10);

  return { apiKey, baseUrl, model, maxTokens };
}

async function callAI(prompt) {
  const { apiKey, baseUrl, model, maxTokens } = getAIConfig();
  if (!apiKey) return null;

  const url = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}/chat/completions`
    : "https://api.openai.com/v1/chat/completions";
  const resolvedModel = model || "gpt-4o-mini";

  const reqBody = {
    model: resolvedModel,
    messages: [
      { role: "system", content: "你是一个简洁专业的项目日报助手。直接输出日报内容，不要使用Markdown格式。" },
      { role: "user", content: prompt },
    ],
    temperature: 0.3,
  };
  // NOTE: Do NOT send max_tokens — reasoning models (DeepSeek R1, etc.) consume tokens
  // on internal thinking and hit the limit before producing visible content.
  // The prompt already constrains output to ~400 chars.

  const body = JSON.stringify(reqBody);

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
      const choice = data.choices?.[0];
      const msg = choice?.message;
      // Handle both content and reasoning_content (some providers return reasoning separately)
      const content = (msg?.content || msg?.text || "").trim();
      if (!content) {
        console.error("AI returned empty content. finish_reason:", choice?.finish_reason, "usage:", JSON.stringify(data.usage));
      } else {
        console.log(`AI response: ${content.length} chars, finish_reason: ${choice?.finish_reason}`);
      }
      return content || null;
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
function buildSlackBlocks(mergedPRs, openPRs, dailySummary, riskAlert, reportDay, generatedAt) {
  const blocks = [];

  // Header
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `PR Report — ${reportDay}`, emoji: true },
  });

  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: `*Merged:* ${mergedPRs.length} | *Pending:* ${openPRs.length} | ${generatedAt}` },
    ],
  });

  // AI Summary
  if (dailySummary) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:sparkles: *AI Daily Report*\n${escapeMarkdown(dailySummary)}` },
    });
  }

  // Code stats per author
  blocks.push({ type: "divider" });
  const authorStats = {};
  for (const pr of mergedPRs) {
    if (!authorStats[pr.author]) {
      authorStats[pr.author] = { prs: 0, additions: 0, deletions: 0, changedFiles: 0 };
    }
    authorStats[pr.author].prs += 1;
    authorStats[pr.author].additions += pr.additions || 0;
    authorStats[pr.author].deletions += pr.deletions || 0;
    authorStats[pr.author].changedFiles += pr.changedFiles || 0;
  }

  const sortedAuthors = Object.entries(authorStats).sort((a, b) => b[1].additions + b[1].deletions - (a[1].additions + a[1].deletions));
  if (sortedAuthors.length > 0) {
    const fields = sortedAuthors.map(([author, s]) => ({
      type: "mrkdwn",
      text: `*@${author}*\n${s.prs} PRs · +${s.additions} / -${s.deletions}`,
    }));
    // Slack fields: max 10 per block
    for (let i = 0; i < fields.length; i += 10) {
      blocks.push({
        type: "section",
        fields: fields.slice(i, i + 10),
      });
    }
  }

  // Merged PRs grouped by author
  blocks.push({ type: "divider" });
  const byAuthor = {};
  for (const pr of mergedPRs) {
    (byAuthor[pr.author] ||= []).push(pr);
  }
  const authorEntries = Object.entries(byAuthor).sort((a, b) => b[1].length - a[1].length);
  let mergedText = `:white_check_mark: *Merged (${mergedPRs.length})*`;
  for (const [author, prs] of authorEntries) {
    prs.sort((a, b) => a.number - b.number);
    mergedText += `\n@${author}:`;
    for (const pr of prs) {
      mergedText += `\n  ${formatPRLine(pr)}`;
    }
  }
  if (mergedPRs.length === 0) mergedText += "\nNo merged PRs in this period.";

  for (const chunk of splitSlackText(mergedText, 2900)) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
  }

  // Pending PRs — compact summary by author
  blocks.push({ type: "divider" });
  const openByAuthor = {};
  for (const pr of openPRs) {
    (openByAuthor[pr.author] ||= []).push(pr);
  }
  const openAuthorEntries = Object.entries(openByAuthor).sort((a, b) => b[1].length - a[1].length);

  if (openPRs.length > 10) {
    // Compact mode: author + count only
    let openText = `:hourglass_flowing_sand: *Pending (${openPRs.length})*`;
    for (const [author, prs] of openAuthorEntries) {
      const prNums = prs.sort((a, b) => a.number - b.number).map((p) => `<${p.url}|#${p.number}>`).join(" ");
      openText += `\n@${author} (${prs.length}): ${prNums}`;
    }
    for (const chunk of splitSlackText(openText, 2900)) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
    }
  } else {
    // Full mode: show titles
    let openText = `:hourglass_flowing_sand: *Pending (${openPRs.length})*`;
    for (const [author, prs] of openAuthorEntries) {
      prs.sort((a, b) => a.number - b.number);
      openText += `\n@${author}:`;
      for (const pr of prs) {
        openText += `\n  ${formatPRLine(pr)}`;
      }
    }
    if (openPRs.length === 0) openText += "\nAll clear!";
    for (const chunk of splitSlackText(openText, 2900)) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
    }
  }

  // AI Risk Alert
  if (riskAlert) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:warning: *Risk Alert*\n${escapeMarkdown(riskAlert)}` },
    });
  }

  // Footer
  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: `<https://github.com/${REPO_OWNER}/${REPO_NAME}/pulls|View all PRs> · ${REPO_NAME}` },
    ],
  });

  return blocks.slice(0, 50);
}

function splitSlackText(text, maxLen) {
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

function formatPRLine(pr) {
  const icon = TARGET_BRANCHES[pr.baseBranch] || "";
  const branch = pr.baseBranch ? `(${pr.baseBranch}) ` : "";
  return `${icon} #${pr.number}${branch}<${pr.url}|${escapeMarkdown(pr.title)}>`;
}

// ── Save JSON data ───────────────────────────────────────────
function computeAnalytics(mergedPRs, openPRs) {
  const allPRs = [...mergedPRs, ...openPRs];

  const authorMap = {};
  const labelMap = {};
  for (const pr of allPRs) {
    if (!authorMap[pr.author]) {
      authorMap[pr.author] = { prs: 0, additions: 0, deletions: 0, changedFiles: 0 };
    }
    authorMap[pr.author].prs += 1;
    authorMap[pr.author].additions += pr.additions || 0;
    authorMap[pr.author].deletions += pr.deletions || 0;
    authorMap[pr.author].changedFiles += pr.changedFiles || 0;
    for (const label of pr.labels) {
      labelMap[label] = (labelMap[label] || 0) + 1;
    }
  }

  const authors = Object.entries(authorMap)
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.prs - a.prs);

  const labels = Object.entries(labelMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const totalAdditions = mergedPRs.reduce((s, p) => s + (p.additions || 0), 0);
  const totalDeletions = mergedPRs.reduce((s, p) => s + (p.deletions || 0), 0);
  const totalChangedFiles = mergedPRs.reduce((s, p) => s + (p.changedFiles || 0), 0);

  return { authors, labels, total: allPRs.length, totalAdditions, totalDeletions, totalChangedFiles };
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
  const { since, until } = getReportRange(now);
  const reportDay = formatDate(since);
  const generatedAt = formatDateTime(now) + " CST";

  console.log(`Report for: ${reportDay} (${formatDate(since)} ~ ${formatDate(until)})`);
  console.log(`Generated at: ${generatedAt}`);

  // GitHub
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  console.log("Fetching open PRs...");
  const openPRs = await fetchOpenPRs(octokit);
  console.log(`Found ${openPRs.length} open PRs`);

  console.log("Fetching merged PRs...");
  const mergedPRs = await fetchMergedPRs(octokit, since, until);
  console.log(`Found ${mergedPRs.length} merged PRs on ${reportDay}`);

  // AI summaries (optional)
  const { apiKey: aiKey } = getAIConfig();
  const hasAI = !!aiKey;
  let dailySummary = null;
  let riskAlert = null;

  if (hasAI) {
    console.log("Generating AI daily summary...");
    dailySummary = await generateDailySummary(mergedPRs, openPRs);
    console.log("AI daily summary generated");

    console.log("Generating AI risk alert...");
    riskAlert = await generateRiskAlert(openPRs);
    if (riskAlert) console.log("AI risk alert generated");
  } else {
    console.log("AI_API_KEY not set, skipping AI summaries");
  }

  // Save JSON data (filename = the day being reported)
  saveReportJSON(reportDay, mergedPRs, openPRs, dailySummary);

  // Slack (non-fatal)
  try {
    const blocks = buildSlackBlocks(mergedPRs, openPRs, dailySummary, riskAlert, reportDay, generatedAt);
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