# Katana Server PR Board (展示层)

PR 看板的**展示层** —— 只放生成的静态文件,通过 GitHub Pages 展示。

逻辑层(抓取 PR、Slack 日报、组装站点)在 [`katana-task/scripts/pr-board`](https://github.com/wang-neo/katana-task/tree/main/scripts/pr-board)。本仓库**不放任何脚本逻辑**。

## 数据怎么来的

```
katana-task Action ② (pr-board-publish)          pr-board
  抓取 30d 所有 PR → prs.json            ──push──▶  docs/
  组装 site/ → docs/                                ↓ 触发
                                            pages.yml (本仓库)
                                                  ↓
                                            GitHub Pages 上线
```

每天 katana-task 推送 `docs/`(覆盖),本次 push 触发本仓库 `pages.yml` → 部署。

## 目录

```
docs/                          # ⚠️ 全部由 katana-task 生成,勿手动改
├── index.html
├── app.js
├── style.css
└── data/prs.json              # 最近 30 天所有 PR 快照
.github/workflows/pages.yml    # docs/ 变动 → 部署 Pages
```

## GitHub Pages 配置

repo **Settings → Pages → Source** 选 **GitHub Actions**。线上地址:

> https://wang-neo.github.io/pr-board/

## 想改看板 / 逻辑?

去 [`katana-task/scripts/pr-board`](https://github.com/wang-neo/katana-task/tree/main/scripts/pr-board) 改 `site/` 或脚本,本仓库只是它的产出。
