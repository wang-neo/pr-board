# Katana Server PR Board

Daily PR report for [bosinc/katana-server](https://github.com/bosinc/katana-server), sends to Slack and deploys a dashboard to GitHub Pages.

## GitHub Repo Secrets 配置

在 repo 的 **Settings → Secrets and variables → Actions** 中配置：

### 必填

| Secret | 说明 |
|--------|------|
| `PR_REPORT_GITHUB_TOKEN` | GitHub Personal Access Token，需要 `repo` 权限读取 katana-server 的 PR |
| `SLACK_BOT_TOKEN` | Slack Bot Token (`xoxb-...`)，需要 `chat:write`、`conversations:write` scope |
| `SLACK_USER_ID` | 你接收 DM 的 Slack Member ID（右键头像 → Copy Member ID） |

### 可选（AI 摘要）

不配置 `AI_API_KEY` 则自动跳过 AI 功能，降级为纯 PR 列表。

| Secret | 默认值 | 说明 |
|--------|--------|------|
| `AI_API_KEY` | — | AI 服务的 API Key |
| `AI_BASE_URL` | OpenAI 官方 | 自定义 API 地址，支持任何 OpenAI 兼容接口 |
| `AI_MODEL` | `gpt-4o-mini` | 模型名称 |
| `AI_MAX_TOKENS` | `300` | 最大 token 数 |

**AI 服务配置示例：**

```
# OpenAI
AI_API_KEY=sk-xxx

# DeepSeek
AI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat

# 通义千问
AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_MODEL=qwen-plus

# 本地 Ollama
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=llama3
```

## GitHub Pages 配置

在 repo 的 **Settings → Pages**：
1. Source 选择 **GitHub Actions**
2. 部署会随 workflow 自动完成

## Slack App 创建步骤

1. 前往 [api.slack.com/apps](https://api.slack.com/apps) → Create New App
2. **OAuth & Permissions** 添加 Bot Token Scopes：
   - `chat:write`
   - `conversations:write`
3. Install App to Workspace，获取 `xoxb-...` token
4. 在你的 Slack 个人资料中复制 Member ID

## 手动触发

除了每天北京时间 9:00 自动运行，也可以手动触发：

```bash
gh workflow run daily-pr-report.yml
```

## 项目结构

```
.github/
├── workflows/daily-pr-report.yml   # 定时任务 + Pages 部署
└── scripts/pr-report/
    ├── package.json
    └── report.mjs                  # 核心脚本
docs/
├── index.html                      # 前端页面
├── style.css
└── app.js                          # Tailwind + Lucide + Bento Grid
data/reports/                        # 运行后自动生成
├── index.json                      # 报告索引
└── YYYY-MM-DD.json                 # 每日报告数据
```
