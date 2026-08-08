# QuantFolio QA 测试报告

> 版本：v1.0　|　撰写：严过关（Edward，QA Engineer）　|　日期：2026-08-07
> 测试对象：`quantfolio` 全栈项目（后端 Express+node:sqlite / 前端 Vite+React+MUI+Tailwind）
> 上游输入：PRD v1.0 ＋ SCREENING_RULES v1.0 ＋ DESIGN v1.1 ＋ CODE_SUMMARY v1.1

---

## 一、测试范围与方法

| 环节 | 方法 | 结果 |
|---|---|---|
| 静态代码审查 | 逐文件审阅评分/管线/再平衡/鉴权/种子/路由/前端 API | 见 §三 |
| 后端单元测试 | `cd server && npm test`（vitest） | 39/39 通过 |
| 种子幂等性 | `npm run seed` 连续执行 2 次 | 幂等，无报错 |
| 末根锚定抽查 | DB 末根 close/pct_chg/pre_close 与 `seed-market.json` 比对（3 股 + 1 基金） | 全部精确匹配 |
| 后端冒烟 | 启动 server:3001，实测 30+ 个关键 API 请求 | 全部符合预期 |
| 前端构建 | `cd client && npm run build`（tsc -b + vite build） | 通过（仅 chunk>500kB 体积告警） |
| 前端冒烟 | Vite dev:5173 首页 200 + `/api` 代理通 | 通过 |

---

## 二、测试结果统计

| 项目 | 数量 |
|---|---|
| 原有单元测试（score/rebalance/indicators/pipeline） | 27 用例，4 文件，全绿 |
| **QA 新增单元测试**（`server/tests/qa_extra.test.js`） | **12 用例**（尾盘边界 6 + 宽松模式 2 + 再平衡 2 + 用户隔离 2） |
| **QA 第 2 轮回归测试**（`server/tests/qa_regression_r2.test.js`） | **3 用例**（多行现金求和 2 + saveSettings 布尔归一化 1） |
| 单元测试合计 | **42/42 通过（100%）** |
| 种子重跑 | 97 标的 / daily_quotes 24250 行 / tech_indicators 24250 行，两遍一致 |
| API 冒烟 | 注册/登录/游客/汇总/再平衡/漏斗/宽松/AI 降级/用户隔离/策略/CSV/自选/市场 全部通过 |
| 发现 P0 级缺陷 | **0** |
| 发现 P1 级缺陷 | **0** |
| 发现 P2 级/设计注 | 5 条（见 §四；其中 2 条源码建议已在第 2 轮修复并回归通过） |

**最终结论：PASS（第 2 轮回归后维持；2 条 P2 源码建议已闭环）**

---

## 三、静态审查结论

### 3.1 评分模型与权重（DESIGN §7 / SCREENING_RULES 对照）

| 项 | 结论 |
|---|---|
| 尾盘五步法默认阈值（涨幅3-5 / 换手5-20 / 流通50-500亿 / 连放3-5日 / 多头+空间≥8%） | ✅ `config/screening-defaults.js` 与 SCREENING_RULES 精确一致 |
| 尾盘五步法评分（放量30/涨幅20/换手15/多头20/空间15，Σ=100） | ✅ `scoreService.scoreClosingPipeline` 与 §7.4 一致；放量 4/5 日 +10 封顶 50，总分钳制 [0,100] |
| 早盘七步法默认阈值（竞价Top60 / 量比Top30 / 竞价3-5% / <10亿 / 多头含60日线+空间≥8% / 主线板块 / 首笔量比≥2） | ✅ 与 SCREENING_RULES 一致 |
| 早盘七步法评分（量比25/竞价20/竞价量比15/连板20/板块15/首笔5） | ✅ 与 §7.4 一致 |
| **早盘第 4 步 <10亿 与尾盘第 3 步 50-500亿 口径相反** | ✅ 实现为相反阈值，符合设计意图（SCREENING_RULES §五 明确「不得统一」） |
| M-03 早盘通用评分权重 20/20/20/15/15/10 | ✅ `config/scoring.js` 一致 |
| C-11 尾盘通用评分权重 35/25/25/15 | ✅ 一致 |
| 分位归一化池 = 当日全市场可筛池 | ✅ `scoreService.getPool()` 用全市场股票池，保证可复现 |

### 3.2 数据库 Schema（DESIGN §3 对照）

- ✅ 16 张表全部存在且字段与 DESIGN §3 DDL 一致：users/securities/security_tags/daily_quotes/tech_indicators/money_flow/auction_data/limit_records/hot_sectors/holdings/target_allocations/user_settings/strategies/ai_reports/watchlist/meta_kv
- ✅ 行情类表 `data_origin` 字段齐全（securities/daily_quotes/tech_indicators/money_flow/auction_data/hot_sectors）
- ✅ 单位约定：circ_mv/total_mv 存亿元、amount 存元、money_flow 存万元、dividend_yield ×100（代码审查确认）

### 3.3 种子派生（幂等 + 末根锚定）

- ✅ `seed/klineGenerator.js`：mulberry32(code) 确定性派生，同 code 两次生成一致（verify 断言通过）
- ✅ 末根 `close=price`、`pct_chg=changePct`、`pre_close=price/(1+pct/100)` 精确反推（verify 97/97 + 独立抽查 4 只全部精确）
- ✅ `npm run seed` 幂等：连续 2 次执行无报错、数据量一致

### 3.4 鉴权与用户隔离

- ✅ JWT 中间件（required/optional 双模式）；`POST /api/portfolio/holdings` 未登录 → 401；读操作游客落 demo
- ✅ bcryptjs saltRounds=10 哈希，响应不含 password_hash
- ✅ 用户隔离：holdings/targets/strategies 查询均带 `user_id IS ?`（`IS` 兼容 NULL demo）；单元测试 + API 实测 A/B 互不可见、B 无法越权改 A

### 3.5 前后端 API 对齐

- ✅ `client/src/api/*.ts` 与 `server/src/routes/*Routes.js` 逐条比对一致（auth/portfolio/screener/strategies/ai/market/health）；vite proxy `/api`→3001 实测通

---

## 四、问题清单（含路由判定）

| # | 级别 | 问题 | 位置 | 路由判定 | 建议 |
|---|---|---|---|---|---|
| 1 | P2 | `GET /api/market/kline?days=3` 实际返回 10 根（路由 `Math.max(10, ...)` 钳制），与 DESIGN §4.6 未声明最小值的契约略有偏差；前端默认 120 无影响 | `server/src/routes/marketRoutes.js:29` | **设计冲突（轻微）** | 前端无需改；如需严格按 days 返回，删除 min 钳制或补文档说明最小 10 根 |
| 2 | P2 | 再平衡现金可用额 `cashAvailable = h.quantity` 在「多行现金持仓」时会取最后一行，导致可用现金口径偏差 | `server/src/services/rebalanceService.js` | **源码 Bug → 已修复 ✅（R2 回归通过）** | 工程师已改为循环外对全部 cash 行 Σ 求和（`rebalanceService.js:39-41`）；R2 多行现金测试 `cash_available=5000`（两行 2000+3000）通过 |
| 3 | P2 | 早盘第 2 步 `vol_ratio_top30` 实现为「Top30 **且** 量比≥1.5」；SCREENING_RULES 原文为「Top30（默认，可配）；**或** volume_ratio ≥ 1.5」，二者为替代关系。当前池中 77 只股 Top30 基本都 >1.5，结果无实质偏差 | `server/src/services/pipelineService.js:134-166`、`config/screening-defaults.js:58` | **设计冲突（语义）** | 供主理人/架构师确认「或」语义；若按替代关系，可将 min 视为可选开关 |
| 4 | P2 | `portfolioService.saveSettings` 直传布尔 `morning_loose_mode` 到 service 层时，node:sqlite 无法绑定布尔值报错（HTTP 路由已转 0/1） | `server/src/services/portfolioService.js:197-206` | **源码 Bug → 已修复 ✅（R2 回归通过）** | 工程师已在 service 内统一 `Boolean→0/1`（`portfolioService.js:203`）；R2 直接传 `true/false` 不再抛错且落库 1/0 通过 |
| 5 | P2 | `user_settings.morning_loose_mode` 被保存但管线服务端不读取（仅读请求体 `loose_mode`）；前端 MorningScreen 由复选框显式传参，行为一致，该列实为「偏好展示」 | `server/src/services/pipelineService.js:28` | **设计注** | 保持现状或后续由服务端读设置兜底 |
| 6 | 注 | 早盘七步法在真实 97 只池中最终命中 0 只（严格第 4 步 0 只；宽松第 4 步 1 只 [山外山 24亿/国航远洋 28亿] 但被第 5-7 步淘汰） | — | **设计意图（CODE_SUMMARY U1）** | 非 bug；UI 已内置宽松开关 + 通用筛选兜底 |
| 7 | 注 | 种子池无 600519 等高价蓝筹；持仓输入池外代码时按成本价估值（Q1 设计） | — | **设计注** | UI 已标注「净值待更新」，建议搜索提示限定种子池 |
| 8 | 注 | better-sqlite3 原生绑定失败，实际走 node:sqlite（Node 22.22 内置），日志有 ExperimentalWarning | `server/src/db/driver.js` | **已知限制（CODE_SUMMARY #4）** | 功能不受影响；生产建议换 Node 22.13+ 或装好 better-sqlite3 |

> 说明：以上 1-5 条均为 P2 级，**不阻塞交付**；其中 #2（多现金行求和）与 #4（布尔归一化）已在第 2 轮回归中验证修复并关闭，见 §六·B；6-8 为设计意图/已知限制。

---

## 五、与 PRD §6 交付验收清单逐条对照（14 条）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 能注册→登录→登出，密码 bcrypt 哈希非明文 | ✅ PASS | 注册/登录（用户名+邮箱）实测 200；bcrypt hashSync salt=10（代码审查）；登出为语义接口 |
| 2 | 未登录访问三大模块看到演示数据，保存/编辑引导登录 | ✅ PASS | 游客 GET holdings 返回 10 行 demo；游客 POST holdings→401「请先登录」；游客建策略→401 |
| 3 | 两个用户持仓/目标/策略互不可见 | ✅ PASS | API 实测 A/B 互不可见；单测 QA-4 覆盖（含越权修改被拒） |
| 4 | 录入持仓后仪表盘正确显示总资产/盈亏/盈亏率/明细/占比 | ✅ PASS | summary 手算比对精确匹配（35022）；明细行 market_value=quantity×current_price 全对；占比求和 100% |
| 5 | 设置目标配置后看到配置对比图与偏离度；调整阈值后调仓建议变化 | ✅ PASS | 目标保存 Σ=100 校验（Σ=60→400）；summary 输出 allocation 偏离度；rebalance 阈值生效（单测） |
| 6 | 再平衡建议明确买入/卖出+股数+金额，股票按 100 股取整 | ✅ PASS | rebalance 返回 BUY/SELL+股数+金额；所有股票建议均为 100 整数倍（单测精确断言 300 股） |
| 7 | 早盘 7 类条件均可用，结果含评分与入选理由标签 | ✅ PASS | 通用早盘筛选可用；七步法漏斗每步 survivors/eliminated/top_reasons；结果含 score 与 hit_tags |
| 8 | 尾盘 9 类指标均可用，多条件 AND 生效，结果含命中标签与 0-100 评分 | ✅ PASS | 通用尾盘筛选多条件 AND 实测（pct+MA+放量+换手 → 30 只）；命中标签与评分齐全 |
| 9 | 早盘/尾盘策略均可保存、列出、一键应用、删除 | ✅ PASS | strategies CRUD 实测：创建/重命名/删除；游客 401；删除预置 403 |
| 10 | 尾盘结果可导出 CSV，中文不乱码 | ✅ PASS | export.csv 实测 UTF-8 BOM（EF BB BF）存在，中文表头正常 |
| 11 | 三处 AI 均为 GLM-4-flash 真实调用，Key 在 .env，前端不可见 | ⚠️ PARTIAL | 代码审查：aiService 用 fetch 调 GLM-4-flash、Key 仅后端 .env、前端无 Key 接触；**未配 Key 无法验证真实调用**，降级路径已验证 |
| 12 | AI 调用失败时页面有兜底提示，不白屏 | ✅ PASS | 未配 Key 时 diagnose/morning/interpret 均返回 success:true + 本地规则版摘要（含「AI 服务暂不可用」标注） |
| 13 | 涨红跌绿配色全站统一 | ✅ PASS | shared/constants.js 红涨绿跌为唯一来源；theme+format.ts 统一引用；构建通过 |
| 14 | 一键启动脚本后浏览器打开即可用（含种子数据） | ⚠️ PARTIAL | seed 幂等 + 双端构建/开发服务器可用 + vite 代理通；未实际跑 start.bat 全流程（Windows 脚本可读性检查通过） |

> ⚠️ PARTIAL 项说明：#11 受「未配置 ZHIPU_API_KEY」限制，真实 GLM 调用链路未做端到端验证（降级链路已充分验证）；#14 各组成部分（seed/构建/双端启动/代理）均验证通过，未整体跑一次 start.bat。

---

## 六、QA 新增测试清单（server/tests/qa_extra.test.js，12 用例）

| 分组 | 用例 | 覆盖点 |
|---|---|---|
| QA-1 尾盘五步法边界 | 涨幅恰好 3% 通过 / 2.99% 淘汰 | 下边界含等于 |
| | 涨幅恰好 5% 通过 / 5.01% 淘汰 | 上边界含等于 |
| | 换手恰好 20% 通过 / 20.01% 淘汰 | 上边界含等于 |
| | 流通盘恰好 500亿 通过 / 500.01亿 淘汰 | 上边界含等于 |
| | 流通盘恰好 50亿 通过 / 49.99亿 淘汰 | 下边界含等于 |
| | 连续放量恰好 3 天通过 / 2 天淘汰 / 6 天超上限淘汰 | 上下边界 |
| QA-2 早盘宽松模式 | 严格 <10亿 vs 宽松 <30亿（looseMax）开关生效 | 宽松模式核心逻辑 |
| | morning_loose_mode 持久化到 user_settings（0/1 契约） | 设置持久化 |
| QA-3 再平衡 | 100 股向下取整精确断言（300 股，非四舍五入） | P-10 取整规则 |
| | 现金不足 balance_ok=false 且 need_cash>0 | P-11 现金校验 |
| QA-4 用户隔离 | 用户 A / B / 游客 demo 的 holdings 互不可见 | A-06 隔离 |
| | A 修改持仓不影响 B；B 无法越权修改 A | 越权防护 |

---

## 六·B、第 2 轮回归验证（R2，2026-08-07）

> 触发：工程师（寇豆码）按 QA §四 修复 2 条 P2 源码建议后，QA 独立复核 + 全量回归。

### R2 代码复核（根因确认，非打补丁）

| 修复项 | 改动位置 | 复核结论 |
|---|---|---|
| 1) cashAvailable 多行现金求和 | `server/src/services/rebalanceService.js:39-41` | ✅ 根因修复：原在循环内 `cashAvailable = h.quantity`（每行覆盖、只留最后一行）；现改为循环外对 `asset_class='cash'` 全部行 `Σ quantity`，与建议项完全对应 |
| 2) saveSettings 布尔归一化 | `server/src/services/portfolioService.js:203` | ✅ 根因修复：原直传 JS boolean 给 node:sqlite 绑定报错；现 service 层统一 `payload.morning_loose_mode ? 1 : 0`，与路由层预转形成双保险 |

### R2 测试统计

- 全量单测：**42/42 通过**（27 原有 + 12 QA 新增 + **3 条 R2 回归新增**）
- 新增回归用例（`server/tests/qa_regression_r2.test.js`，3 用例）：
  - **R2-1 多行现金求和**：构造 2 行现金（2000 + 3000）+ 1 只股票，调 `rebalance.suggest` → `cash_available = 5000`（修复前为最后一行 3000）✅；两行现金 SELL 建议合计 2600 ✅；`balance_ok=true` ✅
  - **R2-1b 极端目标**：股票 99.9% / 现金 0.1%，多行现金下 `cash_available=5000` 且 `need_cash≥0`、建议股数 100 整数倍 ✅
  - **R2-2 布尔归一化**：直接 `saveSettings(uid, { morning_loose_mode: true })` 不再抛 node:sqlite 绑定错误，落库为 1；`false`→0；数值 1/0 兼容；未传字段不覆盖 ✅

### R2 结论

- §四 问题 #2（多现金行）与 #4（布尔归一化）：**已修复，回归通过，关闭**
- 其余 P2 设计冲突/设计注 3 条（#1 kline days 钳制、#3 早盘第 2 步「或」语义、#5 设置未服务端读取）维持原判定，不阻塞交付
- 第 2 轮未发现新增缺陷

---

## 六·C、第 3 轮回归验证（R3，2026-08-08）

> 触发：主理人（齐活林）在真实端到端链路中发现 **P1 计算缺陷**，工程师（寇豆码）重写再平衡与分组逻辑后，QA 独立复核 + 全量回归 + 覆盖盲区反思。

### C.1 P1 缺陷描述与根因

**现象（修复前）**：茅台 100 股（¥140,000）+ 现金 ¥50,000 + 现金备用 ¥30,000，总资产 ¥220,000，目标 `stock 60% / cash 40%`，`threshold=5`：

```
现金备用行：220000×40% − 30000 = 58000  → BUY 58000
现金行    ：220000×40% − 50000 = 38000  → BUY 38000
合计 96000，而 cash 类别真实缺口只有 8000，且 −3.64pt 根本没超阈值 5
```

**根因**：`target_pct` 的语义是「**整个 target_key 分组**的目标百分比」，旧实现却逐行遍历 `holdings`，**每一行都拿完整的类别目标去减自己单行的市值**。同一 `target_key` 下有 N 行持仓时，类别目标被重复套用 N 次，缺口被放大约 N 倍（本例 96000 / 8000 = 12 倍，因为两行各自基数都远小于类别目标）。

**缺陷类型**：分组语义（多对一映射）与行级计算口径错配。`dimension='code'` 时一 key 一行，分组退化为单行，两种算法**碰巧等价**——这正是它躲过前两轮 42 个用例的原因。

### C.2 代码复核结论（独立复核，非照单全收）

| 复核项 | 位置 | 结论 |
|---|---|---|
| 分组口径唯一性 | `portfolioService.js:265 groupByTargetKey` | ✅ 真正唯一。`buildSummary` 只调用一次 `groupByTargetKey`，产出的 `groups` 同时喂给「持仓行 group_* 字段」与 `buildAllocation(groups, …)`；`rebalanceService.buildRebalanceGroups` 由已带 `group_*` 的持仓行归拢，不再自算。全仓库无第二套聚合逻辑残留（grep `reduce.*market_value` 仅命中分摊基数与对账，非独立聚合） |
| 分组占比算法 | `portfolioService.js:288` | ✅ `group.market_value / totalAsset` 直接算，未把各行已 `round2` 的 `current_pct` 相加，符合 money.js「先求和后舍入」约定 |
| 阈值判定口径 | `rebalanceService.js:78-79` | ✅ 用 `g.group_deviation_pct`，与 UI/allocation 同源 |
| 分组缺口计算 | `rebalanceService.js:81-82` | ✅ `totalAsset×target_pct/100 − Σ(rows.market_value)`，数学正确 |
| 等比分摊 | `rebalanceService.js:125-128` | ✅ `weight = rowValue / baseTotal`，Σweight=1，缺口守恒（R3-2 实测三行残差 ≤0.05 元） |
| SELL 单行封顶 | `rebalanceService.js:131` | ✅ `Math.min(rowGap, rowValue)`。数学上 SELL 时 `groupGap ≤ current_value` 恒成立故封顶不会触发，属防御性写法，无害 |
| 清仓破整手 | `rebalanceService.js:162` | ✅ 仅当分摊额覆盖整行市值才允许，边界 `−0.01` 容差合理 |
| 取整与残差对账 | `rebalanceService.js:167-168, 198-201` | ✅ `suggest_amount = shares × price` 回算；`residual = planned − 实际` 恒非负（向下取整），R3-2 实测残差 < 一手金额 |
| `dimension='code'` 无回归 | — | ✅ 一 key 一行时 `group_current_pct === current_pct`、`deviation_pct === row_deviation_pct`，G-4 + R3 实测一致。**附带改进**：同一 code 分批建仓（两行同码）现在也能正确聚合，旧实现会重复套用 |
| R2 修复未被弄回去 | `rebalanceService.js:62-64` / `portfolioService.js:226` | ✅ 多行现金 `cash_available` 仍为 Σ 求和（e2e 实测 80000）；`saveSettings` 布尔归一化仍在，R2-2 用例绿 |
| 前后端契约对齐 | `client/src/api/portfolio.ts` | ✅ `group_current_pct` / `group_market_value` / `group_deviation_pct` / `row_deviation_pct` / `is_group_level` / `planned_*` / `rounding_residual_*` 与后端实际返回逐字段一致；`AllocationPanel.tsx` 未改正确（本就是分组口径） |
| prompt 口径 | `ai/prompts.js:24-29` | ✅ 已区分「本行占比」与「类别占比/类别目标/类别偏离」 |

### C.3 ★ R2-1 断言变更（2600 → 3800）的独立推导

工程师把上一轮 QA 亲手写的 `totalCashSell ≈ 2600` 改成了 `3800`。**独立推导如下**：

**输入**：股票 600999 收盘价 10 × 100 股 = ¥1,000；现金A ¥2,000；现金B ¥3,000 → **总资产 ¥6,000**；目标 `stock 80% / cash 20%`，`threshold=1`。

**正确的分组口径推导**：
```
cash 分组现市值 = 2000 + 3000                = 5000
cash 分组目标市值 = 6000 × 20%               = 1200
cash 分组缺口   = 1200 − 5000                = −3800  → 卖出 3800
等比分摊：现金A 2000/5000 × 3800             = 1520
         现金B 3000/5000 × 3800             = 2280
                                     合计   = 3800  ✓
```

**旧值 2600 的来源**：`现金A: 1200 − 2000 = −800`、`现金B: 1200 − 3000 = −1800`，合计 2600。两行**各自减了一次完整的类别目标 1200**，等于把类别目标用了两次——正是本轮 P1 缺陷本身。

**终局校验（决定性证据）**：
- 按 3800 执行后，cash 余额 = 5000 − 3800 = **1200 = 6000 × 20% ✓ 命中目标**
- 按 2600 执行后，cash 余额 = 5000 − 2600 = 2400 = 6000 × **40% ✗ 是目标的两倍**

**结论：3800 是唯一能让组合落到目标配置上的数值。工程师的修改成立，不是削足适履。** 原 2600 断言是 QA 上一轮**照抄了缺陷实现的输出**（把实现当规格），属**测试 Bug**，改测试正确。判定：**认可，不打回**。

> QA 自我检讨：R2 写这条断言时用的是「跑一遍看输出、觉得合理就固化」的方式，没有独立按「执行后是否命中目标配置」做终局校验。这是把实现当规格的典型反面案例，已列入 C.6 改进项。

### C.4 测试统计

| 项目 | 结果 |
|---|---|
| `cd server && npm test` | **68 用例 / 65 通过 / 3 失败**（8 个文件） |
| 工程师交付的 53 用例（原 42 + 新增 11） | **53/53 全绿** ✅ |
| QA R3 新增 `qa_regression_r3.test.js` | 15 用例 / 12 通过 / **3 失败（全部为 QA 本轮新发现的缺陷，非误报）** |
| `node scripts/verify-p1-rebalance.mjs` | **6/6 判定全绿** ✅ |
| `node scripts/e2e-smoke.mjs` | **24/24 全绿** ✅ |
| `node scripts/qa-r3-industry-http.mjs`（QA 新增） | 15 项 / 14 通过 / 1 失败（= C.5 问题 R3-#1） |
| `cd client && npm run build` | ✅ 通过（tsc -b + vite build，1648 模块，15.48s） |

逐文件确认：`rebalance_grouping 11` + `qa_extra 12` + `pipeline 3` + `qa_regression_r2 3` + `score 11` + `rebalance 4` + `indicators 9` = **53 全绿**；`qa_regression_r3 15`（12 绿 / 3 红）。

**QA R3 新增用例（`server/tests/qa_regression_r3.test.js`）**：

| 用例 | 覆盖角度 | 结果 |
|---|---|---|
| R3-1（4 条） | `dimension='industry'` 多行聚合（`targetKeyOf` 的另一条分支）。银行 2 行 60% vs 目标 50%：**行级偏离 −10pt 与分组偏离 +10pt 符号相反**，旧口径会把「该卖」判成「该买」 | ✅ |
| R3-2（2 条） | 三行同类别等比分摊精度：现金 33333/22222/11113 分摊 ¥26,656.8，合计残差 ≤0.05 元；整手残差非负且 < 一手金额 | ✅ |
| R3-3（2 条） | 目标含 `bond` 但一股没买 → `is_group_level=true` 类别整体建议，不崩、无 NaN、不凭空造持仓行 | ✅ |
| R3-4（2 条） | 矛盾场景：类别整体需 SELL，组内小市值行（0.5% vs 目标 50%，行级 −49.5pt）按旧口径会被判成 BUY ¥99,000 → 断言同一 `target_key` 下 action 唯一 | ✅ |
| R3-5（2 条） | `target_pct` 合计非 100 报 400、±0.01 容差；历史脏数据（Σ=80）不崩且分摊不超各组缺口 | ✅ |
| **R3-6（1 条）** | 跨维度目标污染 | ❌ **新发现 P2** |
| **R3-7（2 条）** | `dimension='code'` + cash 目标凭空造钱 | ❌ **新发现 P1** |

### C.5 本轮新发现的问题清单（含路由判定）

#### R3-#1【P1 · 源码 Bug · 路由→工程师】`dimension='code'` + cash 目标凭空造钱（本次重写新引入）

**复现**：招商银行 2000 股 ¥80,000 + 现金 ¥20,000（总资产 ¥100,000），`dimension='code'`，目标 `600036 50% / cash 50%`，`threshold=5`。

```
实际输出：
  allocation = [{key:'600036', mv:80000}, {key:'cash', mv:0, current_pct:0, deviation_pct:−50}]
  allocation 市值合计 = 80000  ← 用户真实持有的 2 万现金凭空消失（总资产 100000）
  items = [ BUY code=null "cash 类别整体" ¥50000 (is_group_level=true),
            SELL 600036 ¥28000 ]
  summary = { buy_total:50000, need_cash:30000, balance_ok:false, cash_available:20000 }

期望：cash 真实缺口 = 50000 − 20000 = 30000，且用户无需任何外部资金
```

**根因**：`portfolioService.js:242` `targetKeyOf` 的 `code` 分支直接 `return h.code`，现金行 `code` 为 NULL → 被踢出分组；而同函数的 `industry` 分支是**有兜底的**（`h.asset_class==='cash' ? '现金' : '其他'`）。叠加本次新增的「零持仓目标 key 也建空分组」（`groupByTargetKey:281-284`），`cash` 被物化成一个市值 0 的幻影分组，缺口按整个目标值 ¥50,000 输出。

**为何是新引入的回归**：修复前没有空分组回填，`cash` 目标只是被**静默忽略**（不出建议）；现在变成**凭空造出 ¥50,000 买入 + 谎报缺 3 万资金**。这与本轮修复的 P1 属同一族（分组口径把不存在的持仓当 0），严重度同为 P1（错钱、用户可见、UI 会弹「⚠ 所需资金 ¥30,000 超出可用现金」）。

**为何旧用例没抓到**：`rebalance_grouping.test.js` G-4 与 `qa_extra.test.js` QA-3 的 code 维度 cash 目标恰好只配了 `1%` / `0.05%`，`|deviation|` 低于 threshold 被 `continue` 提前跳过，把这条路径整个遮住了。

**建议修复**（二选一，QA 推荐 a）：
```js
// a) portfolioService.js:242 —— 与 industry 分支保持一致，补 cash 兜底
if (dimension === 'code') return h.code ?? (h.asset_class === 'cash' ? 'cash' : null);
// b) 明确不支持 code 维度配 cash：saveTargets 校验拒绝，且空分组回填跳过该 key
```

#### R3-#2【P2 · 源码 Bug · 路由→工程师】不传 `dimension` 时 allocation 混入其它维度的 target_key

**复现**（HTTP 实测）：用户同时配置了 `asset_class`、`industry`、`code` 三个维度的目标，调 `GET /api/portfolio/summary`（**不带** `?dimension`）：

```
active_dimension = asset_class
allocation keys = stock, cash, 601919, 920571, 交通运输, 传媒, 现金
                         └────────── 三个维度的 key 全混在一起，且 dimension 字段一律标成 asset_class ──────────┘
幻影项示例：{dimension:'asset_class', key:'601919', current_pct:0, target_pct:70, deviation_pct:−70}
```

**根因**：`portfolioService.js:108-110` 先 `listTargets(userId, dimension)`（`dimension` 为 `undefined` 时 model 层返回**所有维度**的目标），之后才把 `activeDimension` 从 settings 兜底出来——顺序反了。旧实现下这些多余 key 只是躺在 `targetMap` 里没人匹配；新增的空分组回填把它们**物化成了 allocation 条目**。

**影响面**：`GET /api/portfolio/summary`（无参）与 `aiReportService.js:36 buildSummary(userId)`。前端 `PortfolioDashboard.tsx:49` 始终显式传 dimension，故当前 **UI 不受影响**；AI 诊断 prompt 只消费 `holdings` 与 `concentration`、不消费 `allocation`，故 **AI 输出也不受影响**。`rebalanceService.suggest` 总会解析出 dimension，**再平衡路径安全**。故定 P2（API 契约错误，暂无用户可见后果）。

**建议修复**（一行，先解析维度再取目标）：
```js
const activeDimension = dimension || portfolio.getSettings(userId)?.active_dimension || 'asset_class';
const targets = portfolio.listTargets(userId, activeDimension);   // ← 用 activeDimension，不要用 dimension
```

#### R3-#3【P3 · 优化建议 · 路由→工程师（不阻塞）】code 维度的 group_level 建议丢了 code

`dimension='code'` 下，目标里配了未持有的标的时输出 `{action:'BUY', code:null, name:'601398 类别整体', suggest_shares:0, unit:'元'}`。code 维度的 key 本身**就是证券代码**，应回填 `code = g.key`、文案改为「建仓」而非「类别整体」，并按现价折算 `suggest_shares`，否则前端无法跳转标的、用户拿不到可执行股数。未写成红灯用例，仅记录。

#### 复核旧问题

- §四 P2 #2（多现金行求和）、#4（布尔归一化）：**未被本次重写弄回去**，保持关闭 ✅
- §四 设计冲突/注 3 条（#1 kline days 钳制、#3 早盘第 2 步「或」语义、#5 设置未服务端读取）：维持原判定，不阻塞

### C.6 覆盖盲区反思

**问：为什么前两轮 42 个用例没抓到这个 P1？**

1. **维度选型偏差**：42 个用例中涉及再平衡的，`dimension` 要么是 `asset_class` 但**每个类别只有一行持仓**（`rebalance.test.js` 的 stock 两行是巧合，且目标偏离方向一致未暴露），要么是 `code`（天然一 key 一行）。**从未构造过「一个 target_key 下有 2 行以上持仓」的场景**——而这正是缺陷的唯一触发条件。
2. **退化等价陷阱**：分组算法与行级算法在「一 key 一行」时**输出完全相同**。测试全部落在等价区内，等于没测。
3. **把实现当规格**：R2-1 的 `2600` 断言是跑一遍看输出后固化的，没做「执行后是否命中目标配置」的终局校验（详见 C.3）。这让缺陷不仅没被发现，还被**测试固化成了「正确行为」**——比漏测更危险。
4. **只断言"不崩/格式对"，不断言"钱对"**：旧用例大量使用 `suggest_shares % 100 === 0`、`balance_ok` 这类结构性断言，缺少「Σ建议 ≤ 类别真实缺口」这类**守恒律**断言。守恒律断言是唯一能在不知道正确答案时也能抓出「造钱」的手段。

**问：现在如何保证不再有同类盲区？**

1. **多行强制原则**：凡涉及「按 key 聚合」的功能，测试数据**必须**至少有一个 key 挂 2 行以上（R3-1/R3-2/R3-4 已落地，最多到 3 行）。
2. **守恒律断言常态化**：每条建议 `|suggest_amount| ≤ |group_diff_value| + 1`、`Σ行分摊 == 分组缺口`、`allocation 市值合计 == 总资产`。R3-#1 就是被最后这条守恒律抓出来的。
3. **符号相反哨兵**：专门构造「行级偏离与分组偏离**符号相反**」的数据（R3-1 银行 −10 vs +10、R3-4 工行 −49.5 vs +20.5）。口径一旦退回行级，方向就会反，比数值断言更难蒙混过关。
4. **终局校验代替输出快照**：断言改为「按建议执行后组合是否落到目标配置上」，而不是「当前实现输出了什么」。
5. **阈值遮蔽反模式**：R3-#1 之所以被藏住，是因为旧用例的 cash 目标小到 `|deviation| < threshold` 提前 `continue`。今后每条分组用例都要有一个 `threshold` 足够小、**保证进入计算分支**的配对用例。

**问：还有哪些「多对一映射」存在同样风险？**

| 位置 | 多对一风险 | 本轮状态 |
|---|---|---|
| `dimension='industry'` | 一个行业挂多只股票，是最典型的多对一 | ✅ R3-1 已补齐（4 条 + HTTP 实测），正确 |
| `dimension='code'` 同码分批建仓 | 同一 code 存成两行持仓（分批建仓/不同成本价） | ✅ 已实测正确聚合（旧实现会重复套用，属附带修复） |
| `dimension='code'` 的现金行 | 现金行无 code → 多行现金全部落到同一个"无键"黑洞 | ❌ **R3-#1，P1，已开单** |
| `concentration.industry_map` | `portfolioService.js:151-155` 逐行 `round2` 累加行业占比 | ⚠️ 逐项舍入再求和，违反 money.js 约定，多行同业时误差累积（≤0.01×N）。仅展示用，记为 P3 观察项 |
| `hhi` 集中度 | `Σ current_pct²` 按**行**算，同一标的分两行持仓会低估 HHI（凸函数） | ⚠️ 同属多对一盲区，属指标定义问题，记为 P3 观察项，需产品确认口径 |
| `watchlist` | `market/watchlist` 按 (user, code) 唯一，无聚合语义 | ✅ 无风险 |
| `strategies.conditions` 解析 | 条件数组 → 步骤映射为一对一，`funnel` 按 `step_id` 取值；`runClosingStepOnly` 已验证禁用步骤不改变 survivors | ✅ 无多对一聚合，无风险 |
| `hot_sectors` / 板块聚合 | `market/sectors` 按 sector/industry 聚合多只标的 | ⚠️ 与 allocation 同构，本轮未专项覆盖，建议下轮补 1 条守恒律用例 |

### C.7 R3 结论

**CONDITIONAL PASS（有条件通过）**

- **主线 P1（分组目标当单行目标用）：确认已彻底修复**。根因修复而非打补丁，分组口径真正唯一，`verify-p1-rebalance.mjs` 6/6、`e2e-smoke.mjs` 24/24、工程师 53 用例全绿，`dimension='code'` 无回归，R2 两条 P2 未被弄回去。
- **R2-1 断言由 2600 改为 3800：独立推导确认正确，认可，不打回**（唯一能让 cash 落到 20% 目标的数值；原 2600 是 QA 上一轮把缺陷输出当规格固化的测试 Bug）。
- **但本次重写新引入 1 条 P1 + 1 条 P2**（均由「零持仓目标 key 建空分组」这一新逻辑与既有 `targetKeyOf`/`listTargets` 缺陷叠加产生），已写成红灯用例 R3-6 / R3-7 并附一行级修复方案。
- **放行条件**：R3-#1（P1）修复后重跑 `npm test` 达 68/68，即可转 PASS。R3-#2（P2）当前无用户可见影响，可与 R3-#1 一并修复。R3-#3（P3）不阻塞。

---

## 六·D、第 4 轮最终签章（R4，2026-08-08）

R3 放行条件为「R3-#1（P1）修复后重跑 `npm test` 达 68/68 即可转 PASS」。工程师已提交修复，本轮为**签章验证**：只验证工程师本轮**自主扩大的改动面**，不重做完整回归。

### D.1 ★ QA 15 条断言完整性核验（工程师声明「一个字没动」）

项目**无 git 仓库**（`fatal: not a git repository`），无法 `git diff`，改用**文件取证 + 逐条通读**双重核验：

| 证据 | 结果 |
|---|---|
| `server/tests/qa_regression_r3.test.js` 最后修改时间 | **2026-08-08 11:57:31** |
| 工程师本轮改动时间窗 | portfolioService **12:09:14** / rebalanceService **12:10:20** / rebalance_grouping.test **12:11:50** / client **12:12:16~12:12:59** |
| 时序判定 | QA 文件**早于**工程师整个修复会话，全程未被写入 |
| 文件规模 | 498 行 / 24190 字节 / MD5 `ac86345d891b9fe598090fa229c8777d` |
| 断言计数 | `it` 块 **15** 条、`expect(` 调用 **109** 处，与 R3 交付时一致 |
| 逐条通读 | R3-1~R3-7 七个 describe、15 条用例的断言语义与 R3 原文完全一致；R3-7 第 496 行 `expect(r.summary.need_cash).toBeLessThanOrEqual(0 + 1)`（即「逼出」口径变更的那条）原样在位 |

**结论：工程师声明属实，QA 的 15 条断言未被篡改。** 同理核验 `qa_extra.test.js`（08-07 17:49）、`qa_regression_r2.test.js`（08-08 11:33）亦未被触碰。

### D.2 工程师主动报备的断言变更（G-4 第 272 行）— 认可

原断言 `expect(r.items.find(it => it.unit === '元')).toBeUndefined()` 固化的正是 R3-#1 的缺陷行为（现金 `target_key=null` → 被踢出分组）。修复后现金 10% vs 目标 1% 应输出 SELL ¥900，**原断言必然失败且理应失败**。工程师改为正向断言并补了守恒律（`Σallocation === total_asset`）。**属于「解除缺陷固化」，不是「改测试迁就实现」，认可。**

### D.3 ⚠️ 未报备的改动面（QA 主动发现）

工程师修复摘要只提到 3 个文件，实际改动面还包括：

| 文件 | 时间 | 性质 |
|---|---|---|
| `client/src/api/portfolio.ts` | 12:12:16 | 新增 `is_new_position` / `current_price` 类型定义 |
| `client/src/components/portfolio/RebalancePanel.tsx` | 12:12:34 | 新增「建仓」Chip、不足 1 手提示文案 |
| `client/dist/assets/index-CRusnZM-.js` | 12:12:59 | 前端产物重新构建 |

独立复核：三处均为 R3-#3 的**配套增量渲染**，纯加法、无删除既有逻辑，`npx tsc -b` **零错误**。**功能无问题，但登记为流程项：改动面申报不完整。**

### D.4 ★ need_cash / balance_ok 口径变更的独立判定：**修正，不是掩盖**

这是工程师自主扩大的改动面，也是本轮最高风险项。QA **不复用被测代码**，另写独立现金台账重放（`scripts/qa-r4-signoff.mjs`）：起始现金 = `cash_available`，卖证券 +、买证券 −，现金桶自身不入账，期末现金 ≥ −1 即为「真实可执行」。

**A1 — 指定复核项：`qa_extra` 现金不足场景告警未丢失**

| 指标 | 实测 |
|---|---|
| `balance_ok` | **false** ✅ |
| `need_cash` | **¥900.00**（精确命中，非仅 >0）✅ |
| 独立台账重放期末现金 | **−¥900.00** → 判定不可执行，与 `balance_ok` 一致 ✅ |
| 旧口径同场景 | 同样告警 → **本次改动未削弱该场景** ✅ |

明细：证券买 ¥1000 / 证券卖 ¥0（轻仓 B 卖 99 股不足 1 手被跳过）/ 现金桶卖 ¥98.95 / 手持现金 ¥100。

**A2 — QA 全新构造的现金不足场景（不复用工程师任何用例）**

两只标的均被误配 100%（各项 ≤100 可过 CHECK，Σ=200），持仓 ¥10000 + 现金 ¥100：

- 证券侧买入 ¥10000 > 可用现金 ¥100，且证券侧**零卖出回款**（无内部腾挪空间）
- `balance_ok = false` ✅　`need_cash = ¥9900` ✅　台账重放期末 −¥9900 ✅

**A3 — 反掩盖差分扫描（7 场景 × 2 口径）**

| 场景 | balance_ok | 台账重放期末现金 | 一致 |
|---|---|---|---|
| S1 卖证券补现金（纯内部腾挪，R3-7 原型） | true | +¥48000 | ✅ |
| S2 动用现金买证券（现金充足） | true | +¥40000 | ✅ |
| S3 一边建仓一边减仓（G-6 原型） | true | ¥0 | ✅ |
| S4 industry 维度动用现金加仓（`isCashBucket` 另一分支） | true | +¥10000 | ✅ |
| S5 零现金纯换股 | true | ¥0 | ✅ |
| S6 bond 零持仓类别整体买入 | true | +¥20000 | ✅ |
| S7 卖 9000 买 6000（现金桶偏离被阈值过滤） | true | +¥5000 | ✅ |

- **7/7 场景 `balance_ok` 与独立台账重放完全一致，0 处「不可执行却报平衡」的掩盖。**
- 新旧口径 `balance_ok` 分歧 **0 处** → 改动**没有关掉任何一个既有告警**。

**数学论证（不只靠打点）**：当 Σtarget=100 时守恒律给出 `assetBuy − assetSell = cashSell − cashBuy`，于是新 `balance_ok` ⟺ `cashSell − cashBuy ≤ cashAvailable`，即「现金仓位的净减少不得超过手上现金」——这正是资金可行性的**精确定义**。当 Σtarget≠100（脏数据）时守恒律失效，此时新口径直接比较证券侧收支，A2 已实测仍能告警。**判定：这是把「口径错误」修正为「口径正确」，不是把告警调哑。**

**但发现 1 条新的语义债（P3，见 D.7-#4）**：S3 / S5 / S7 出现 `need_cash > 0` 与 `balance_ok = true` 并存。工程师把 `need_cash` 定义为「卖出未到账前的毛头寸」（`assetBuy − cash`，不扣卖出回款），而 `balance_ok` 用净额。二者口径不同源。**用户不可见**（`RebalancePanel.tsx:53` 仅在 `!balance_ok` 分支渲染 `need_cash`），且方向保守（只会多报不会少报），故不阻塞。

### D.5 R3-#1 `'未分类'` 兜底复核

`asset_class` 有 `NOT NULL + CHECK` 约束，脏数据只能从 `code` 维度构造。造一行 `asset_class='stock'` 且 `code=NULL` 的持仓（按成本价估值 ¥10000，占比 10%）：

| 断言 | 结果 |
|---|---|
| `target_key === '未分类'`（不再是 null） | ✅ |
| 如实进入 allocation，市值 ¥10000 / 占比 10% | ✅ |
| `target_pct === null` 且 `deviation_pct === null`（不谎报偏离） | ✅ |
| ★ 守恒律 `Σ(allocation 市值) === total_asset` | ✅ ¥100000 vs ¥100000 |
| ★ **不产生任何再平衡建议**（被 `target_pct == null` 的 continue 挡住） | ✅ |
| 现金行仍兜底为 `'cash'`，未被「未分类」吞并 | ✅ |
| 其余建议金额有限、非 NaN | ✅ |

**方案 a 落地正确，达成设计意图：进 allocation 如实显示、不进 rebalance、守恒律成立。**

### D.6 R3-#3 建仓价格同源性复核

**C1 正常路径 — 同源 ✅**：招商银行行情落在全局 `MAX(trade_date)=2026-08-07`。持有者 `valuate` 估值价 = **40**；未持有者建仓折股价 = `suggest_amount / suggest_shares` = **40**，`item.current_price` = **40**，`suggest_amount === suggest_shares × 40`。**两处价格不打架。**

**C2 边界路径 — 发现不同源（新 P3）**：`resolveNewPosition` 的取价是 `getQuotes([code])[0] || getLatestQuote(code)`。二者 SQL 口径**不同**：

- `getQuotes` → `WHERE trade_date = (SELECT MAX(trade_date) FROM daily_quotes)`（**全局**快照，与 `valuate` 同源）
- `getLatestQuote` → `WHERE code = ? ORDER BY trade_date DESC LIMIT 1`（**按标的**取最新）

构造一只最新行情停在 `2026-08-01`（早于全局 MAX）的停牌股实测：

| 路径 | 取价 |
|---|---|
| `valuate`（若持有） | **30**（无行情 → 回落成本价，`quote_date=null`） |
| `resolveNewPosition`（未持有建仓） | **88**（走 `getLatestQuote` 回退，拿到 08-01 陈旧价） |

主路径同源、回退路径不同源。因 `resolveNewPosition` 只作用于「未持有」标的，与 `valuate` 不会同时命中同一行，**不会产生同屏价格矛盾**，且金额有限非负、不崩。但陈旧价折股无 `quote_date` / `is_stale` 标记，前端无从提示。**登记为 P3，不阻塞。**

### D.7 R4 遗留技术债清单

| # | 级别 | 内容 | 来源 | 状态 |
|---|---|---|---|---|
| 1 | P3 | `concentration.industry_map` 逐项 `round2` 累加行业占比，违反 money.js「先求和后舍入」约定，多行同业误差累积 ≤0.01×N（`portfolioService.js:156-160`） | R3 观察项 | 仍在，未修，仅展示用 |
| 2 | P3 | `hhi` 按**行**算 `Σ current_pct²`，同一标的分两行持仓会低估集中度（凸函数），属指标定义问题需产品确认口径（`portfolioService.js:155`） | R3 观察项 | 仍在，未修 |
| 3 | P3 | `hot_sectors` / `market/sectors` 板块聚合与 allocation 同构，仍未做守恒律专项覆盖 | R3 观察项 | 仍未覆盖 |
| 4 | P3 | **新增**：`need_cash`（毛头寸 `assetBuy − cash`）与 `balance_ok`（净额）口径不同源，可并存 `need_cash>0 && balance_ok=true`。用户不可见且方向保守 | R4·D.4 | 新开 |
| 5 | P3 | **新增**：`resolveNewPosition` 的 `|| getLatestQuote(code)` 回退与 `valuate` 的全局快照不同源，停牌/数据缺口标的用陈旧价折股且无 stale 标记 | R4·D.6 | 新开 |
| 6 | P3 | **新增**：`'未分类'` 为兜底保留字，若用户真把 `target_key` 命名为「未分类」会与脏数据同组（概率极低） | R4·D.5 | 新开 |
| 7 | 流程 | **新增**：工程师改动面申报不完整（漏报 2 个 client 源文件 + 1 次 dist 构建），功能无问题 | R4·D.3 | 新开 |
| — | 已闭环 | R3-#1（P1）、R3-#2（P2）、R3-#3（P3） | R3 | ✅ 全部关闭 |

### D.8 R4 测试统计（QA 独立复跑，与主理人结果逐项交叉验证一致）

| 项目 | 结果 | 与主理人一致 |
|---|---|---|
| `cd server && npm test` | **71 passed (71) / 8 files** | ✅ |
| └ 逐文件 | qa_regression_r3 **15** / rebalance_grouping **14** / qa_extra **12** / pipeline **3** / qa_regression_r2 **3** / score **11** / rebalance **4** / indicators **9** | ✅ 逐项吻合 |
| `node scripts/verify-p1-rebalance.mjs` | **6/6** 全部通过 | ✅ |
| `node scripts/e2e-smoke.mjs` | **24/24** | ✅ |
| `node scripts/qa-r3-industry-http.mjs` | **15/15** | ✅ |
| `node scripts/qa-r4-signoff.mjs`（QA R4 新增，48 断言） | **48/48** | 新增 |
| `node scripts/qa-r4-live-probe.mjs`（QA R4 新增，线上实例探针） | **12/12** | 新增 |
| `npx tsc -b`（前端类型检查） | **0 error** | 新增 |

用例总数 68 → **71**（工程师新增 3 条锁定 R3-#3 与守恒律，已复核为有效增量，非灌水）。

**线上实例一致性核验**：后端 PID 3388 启动于 **12:13:21**，晚于全部源码改动（12:09~12:12），确认演示实例跑的是修复后代码；`qa-r4-live-probe.mjs` 通过真实 HTTP 复验 R3-#1/#2/#3 三项修复在线生效（12/12）。

### D.9 R4 结论

**PASS（签章通过）**

- R3 放行条件已达成且超额：要求 68/68，实际 **71/71**。
- QA 15 条断言经文件取证 + 逐条通读确认**未被篡改**；G-4 那条自报变更属「解除缺陷固化」，认可。
- `need_cash` / `balance_ok` 口径变更经独立台账重放 7 场景 + 数学论证判定为**修正**，0 处告警削弱，指定复核的现金不足场景 `balance_ok=false / need_cash=900` 精确复现。
- `'未分类'` 兜底、建仓价格同源性主路径均验证正确。
- 新登记 P3 技术债 3 条 + 流程项 1 条，**均不阻塞交付**。

---

## 七、测试环境与收尾

- Node v22.22.2；数据库驱动最终生效 **node:sqlite**（better-sqlite3 绑定缺失自动降级）
- 测试期间未修改 `.env`（ZHIPU_API_KEY 保持空，验证降级路径）
- R2 轮次结束时已停止 3001 / 5173 端口进程
- **R3 轮次**：3001 / 5173 由主理人预先启动，QA 全程复用未重启、未关闭；QA 未新起任何常驻进程，仅执行一次性脚本（`verify-p1-rebalance.mjs` / `e2e-smoke.mjs` / `qa-r3-industry-http.mjs`），验证用持仓数据均已在脚本内清理
- **R4 轮次**：后端 3001（PID **3388**，启动于 12:13:21）/ 前端 5173（PID **3408**）为用户演示实例，QA **全程未停止、未重启**，收尾时二者均确认存活（`/api/health` → `{"status":"ok","db":"ok"}`、`5173` → HTTP 200）
- **R4 数据卫生**：新增脚本 `qa-r4-signoff.mjs` 全程使用**内存库**，不触碰演示库；`qa-r4-live-probe.mjs` 自建临时账号并在脚本内删除持仓，另对首次异常中断残留的探针数据做了二次清理，收尾核验**演示（游客）持仓 10 行保持不变**

---

## 八、最终结论

**PASS（第 4 轮最终签章通过 · R3 放行条件已达成并超额）**

- **主线 P1（分组目标当单行目标用）：已彻底修复并回归通过**（根因修复，分组口径唯一）
- **R3 放行条件**：要求 R3-#1 修复后 `npm test` 达 68/68 → 实际 **71/71**，**条件达成，CONDITIONAL PASS 转 PASS**
- **P0 缺陷：0　P1 缺陷：0　P2 缺陷：0**
- R3 三条新缺陷**全部闭环**：R3-#1（P1，`code` 维度 + cash 目标凭空造钱）、R3-#2（P2，跨维度目标污染）、R3-#3（P3，group_level 丢 code）
- **QA 15 条 R3 断言完整性：确认未被篡改**（无 git 仓库，改用文件取证——QA 文件 mtime 11:57:31 早于工程师全部改动 12:09~12:12；MD5 `ac86345d…`、15 `it` / 109 `expect` 计数一致、逐条通读语义一致）。工程师主动报备的 G-4 断言变更属「解除缺陷固化」，**认可**
- **`need_cash` / `balance_ok` 口径变更独立判定：修正，不是掩盖**。7 场景独立现金台账重放 100% 一致、0 处「不可执行却报平衡」、新旧口径告警分歧 0 处；指定复核的 `qa_extra` 现金不足场景精确复现 `balance_ok=false / need_cash=¥900`；另有 Σtarget=100 守恒律的数学论证支撑
- P3 观察项：**6 条**（R3 遗留 3 条：`industry_map` 逐项舍入、`hhi` 按行算低估、`hot_sectors` 未覆盖；R4 新开 3 条：`need_cash` 毛头寸语义、`resolveNewPosition` 陈旧价回退不同源、`'未分类'` 保留字撞名），**均不阻塞**
- 流程项：1 条（工程师改动面申报不完整，漏报 2 个 client 源文件 + 1 次 dist 构建，功能无问题）
- 历史 P2 源码建议 2 条（多现金行求和、布尔归一化）：**复核未被弄回去，保持关闭**
- 设计冲突/注：3 条（kline days 钳制、早盘第 2 步「或」语义、morning_loose_mode 设置未服务端读取），供主理人决策，不阻塞交付
- 已知限制：早盘七步法真实池 0 命中、better-sqlite3 未启用，均为设计意图/文档化限制，不阻塞交付
- PRD §6 验收：12 项 PASS / 2 项 PARTIAL（#11 GLM 真实调用需配 Key 后复验；#14 start.bat 全流程建议交付前跑一次）
- 测试统计：单元测试 **71 用例 / 71 通过 / 0 失败（8 文件）**；`verify-p1-rebalance` 6/6、`e2e-smoke` 24/24、industry HTTP 15/15、**QA R4 签章脚本 48/48**、**QA R4 线上探针 12/12**、前端 `tsc -b` 0 error
- **演示实例状态**：后端 3001（PID 3388）/ 前端 5173（PID 3408）**全程未停，收尾确认存活**；演示（游客）持仓 10 行未受影响

*QA 报告结束（第 4 轮最终签章完成 · 严过关 / Yan）*
