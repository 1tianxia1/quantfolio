# QuantFolio 代码实现总结（CODE_SUMMARY）

> 版本：v1.1 　|　撰写：寇豆码（Kou，Engineer）　|　日期：2026-08-07
> 上游输入：DESIGN.md v1.1（高见远）＋ PRD v1.0（许清楚）＋ SCREENING_RULES.md v1.0 ＋ seed-market.json

---

## 一、实现概览

QuantFolio 为「持仓管理 + 智能选股」本地全栈平台，三大模块全部落地：

| 模块 | 实现 |
|---|---|
| 模块一：组合仪表盘 | 持仓 CRUD、实时估值、5 张汇总卡、配置环形图（资产类别/行业/个股三维度）、目标配置（Σ=100 校验）、再平衡建议（100 股向下取整 + 现金警示）、AI 持仓诊断（GLM + 缓存 + 本地降级） |
| 模块二：早盘选股 | 早盘七步法漏斗（竞价Top60 → 量比Top30 → 竞价3-5% → 流通<10亿(宽松<30亿) → 多头含60日线 → 主线板块 → 首笔爆量）、竞价涨幅 Top60 独立榜、通用早盘筛选器、AI 早盘点评 |
| 模块三：尾盘选股器 | 尾盘五步法漏斗（涨幅3-5% → 换手5-20% → 流通50-500亿 → 连续放量3-5日 → 多头排列+上方空间≥8%）、通用量化指标筛选（MACD/RSI/KDJ/均线/量能/PE/市值/涨跌幅 AND 组合）、C-11 综合评分、AI 量化解读、CSV 导出（UTF-8 BOM） |

### 架构落地情况

- 后端：**分层架构**（routes → services → models → providers）+ **DataProvider 适配器**（`DATA_PROVIDER=sqlite|http` 切换）
- 前端：Vite + React 18 + TS + MUI + Tailwind（preflight 关闭）+ ECharts + zustand
- 共享：根目录 `shared/constants.js`（纯 ESM，涨跌色/错误码/枚举唯一来源）＋ `constants.d.ts` 类型声明
- 数据库：16 张表（users/securities/security_tags/daily_quotes/tech_indicators/money_flow/auction_data/limit_records/hot_sectors/holdings/target_allocations/user_settings/strategies/ai_reports/watchlist/meta_kv）

---

## 二、文件清单（实际交付）

- 根目录（8）：`package.json`、`start.bat`、`start.sh`、`.env.example`、`.env`、`README.md`、`shared/constants.js`、`shared/constants.d.ts`
- server（58 + vitest.config.js）：`src/` 54 个 + `tests/` 4 个，全部按 DESIGN §2.2 清单实现
- client（53 源码 + 8 配置）：`src/` 53 个 + `index.html/vite.config.ts/tsconfig*/tailwind/postcss/package.json`

> 相比 DESIGN §2 文件清单，额外新增：`scripts/install-all.js`（根 postinstall 顺序装双端依赖）、`server/vitest.config.js`（外部化 node:sqlite 原生模块，单测必需）、`client/tsconfig.node.json`（vite 配置 TS 工程引用）、`client/src/api/market.ts` 的 `WatchItem` 等类型。未删减任何设计文件。

---

## 三、关键设计决策

1. **数据库驱动降级链**（硬约束 1）：`server/src/db/driver.js` 是全项目唯一 import better-sqlite3 的文件；本机 Windows 实测 better-sqlite3@11.3.0 原生绑定安装失败（缺 prebuilt），自动降级 **Node 22.22 内置 `node:sqlite`**（DatabaseSync，同步 API 与 better-sqlite3 兼容），已验证 seed/服务/单测全部可用。如需切回 better-sqlite3 只需修 driver.js 一个文件。
2. **派生 K 线幂等 + 末根锚定**（硬约束 2）：`seed/klineGenerator.js` 以 `mulberry32(hash(code))` 生成 250 根日线；前 249 根随机游走 + 缩放使 close[248] = `price/(1+changePct/100)`，末根 close=price、pct_chg=changePct、pre_close 精确反推。verify 断言 97/97 通过、同 code 两次生成一致。
3. **形态模板注入**（提升漏斗演示效果）：对涨幅 2.5~6.5% 的股票注入「冲高(60日窗口内 14~22%)→回落 6~9 日→稳步回升」形态，使尾盘五步法第 5 步（多头+空间≥8%）有真实命中（实测 双鹭药业/鹭燕医药 通过，评分 95）；对流通市值 <30 亿小盘股注入竞价高开 3~5%，使早盘七步法宽松模式有候选。
4. **双通道标签**（U4 已知限制）：`indicator_hit`（计算值）与 `security_tags`（通达信真实 tags）并列，筛选用 OR；verify 输出命中率报告（MACD金叉 15~25%、多头排列 75%），不强行 100% 一致。
5. **单位约定**（硬约束 3）：mainNetInflow 元→万元（÷10000）；amount 存元；circMarketCap 元→亿元（÷1e8）；dividendYield 小数→×100 百分比。前端先求和后舍入。
6. **AI 服务**（硬约束 9）：Node 原生 fetch + AbortController（20s）调智谱 GLM-4-flash；Key 仅后端 `.env`；失败返回本地规则版兜底摘要（prompts.js 三套模板 + aiService.js 降级），页面不白屏；`ai_reports` 按「用户+ref_key+交易日」缓存，支持强制刷新。

---

## 四、自检结果（完成标准对照）

| 项 | 结果 |
|---|---|
| 1. 全部文件按 DESIGN §2 清单 | ✅ 根 8 + server 58 + client 61，无缺失 |
| 2. `npm install` 双端 | ✅ server/client 均成功；better-sqlite3 原生绑定失败 → 已启用 node:sqlite 降级链 |
| 3. `npm run seed` | ✅ 97 只标的、16 张表、24250 行 K 线；verify 全部通过（末根锚定 97/97、指标最新日无 NULL、幂等一致、真实资金流 19 只） |
| 4. 后端 `npm test` | ✅ 4 个文件 27 个用例全绿（score/rebalance/indicators/pipeline） |
| 5. 后端启动（3001） | ✅ `GET /api/health` 返回 `{success:true, db:'ok'}` |
| 6. 前端 `npm run build` | ✅ tsc -b + vite build 通过（1648 模块，chunk>500kB 仅为体积告警） |
| 7. 全局一致性审查 | ✅ 见下节 |
| 8. `docs/CODE_SUMMARY.md` | ✅ 本文 |

### 全局一致性审查结论

- 跨文件 import：后端相对路径 `../../../shared/constants.js` 深度一致；前端 `@shared/constants` alias + tsconfig paths 与 vite fs.allow 已配置，构建通过。
- API 路径前后端对齐：前端 api/*.ts 全部与 server/src/routes/*.js 匹配（auth/portfolio/screener/strategies/ai/market/health），实测代理 + 直连均通。
- 字段命名一致：`total_asset / current_pct / deviation_pct / hit_tags / hit_step_tags / score_detail.factors` 等前后端一致。
- 数据流正确：评分池 = 当日全市场池（保证可复现）；再平衡建议 100 股向下取整；CSV 导出 UTF-8 BOM 中文正常。
- 无重复实现：CSV 解析/导出、指标纯函数、评分模型均单点实现。

**IS_PASS: YES**

---

## 五、已知限制（QA 应知）

1. **早盘七步法常空结果（U1）**：种子 97 只中流通市值 <10 亿的标的极少（仅 国航远洋 28 亿、山外山 24 亿，均 >10 亿），严格模式第 4 步必然为 0；宽松模式（<30亿）下有 1 只候选，但第 5 步（多头含 60 日线 + 空间≥8%）可能继续淘汰。UI 已内置提示 + 宽松开关 + 通用筛选兜底。**这是设计意图，不是 bug。**
   > ⚠️ **2026-08-08 实测修正（D6）**：上述结论基于**早期种子池（97 只）**。当前运行库已扩展至全市场（实测 N≈36697 只），此时早盘恒空的真正根因是 `circ_mv` 缺失率高达 99.79%（可参与筛选基数仅 77 只），而非「种子池无小盘」。排查早盘/尾盘空结果时，请先以 `SELECT COUNT(*) FROM securities` 与 `circ_mv`/`turnover_rate` 的 NULL 占比为准，不要再以「97 只种子池」推断。服务端 `pipeline/run` 已返回 `dataReady/dataHint/fieldStats` 供前端提示数据完备性。
2. **尾盘五步法结果少**：五步同时满足本身极严格，当前池中通常 0~2 只命中（实测 双鹭药业/鹭燕医药）。属方法论硬过滤，UI 有漏斗淘汰原因展示。
3. **MACD金叉 计算命中率偏低（U4）**：真实 tags 与派生 K 线计算值无法 100% 对齐（25% 左右），靠双通道 OR 语义兜底；verify 输出命中率报告供评估。
4. **better-sqlite3 未启用**：本机最终走 node:sqlite（Node 22.22 内置），日志会打印 `ExperimentalWarning: SQLite is an experimental feature`，不影响功能；生产建议换 Node 22.13+ 或装好 better-sqlite3。
5. **AI 未配置 Key**：`.env` 中 `ZHIPU_API_KEY` 为空时所有 AI 面板返回本地规则版摘要（含免责提示），不会白屏；配置 Key 后即走 GLM-4-flash 真实调用。
6. **单日数据语义（U2）**：种子只有 2026-08-07 一个交易日，「昨日/当日」均为该快照语义；竞价由派生 open 反推。
7. **早盘七步法第 7 步首笔量比**：种子由确定性 rng 派生（约 40% ≥2），属模拟字段，UI 已标注数据来源。

---

## 六、如何启动

```bash
# Windows
start.bat

# macOS / Linux
chmod +x start.sh && ./start.sh

# 或手动
npm install          # 根 + server + client
cp .env.example .env # 可选：填写 ZHIPU_API_KEY
npm run seed
npm run dev          # 前端 5173 / 后端 3001
```

- 登录：先注册或点「先逛逛（演示模式）」
- 三模块入口：组合仪表盘 `/portfolio`、早盘选股 `/morning`、尾盘选股器 `/closing`
- 测试：`npm test`（后端单测）｜构建：`npm run build`

---

## 七、缺陷修复记录

### R3 · P1 计算缺陷：同一 target_key 下多行持仓被重复套用完整类别目标

**发现方式**：主理人真实端到端链路实测。

**复现场景**：持仓 = 600519 贵州茅台 100 股（市值 140000）+ 现金 50000 + 现金备用 30000，总资产 220000；
目标 `dimension='asset_class'` → stock 60% / cash 40%；调用 `POST /api/portfolio/rebalance {threshold:5}`。

| | 修复前 | 修复后 |
|---|---|---|
| cash 类别占比判定依据 | 单行占比（22.73% / 13.64%） | 分组占比 36.36% |
| cash 类别偏离 | 单行 −17.27pt / −26.36pt，**双双误判超阈值** | −3.64pt，**低于阈值 5 → 不出建议** |
| threshold=5 建议 | 现金备用 BUY 58000 + 现金 BUY 38000 = **96000** | **0 条** |
| threshold=1 建议 | 同上 96000 | 现金 BUY 5000 + 现金备用 BUY 3000 = **8000**（= 类别真实缺口） |

**根因（两处，同一个口径错误）**

1. `server/src/services/portfolioService.js:116`
   `deviationPct = h.current_pct - targetPct`：`current_pct` 是**单行**占总资产比，`targetPct` 是**整个 target_key 分组**的目标，两者口径不对等。
   同文件 `buildAllocation` 早已按 key 聚合，说明设计意图本就是分组口径，只是行级计算漏了这一步。
2. `server/src/services/rebalanceService.js:43-50`
   逐行遍历 holdings，每行都用整个类别的 `tgt` 算 `targetValue`，再减掉**单行**的 `market_value`。
   同类别 N 行 → N 条重复建议，每条都按完整类别目标超额计算。

仅 `dimension='code'`（一 key 一行）时两者碰巧等价，这正是原 42 条用例未覆盖到的盲区。

**修复方案（根因修复，非打补丁）**

- 新增 `groupByTargetKey()` 作为**唯一分组口径**，被 `buildAllocation()`、持仓行 `group_*` 字段、再平衡三处共用，从结构上杜绝口径分叉。
  分组占比由「分组市值 ÷ 总资产」直接算出，遵循 money.js「先求和后舍入」约定。
- 持仓行字段语义明确化：`current_pct` 仍为行级；新增 `group_current_pct` / `group_market_value` / `group_deviation_pct`；
  `deviation_pct` **统一为分组口径**（= `group_deviation_pct`）；行级偏离降级为仅供参考的 `row_deviation_pct`。
- 再平衡改为**先按 target_key 分组算缺口，再按各行 market_value 等比分摊**：
  仅当 `|group_deviation_pct| ≥ threshold` 才生成建议；SELL 单行不超过持仓市值（覆盖整行时允许破整手清仓）；
  BUY 时分组下无持仓行则输出 `is_group_level=true` 的类别整体建议；现金多行按金额等比分摊；
  分摊后各自取整、`suggest_amount` 由取整后股数回算，残差在 `summary.rounding_residual_*` 对账。
- `dimension='code'` 分组自然退化为单行，行为与修复前完全一致（已加用例锁定）。
- `cash_available` 的多行现金 Σ 求和逻辑（R2 已修复）原样保留，未触碰。

**影响面**

| 文件 | 改动 |
|---|---|
| `server/src/services/portfolioService.js` | 新增 `groupByTargetKey()`；`buildSummary` 改分组口径；`buildAllocation` 改为消费分组结果 |
| `server/src/services/rebalanceService.js` | 整体重写为「分组算缺口 → 按市值分摊到行」 |
| `server/tests/rebalance_grouping.test.js` | 新增 11 条分组口径回归用例 |
| `server/tests/qa_regression_r2.test.js` | R2-1 断言修正：原 `2600` 是逐行错误口径的产物，正确分组结果为 `3800`（1520 + 2280） |
| `client/src/api/portfolio.ts` | Holding / AllocationItem / RebalanceSuggestion / summary 类型补齐新字段 |
| `client/src/components/portfolio/HoldingsTable.tsx` | 新增「类别占比」列；「偏离 / 目标占比」改名「类别偏离 / 类别目标」以匹配分组语义 |
| `client/src/components/portfolio/RebalancePanel.tsx` | 偏离展示改用 `group_current_pct`；多行分摊时标注「本行占类别缺口的份额」；新增取整对账行 |
| `client/src/components/portfolio/AllocationPanel.tsx` | 无需改动（其消费的 `current_pct/target_pct/deviation_pct` 本就是分组口径，契约不变） |
| `docs/DESIGN.md` | 新增 §4.2.1 分组口径契约；§5 类图字段同步；时序图与文件清单同步 |
| `scripts/verify-p1-rebalance.mjs` | 新增端到端复现验证脚本 |

**验证结果**

- `cd server && npm test` → **7 个测试文件 / 53 用例全绿**（原 42 + 新增 11）
- `cd client && npm run build` → `tsc -b` + `vite build` 通过
- `node scripts/verify-p1-rebalance.mjs` → 真实 HTTP 链路 6 项判定全部 ✅，96000 荒谬建议已消失

---

*文档结束*
