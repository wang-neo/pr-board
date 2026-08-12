import { Octokit } from "@octokit/rest";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Config (same env as report.mjs) ───────────────────────────
const REPO_OWNER = process.env.REPO_OWNER || "itisaowner";
const REPO_NAME = process.env.REPO_NAME || "itisarepo";
const WINDOW_DAYS = parseInt(process.env.WINDOW_DAYS || "30", 10);

// Target branches filter, same parsing as report.mjs
const targetBranchSet = new Set(
  (process.env.TARGET_BRANCHES || "main,release")
    .split(",")
    .map((s) => s.split(":")[0].trim())
    .filter(Boolean),
);

function matchTargetBranch(pr) {
  const base = pr.base?.ref || "";
  return targetBranchSet.has(base);
}

function shapePR(pr, state) {
  return {
    number: pr.number,
    title: pr.title,
    author: pr.user?.login || "unknown",
    url: pr.html_url,
    state, // "open" | "merged"
    baseBranch: pr.base?.ref || "",
    createdAt: pr.created_at,
    mergedAt: pr.merged_at || null,
    labels: (pr.labels || []).map((l) => l.name),
  };
}

async function fetchOpenPRs(octokit) {
  const out = [];
  for await (const resp of octokit.paginate.iterator(octokit.rest.pulls.list, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    state: "open",
    per_page: 100,
  })) {
    for (const pr of resp.data) {
      if (matchTargetBranch(pr)) out.push(shapePR(pr, "open"));
    }
  }
  return out;
}

async function fetchRecentlyMergedPRs(octokit, since) {
  // sort=updated desc → once updated_at < since, no more merges in window → safe to stop
  const out = [];
  for await (const resp of octokit.paginate.iterator(octokit.rest.pulls.list, {
    owner: REPO_OWNER,
    repo: REPO_NAME,
    state: "closed",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  })) {
    let oldestUpdated = Infinity;
    for (const pr of resp.data) {
      const updated = new Date(pr.updated_at).getTime();
      if (updated < oldestUpdated) oldestUpdated = updated;
      if (!pr.merged_at) continue;
      if (new Date(pr.merged_at) < since) continue;
      if (!matchTargetBranch(pr)) continue;
      out.push(shapePR(pr, "merged"));
    }
    if (oldestUpdated < since.getTime()) break; // rest of the list is older than the window
  }
  return out;
}

async function main() {
  const now = new Date();
  const since = new Date(now);
  since.setDate(since.getDate() - WINDOW_DAYS);

  console.log(`Capturing ${REPO_OWNER}/${REPO_NAME}: open + merged since ${since.toISOString().slice(0, 10)} (${WINDOW_DAYS}d)`);

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  console.log("Fetching open PRs...");
  const open = await fetchOpenPRs(octokit);
  console.log(`  ${open.length} open`);

  console.log("Fetching recently merged PRs...");
  const merged = await fetchRecentlyMergedPRs(octokit, since);
  console.log(`  ${merged.length} merged (last ${WINDOW_DAYS}d)`);

  // Dedup by number (a PR can't be both open & merged, but be safe)
  const seen = new Set();
  const prs = [...merged, ...open].filter((p) => {
    if (seen.has(p.number)) return false;
    seen.add(p.number);
    return true;
  });

  const payload = {
    capturedAt: now.toISOString(),
    repo: `${REPO_OWNER}/${REPO_NAME}`,
    windowDays: WINDOW_DAYS,
    prs,
  };

  const dataDir = resolve(process.env.DATA_DIR || "./data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const outPath = resolve(dataDir, "prs.json");
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`Saved ${prs.length} PRs → ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
