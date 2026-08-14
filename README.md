# quantfolio

> A 股 + 场外基金个人投资组合平台：一体化本地全栈方案，覆盖**持仓再平衡、早盘/尾盘智能选股、回测调参、分析中心**四大场景。

quantfolio 是一个面向个人投资者的本地一体化投资组合平台，后端基于 Node/Express + SQLite，前端基于 React（Vite），并内置 Python 通达信行情桥（tdx-bridge）。平台在本地即可完成从行情快照、持仓再平衡、智能选股到策略回测与分析诊断的全流程，所有 AI 能力支持用户自带密钥（BYOK）。

---

## 1. 项目简介

quantfolio 定位于「A 股 + 场外基金」个人投资组合管理，将多个分散的投资工作流整合到同一套本地全栈平台中，既保证数据可控，又提供可复现的量化分析能力。

### 1.1 模块概览

- **持仓再平衡（/portfolio）**：组合仪表盘，跟踪持仓与目标配置的差异，给出再平衡建议。
- **早盘选股（/morning）**：基于「早盘七步法」工作流，在开盘前对标的池进行筛选与打分。
- **尾盘选股器（尾盘五步法）**：收盘前按五步流程筛选尾盘机会标的。
- **我的自选（/watchlist）**：自选标的维护与跟踪。
- **智能分析中心（/analysis）**：结合技术面、资金面与 AI 诊断的多维分析。
- **回测调参（/backtest）**：策略回测与参数寻优。

---

## 2. 功能特性

- **场外基金净值**：通过 `fundNavService` 同步场外基金净值，支持基金类资产纳入组合管理。
- **实时行情**：基于种子标的池（97 个真实标的）的实时/收盘快照，支持多数据源切换与兜底。
- **AI 智能诊断**：分析中心接入大模型（默认 SiliconFlow DeepSeek），对标的进行诊断与摘要；支持用户 BYOK 自选厂商。
- **策略回测与调参**：`backtestService` 提供回测框架与参数调优能力。
- **持仓再平衡**：对比实际持仓与目标权重，自动计算再平衡动作。
- **早/尾盘选股**：内置早盘七步法、尾盘五步法筛选流程。
- **游客演示模式**：未登录自动展示只读演示数据，便于快速体验。
- **本地可控数据**：默认 SQLite 存储，所有数据留存本地，支持明文 BYOK 密钥本地保存。

---

## 3. 技术栈

| 类别 | 技术 | 版本 / 说明 |
| --- | --- | --- |
| 后端框架 | Express | ^4.19.2 |
| 后端语言 | Node.js | engines.node `>=18.0.0`（推荐 20/22 LTS） |
| 认证 / 加密 | jsonwebtoken / bcryptjs | jsonwebtoken ^9.0.2；bcryptjs 用于密码哈希 |
| 校验 | zod | Schema 校验 |
| HTTP 客户端 | undici | 服务端请求 |
| 跨域 / 配置 | cors / dotenv | 跨域与环境变量加载 |
| 数据库驱动（三层兜底） | better-sqlite3 → node:sqlite → sql.js | ① better-sqlite3 ^11.3.0（首选同步原生）；② node:sqlite（Node>=22.5 内置）；③ sql.js（纯 JS 内存 + 手动 flush） |
| 前端框架 | React / react-dom | ^18.3.1 |
| 前端路由 | react-router-dom | ^6.26.0 |
| UI 组件库 | @mui/material / @mui/x-data-grid | ^5.16 / ^7.22 |
| 样式 | @emotion/* / tailwindcss | emotion 配套；tailwindcss ^3.4（devDep） |
| 图表 | echarts / echarts-for-react | 可视化 |
| 状态管理 | zustand | ^4.5.4 |
| HTTP 客户端（前端） | axios | 接口请求 |
| 构建工具 | Vite | ^5.4（devDep） |
| 开发语言（前端） | TypeScript | ^5.5（devDep） |
| AI 默认厂商 | SiliconFlow | `AI_PROVIDER=siliconflow` |
| AI 默认模型 | DeepSeek | `deepseek-ai/DeepSeek-V4-Flash` |
| AI 视觉模型 | Qwen | `Qwen/Qwen3-VL-32B-Instruct` |
| 行情桥 | Python 通达信桥 | tdx-bridge（独立 Python 服务） |

---

## 4. 环境要求

- **Node.js**：`>=18`（推荐 20 / 22 LTS；`>=22.5` 时自带 `node:sqlite` 可作为数据库驱动第二层兜底）。
- **npm**：`>=9`。
- **Python**（可选）：仅当使用 `tdx-bridge` 通达信行情桥时需要。
- **操作系统**：Windows / macOS / Linux 均支持；生产部署示例基于 Linux（腾讯云）。

---

## 5. 快速开始

### 5.1 一键启动脚本

仓库提供跨平台启动脚本，自动完成「检查 Node → 安装依赖 → 生成 `.env` → 导入种子 → 并行启动前后端」：

- **Windows**：双击 `start.bat`
- **macOS / Linux**：`chmod +x start.sh && ./start.sh`

### 5.2 手动启动

```bash
# 1. 安装依赖（前端 + 后端 + 共享）
npm run install-all

# 2. 准备环境变量
cp .env.example .env          # 根 .env 模板
# 如需生产级行情源，另准备 server/.env（见第 8 章）

# 3. 导入种子数据（97 个真实标的等）
npm run seed

# 4. 启动开发环境（前后端并行）
npm run dev
```

启动后：

- 前端开发地址：**http://localhost:5173**（Vite 代理 `/api` → 3001）
- 后端服务地址：**http://localhost:3001**
- 探活接口：**http://localhost:3001/api/health**

> ⚠️ **AI 配置注意**：本项目使用 `AI_API_KEY` 作为大模型密钥变量名（旧版密钥变量名已废弃，请勿继续使用）。在 `.env` 中填写 `AI_API_KEY`、`AI_PROVIDER`、`AI_MODEL`、`AI_BASE_URL` 即可启用默认 AI 能力；也可在「模型设置」页 BYOK 自选厂商。

---

## 6. 常用命令

| 命令 | 作用 | 说明 |
| --- | --- | --- |
| `npm run dev` | 启动开发环境 | 通过 concurrently 并行启动前端（5173）与后端（3001） |
| `npm run seed` | 导入种子数据 | 写入 97 个真实标的等种子数据 |
| `npm run test` | 运行测试 | 服务端 vitest |
| `npm run build` | 构建前端 | 仅前端 `tsc -b && vite build`，产物 `client/dist` |
| `npm run start:server` | 启动后端（生产） | `node server/src/index.js`；**根无 `start` 命令，生产请用此命令** |
| `npm run start:client` | 启动前端预览 | `vite preview` |
| `npm run install-all` | 安装全部依赖 | 根 + server + client |

> 注：根 `package.json` **没有 `start` 命令**，生产启动请使用 `npm run start:server`。后端自身 `scripts`：`dev=nodemon src/index.js`、`start=node src/index.js`、`seed=node src/seed/run.js`、`test=vitest run`。

---

## 7. 项目结构

```
quantfolio/
├── client/            # 前端（React + Vite + TypeScript）
│   └── src/
│       ├── App.tsx    # 路由：/、/portfolio、/morning、/strategies（我的策略，含尾盘选股器）、/watchlist、/analysis、/backtest、/settings
│       └── ...
├── server/            # 后端（Node/Express）
│   ├── src/
│   │   ├── index.js   # 入口：openDatabase→initSchema→createApp→app.listen(PORT)
│   │   ├── db/
│   │   │   └── driver.js   # 数据库驱动三层兜底链
│   │   ├── services/        # 业务服务
│   │   │   ├── analysis/        # 分析中心相关服务
│   │   │   ├── backtestService.js   # 回测调参
│   │   │   ├── aiService.js         # AI 诊断
│   │   │   ├── portfolioService.js  # 持仓再平衡
│   │   │   ├── screenerService.js    # 早/尾盘选股
│   │   │   └── fundNavService.js     # 场外基金净值同步
│   │   ├── ai/
│   │   │   └── providers.js   # BYOK 厂商注册表
│   │   ├── util/
│   │   │   └── indicators.js  # 技术指标（含 volumeStreak 定义）
│   │   └── seed/run.js        # 种子数据导入
│   └── package.json
├── shared/            # 前后端共享 TS 常量
├── tdx-bridge/        # Python 通达信行情桥（独立服务，默认 5599 端口）
├── scripts/           # 脚本工具
├── data/              # 种子数据
├── docs/              # 文档
├── package.json       # 根：dev / build / seed / test / start:server / install-all
├── deploy.sh          # 部署打包脚本
└── deploy-server.sh   # 部署远端执行脚本
```

**启动流程（server/src/index.js）**：`openDatabase → initSchema → createApp → app.listen(PORT)`；启动后异步执行 `fundNavService.syncFundNav`、`intradayPoller`、`startMarketScheduler`、`refreshJob`。Express 托管 `client/dist`，非 `/api` 请求通过 SPA fallback 返回 `index.html`。

---

## 8. 配置说明

### 8.1 关键环境变量

| 变量 | 示例 / 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 后端服务端口（可被 `.env` 覆盖） |
| `JWT_SECRET` | `[待填写]` | JWT 签名密钥 |
| `JWT_EXPIRES_IN` | `604800` | Token 有效期（秒，7 天） |
| `DB_PATH` | `server/data/quantfolio.db` | SQLite 数据库路径（可改） |
| `DATA_PROVIDER` | `sqlite`（根）/ `eastmoney`（server/.env） | 行情数据源 |
| `EM_KLINE_SOURCE` | `tencent` | 东财 K 线兜底来源（腾讯 qt.gtimg.cn） |
| `AI_PROVIDER` | `siliconflow` | AI 厂商 |
| `AI_API_KEY` | `[待填写]` | 大模型密钥（旧版密钥变量名已废弃，请统一使用此变量） |
| `AI_MODEL` | `deepseek-ai/DeepSeek-V4-Flash` | 默认模型 |
| `AI_BASE_URL` | `https://api.siliconflow.cn/v1/chat/completions` | API 地址 |
| `AI_VISION_MODEL` | `Qwen/Qwen3-VL-32B-Instruct` | 视觉模型 |
| `TDX_BRIDGE_URL` | `http://localhost:5599` | 通达信行情桥地址 |
| `AUTO_REFRESH_ENABLED` | `false`（server/.env） | 自动刷新开关 |

### 8.2 数据源（DATA_PROVIDER）与加载优先级

- `env.js` 中 `DATA_PROVIDER` **默认值为 `sqlite`**（使用本地派生/种子数据）。
- 生产部署通过 `server/.env` **显式覆盖为 `eastmoney`**，以获取实时行情源；**风险仅存在于缺失 `server/.env` 时**，此时回退到根 `.env` 的 `sqlite` 默认值，表现为「走旧/本地数据」。
- `EM_KLINE_SOURCE=tencent` 的原因：直连腾讯 `qt.gtimg.cn` 获取真实行情；当东财（emClient）触发熔断或数据缺失时，由腾讯源兜底，保证 K 线可用。
- **env 加载优先级**：`shell 环境变量 > server/.env > 根 .env`（dotenv 先加载 `server/.env`，其取值压过根 `.env`）。

### 8.3 端口

- 后端默认 `3001`（`env.PORT`，可被 `.env` 覆盖）。
- 前端开发 `5173`，生产由后端托管 `client/dist`，统一通过 `3001` 访问。

### 8.4 数据库

- **默认路径**：`DB_PATH=server/data/quantfolio.db`（可通过环境变量修改）。
- **数据表（共 16 张）**：`users`、`securities`、`security_tags`、`daily_quotes`、`tech_indicators`、`money_flow`、`auction_data`、`limit_records`、`hot_sectors`、`holdings`、`target_allocations`、`user_settings`、`strategies`、`ai_reports`、`watchlist`、`meta_kv`。
- **数据来源标注**：业务表携带 `data_origin` 字段，取值为 `real`（真实行情）、`derived`（派生/模拟）、`mixed`（混合），用于区分数据真实性（详见第 11 章）。

---

## 9. 部署

以下为基于 `deploy.sh` / `deploy-server.sh` 实测的命令链。生产机示例：`root@SERVER_IP`，仓库目录 `/root/quantfolio`。

### 9.1 自动化部署（推荐）

**1）本地打包**（排除 node_modules / data / .git / client/dist / 压缩包 / .workbuddy）：

```bash
tar -czf quantfolio-update.tar.gz \
  --exclude=node_modules --exclude=data --exclude=.git \
  --exclude=client/dist --exclude=*.tar.gz --exclude=.workbuddy \
  server client package.json package-lock.json \
  start.bat start.sh checkpoint.sh rollback.sh
```

**2）上传到生产机**：

```bash
scp quantfolio-update.tar.gz root@SERVER_IP:/root/quantfolio/
```

**3）远端执行**（备份 → 停止旧进程 → 解压 → 安装生产依赖 → pm2 拉起）：

```bash
# 远端：备份与停止
pm2 stop quantfolio || pkill -f "node.*index.js"

# 远端：解压后进入 server 安装生产依赖
cd /root/quantfolio && tar -xzf quantfolio-update.tar.gz
cd server && npm install --production

# 远端：pm2 启动（已在 cd server 目录下，入口为 src/index.js）
pm2 start src/index.js --name quantfolio --watch false
```

> ⚠️ **`server/.env` 必须随包上传**：生产环境依赖 `server/.env` 覆盖数据源与开关，而根 `.env` 不在上述 tar 清单中，不会自动带上。请务必确认 `server/.env` 已就位，否则将回退到 `sqlite` 本地数据。

### 9.2 手动运维（备选，运维惯例）

> 以下为可选的人工运维方式（约定目录 `/opt/quantfolio`），非自动化脚本强制路径。

- 进程目录约定：`/opt/quantfolio`（与脚本默认 `/root/quantfolio` 区分，按实际环境选择）。
- 查端口占用：`ss -ltnp | grep 3001`。
- 后台启动：`setsid node server/src/index.js > /var/log/quantfolio.log 2>&1 &`（或 `npm run start:server`）。

---

## 10. 主要模块说明

- **持仓仪表盘（/portfolio）**：基于 `portfolioService` 对比实际持仓与目标配置权重，给出再平衡建议与差异视图。
- **早盘七步法（/morning）**：项目内置的早盘选股工作流，按既定七步顺序完成盘前标的筛选与打分，逻辑由 `server/src/services/screenerService.js` 实现。
- **尾盘五步法 / 尾盘选股器（/strategies）**：收盘前的尾盘选股器工作流，按五步顺序筛选尾盘机会标的，与早盘选股共用 `screenerService`；入口位于「我的策略」页 `/strategies`。
- **我的自选（/watchlist）**：自选标的的维护、跟踪与快速查看。
- **智能分析中心（/analysis）**：结合技术面、资金面与 AI 诊断（`aiService` + `analysis/`）的多维分析视图。
- **回测调参（/backtest）**：基于 `backtestService` 的策略回测与参数寻优界面。
- **模型设置（/settings）**：BYOK 自选 AI 厂商、填写与测试密钥、管理本地模型配置。

---

## 11. 数据真实性与合规说明

- **标的池**：恒为种子数据中的 **97 个真实标的**（代码/名称真实）。
- **实时快照字段**：`price` / `changePct` / `turnoverRate` / `circMarketCap` / `amount` / `mainNetInflow` / `limitUp` / `tags` 为 **2026-08-07 通达信真实收盘快照**。
- **历史 K 线**：250 日历史 K 线由「以代码为种子的确定性算法」派生，末根锚定真实收盘价，**幂等可复现**（非真实历史成交）。
- **UI 提示**：页面顶部统一提示「行情截至 2026-08-07 收盘，历史 K 线为模拟数据，最新价为真实行情」。
- **合规**：本平台内容为量化模型输出，**不构成投资建议**。

---

## 12. 游客演示模式

未登录用户访问时，平台**自动展示只读演示数据**，可浏览全部功能界面与示例结果；任何**保存 / 编辑操作将返回 `401`** 并引导登录。该模式便于快速体验，不写入任何个人数据。

---

## 13. 自定义 AI 模型（BYOK）

用户可在「模型设置」页 **BYOK 自选厂商**，支持：SiliconFlow / DeepSeek / OpenAI / Anthropic / Gemini / 智谱 / Moonshot / 通义 / Ollama / 自定义。

- **配置与验证**：填写密钥后先「测试连接」，通过后再保存。
- **存储**：密钥明文存于本地 SQLite（`user_ai_config` 表），前端以掩码形式回显。
- **协议**：支持 OpenAI 兼容协议与 Anthropic 原生协议。
- **回落策略**：用户未配置 / 调用失败 → 回退服务端默认配置 → 再失败则本地规则兜底生成摘要（**不白屏**）。
- **扩展厂商**：在 `server/src/ai/providers.js` 注册表中追加即可。

> 默认服务端配置：`AI_PROVIDER=siliconflow`、`AI_MODEL=deepseek-ai/DeepSeek-V4-Flash`、`AI_BASE_URL=https://api.siliconflow.cn/v1/chat/completions`、视觉模型 `AI_VISION_MODEL=Qwen/Qwen3-VL-32B-Instruct`。

---

## 14. 常见问题 FAQ

**Q1：为什么行情像是「旧数据」？**
A：`DATA_PROVIDER` 在 `env.js` 中默认 `sqlite`（本地数据）。生产部署依赖 `server/.env` 显式覆盖为 `eastmoney` 才能走实时源；**若 `server/.env` 缺失**，将回退到根 `.env` 的 `sqlite` 默认值，表现为走旧/本地数据。请确认 `server/.env` 已随部署包上传（见第 9 章）。

**Q2：`volumeStreak`（放量连涨/连跌）的含义与传统量比不同？**
A：本项目在 `server/src/util/indicators.js` 中**自定义**了该指标——以 `window=20` 日均量为基线，`threshold=1.5`，判定「放量」为 `v > base * 1.5`。这是项目自定义语义，**并非传统量比（volume ratio）**，阅读指标时请注意区分。

**Q3：东财接口限流/不可用怎么办？**
A：已配置 `EM_KLINE_SOURCE=tencent`，直连腾讯 `qt.gtimg.cn` 获取真实行情；当东财 `emClient` 触发熔断或数据缺失时，自动由腾讯源兜底，保证 K 线可用。

**Q4：端口 3001 被占用？**
A：修改 `.env` 中的 `PORT`（或 shell 环境变量）为其他端口即可，前端开发代理与后端监听均随该值变化。

**Q5：`better-sqlite3` 安装/编译失败？**
A：数据库驱动采用**三层兜底链**（`server/src/db/driver.js`）：① better-sqlite3（首选同步原生）→ ② node:sqlite（Node>=22.5 内置）→ ③ sql.js（纯 JS 内存 + 手动 flush）。原生模块编译失败时，可升级 Node 至 `>=22.5` 启用内置 `node:sqlite`，或使用 `sql.js` 纯 JS 方案，无需编译。

**Q6：生产启动用哪个命令？**
A：根 `package.json` **没有 `start`** 命令，生产请使用 `npm run start:server`（等价于 `node server/src/index.js`）。开发并行启动用 `npm run dev`。

---

## 15. 免责声明

- 本平台所有内容（含行情快照、AI 诊断、回测结果、选股建议）均为量化模型输出，**不构成任何投资建议或收益承诺**。
- **投资有风险，入市需谨慎**。用户应独立判断并自行承担投资决策的全部风险与后果。
- 历史 K 线为模拟派生数据，仅用于演示与回溯，**不代表真实历史成交**。
- 平台默认在本地存储数据；使用 BYOK 时密钥以明文存于本地数据库，请妥善保管运行环境与 `.env` 文件。

---

> 文档版本说明：本 README 内容基于仓库源码核实编写，技术栈版本、命令与路径均以实际工程为准；未确认的具体取值以 `[待填写]` 标注，请按实际环境补充。
