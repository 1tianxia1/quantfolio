# QuantFolio

面向 A 股个人投资者的「持仓管理 + 智能选股」一体化本地全栈平台。

- **模块一**：个人投资组合再平衡仪表盘（持仓估值 / 目标配置 / 再平衡建议 / AI 诊断）
- **模块二**：早盘选股（早盘七步法漏斗 + 竞价榜 + AI 点评）
- **模块三**：尾盘选股器（尾盘五步法漏斗 + 通用量化指标筛选 + AI 解读）

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js (>=18) + Express + SQLite（better-sqlite3，Windows 装不上自动降级 `node:sqlite`）+ JWT + bcryptjs |
| 前端 | Vite + React 18 + TypeScript + MUI + Tailwind CSS（preflight 关闭）+ ECharts + zustand |
| AI | 可自定义：登录用户在「模型设置」页自选厂商（SiliconFlow / DeepSeek / OpenAI / Anthropic / Gemini / 智谱 / Moonshot / 通义 / Ollama / 自定义）、填写自己的 Key、选择模型；未配置时回落服务端 `.env` 默认（当前默认 SiliconFlow DeepSeek-V4-Flash） |
| 数据 | `data/seed-market.json` —— 2026-08-07 通达信真实收盘快照（97 只标的：77 股 + 20 ETF），历史 K 线由确定性算法派生 |

## 环境要求

- Node.js **>= 18**（推荐 20/22 LTS；Node >= 22.5 自带 `node:sqlite`，可绕过 better-sqlite3 原生模块）
- npm >= 9

## 快速开始

### Windows

双击 `start.bat`，或命令行执行：

```bash
start.bat
```

### macOS / Linux

```bash
chmod +x start.sh
./start.sh
```

脚本会自动：检查 Node → 安装依赖 → 生成 `.env` → 导入种子数据 → 并行启动前后端。

### 手动启动

```bash
# 1. 安装依赖（根 + server + client）
npm install

# 2. 初始化环境变量
cp .env.example .env   # 然后填写 ZHIPU_API_KEY（可选，不填 AI 自动降级为本地规则摘要）

# 3. 导入种子数据
npm run seed

# 4. 启动（前后端并行）
npm run dev
# 前端: http://localhost:5173
# 后端: http://localhost:3001  （GET /api/health 探活）
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 并行启动前后端（开发模式，Vite 热更新 + nodemon） |
| `npm run seed` | 导入/重建种子数据库（幂等可重跑） |
| `npm test` | 后端单元测试（score / rebalance / indicators / pipeline） |
| `npm run build` | 前端 TypeScript 编译 + 生产构建 |
| `npm run install-all` | 安装 server + client 依赖 |

## 数据库

- 默认路径 `server/data/quantfolio.db`（可用 `.env` 的 `DB_PATH` 修改）
- 16 张表：users / securities / security_tags / daily_quotes / tech_indicators / money_flow / auction_data / limit_records / hot_sectors / holdings / target_allocations / user_settings / strategies / ai_reports / watchlist / meta_kv
- 所有业务表带 `data_origin`（real / derived / mixed）合规标注

## 数据真实性与合规说明

- 标的池恒为种子数据中的 **97 个真实标的**（代码/名称真实，绝不编造）
- `price` / `changePct` / `turnoverRate` / `circMarketCap` / `amount` / `mainNetInflow` / `limitUp` / `tags` 为 2026-08-07 通达信真实收盘快照
- 历史 K 线（250 日）由以 `code` 为种子的确定性伪随机算法派生，**末根精确锚定真实收盘价**，同一 code 每次生成结果一致（幂等）
- UI 顶部统一提示：「行情截至 2026-08-07 收盘，历史 K 线为模拟数据，最新价为真实行情」
- 本平台内容为量化模型输出，不构成投资建议，据此操作风险自担

## 游客演示模式

未登录时三大模块自动展示只读演示数据（demo 持仓 + 全市场选股 + AI 缓存），所有「保存 / 编辑」操作返回 401 并引导登录。

## 自定义 AI 模型（BYOK）

平台所有 AI 分析（组合诊断 / 早盘点评 / 尾盘解读）默认使用服务端 `.env` 的 `AI_*` 配置。登录用户可在侧栏 **模型设置** 页改为自己的模型：

1. 选择厂商（SiliconFlow / DeepSeek / OpenAI / Anthropic / Google Gemini / 智谱 GLM / Moonshot / 通义千问 / Ollama 本地 / 自定义）。
2. 选择或填写模型（自定义 / Ollama 可自由填模型 ID 与接口地址）。
3. 填写自己的 API Key，点击 **测试连接** 验证可用性，再 **保存配置**。

保存后，该账号的所有 AI 报告将使用其配置的模型生成；报告面板会显示「模型：厂商 / 模型名」。Key 仅明文存于本地 SQLite（`user_ai_config` 表），前端只回显掩码（如 `sk-****7890`），不暴露明文。

- **协议支持**：OpenAI 兼容（`/chat/completions`）与 Anthropic（`/v1/messages`）两种；OpenAI / 智谱 / DeepSeek / Moonshot / 通义 / Gemini / Ollama 均走 OpenAI 兼容协议，Claude 走原生协议。
- **回落策略**：用户未配置或调用失败时，自动回落服务端 `.env` 默认模型；若默认也不可用，则返回本地规则版兜底摘要（不白屏）。
- **扩展厂商**：在 `server/src/ai/providers.js` 的注册表中追加条目即可（前端通过 `GET /api/ai/providers` 自动拉取，无需改前端）。

## 常见问题

1. **better-sqlite3 安装失败？** 数据库访问全部集中在 `server/src/db/driver.js` 适配层：优先 better-sqlite3，失败自动降级 Node 内置 `node:sqlite`（Node >= 22.5）或纯 JS `sql.js`，只需改 driver.js 一个文件。
2. **AI 无输出 / 白屏？** 未配置 `ZHIPU_API_KEY` 或调用超时（20s）时，后端自动返回本地规则版兜底摘要，页面不会白屏。
3. **早盘七步法结果为空？** 种子池中流通市值 <10 亿的标的极少（架构文档 U1 已知限制），可在早盘模块开启「宽松模式（<30亿）」，或使用通用早盘筛选器。
4. **端口占用？** 修改 `.env` 的 `PORT`（后端）与 `client/vite.config.ts` 的 server.port（前端）。
