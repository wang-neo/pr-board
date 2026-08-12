# PR Board — 全量抓取 + 筛选看板 设计

日期: 2026-08-12

## 背景

当前 dashboard 每天一份快照 (`data/reports/YYYY-MM-DD.json`),只能看单天。
- `openPRs` = 抓取那一刻全部 open PR 的完整快照
- `mergedPRs` = **仅当天**合并的 PR(按天切)

需求: 看板能按 **人 / 时间范围 / 状态** 筛选,看到「某个人某段时间做了什么、还在做什么」,默认本周(CST 周一 00:00 起)。

## 核心原则(用户确认)

- **职责分离**: 现有 action(`report.mjs` + Slack 日报)**完全不动**,只**新增**抓取脚本。
- **数据模型**: 一份 = 抓取当前所有 PR(open + 最近 30 天 merged),每天滚动覆盖。不拼历史。
- **全量历史**: 留作未来「快照拼接」feature,本次不做。

## 两个 Feature

### F1 — 全量抓取(数据层)

新增 `.github/scripts/pr-report/capture-prs.mjs`(独立于 `report.mjs`):

- 拉 **所有 open PR** + **最近 30 天 merged PR**,每个带 `state` + 时间戳
- 不取 per-PR additions/deletions(F2 看板用不到 → 避免 rate limit,只用 list 接口)
- 按 `TARGET_BRANCHES` 过滤(与 report.mjs 一致,默认 main/release)
- 输出滚动文件 `data/prs.json`(每次覆盖)

**`data/prs.json` 结构:**
```jsonc
{
  "capturedAt": "ISO",
  "repo": "bosinc/katana-server",
  "windowDays": 30,
  "prs": [
    {
      "number": 8006, "title": "...", "author": "qbyte2", "url": "...",
      "state": "open",            // "open" | "merged"
      "baseBranch": "release",
      "createdAt": "ISO",
      "mergedAt": null,            // null = 仍 open
      "labels": ["..."]
    }
  ]
}
```

**workflow 改动(只加不改):**
1. `report` job 里 `report.mjs` 之后加一步 `node capture-prs.mjs`(同 env: `GITHUB_TOKEN` / `REPO_OWNER` / `REPO_NAME` / `DATA_DIR`)
2. commit 步骤 `git add data/`(原来 `data/reports/`)以纳入 `prs.json`
3. `deploy-pages` 的 stage 步骤把 `data/prs.json` 一起拷进 `docs/data/`

`report.mjs` 一行不改。

### F2 — 筛选看板(展示层)

重写 `docs/`,只读 `data/prs.json`,全部浏览器端筛选。

**顶部筛选条:**

| 筛选 | 控件 | 默认 |
|---|---|---|
| 人 | 下拉: `全部` + 作者列表(从 prs 动态生成) | 全部 |
| 时间范围 | 预设 `本周 / 上周 / 最近7天 / 最近30天 / 自定义` | **本周(CST 周一)** |
| 状态 | `全部 / 已合并 / 进行中` | 全部 |

**两条规则:**
- **做了什么 (Merged)** = `mergedAt` 落在所选时间范围内的 PR
- **还在做什么 (Pending)** = 当前 `state=open` 的 PR(取最新,不受时间范围影响)

→ 换时间范围只影响 Merged;Pending 永远是当前 open。选作者后两栏都按作者过滤。

**CST 周一:** 浏览器按 UTC+8 计算本周一 00:00 ~ 周日 23:59。

**布局:** 顶部筛选条 → 统计卡(merged / pending / contributors,随筛选变化)→ 两栏 Merged / Pending PR 列表。沿用现有深色主题(Tailwind + Lucide)。

## 实现顺序

F1 先(产出 `data/prs.json`)→ F2(读它渲染)。本地测 F2 时用现有 `data/reports/*.json` 合成一份 sample `prs.json` 做渲染测试(此合成脚本不进仓库)。

## 非目标

- 全量历史拼接(未来 feature)
- per-PR 代码行数(看板不需要)
- 单天视图保留(被范围视图取代;`data/reports/` 仍由 report.mjs 继续写,Slack 日报不变)
