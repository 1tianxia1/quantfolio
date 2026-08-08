# tdx-bridge — 通达信真实行情桥接

把**真实行情**灌入 QuantFolio 本地库，让早盘页（`/morning`）、收盘页（`/closing`）和
个股详情抽屉的 K 线/技术指标从「演示数据（derived）」切换成「实盘数据（real）」。

> ⚠️ **关于网络连通性（实测结论）**：本桥接需要直连通达信行情服务器（`pytdx` + 公网 UDP/TCP）。
> 注意：`select_best_ip()` 会去拉一份**远程 IP 列表**（HTTP），在受限网络下会**挂死**，
> 但**直连已知行情服务器 IP 是可达的**。脚本已内置 `TDX_HOST`/`TDX_PORT` 环境变量直连开关，
> 设置后即可绕过 `select_best_ip`：
>
> ```bash
> export TDX_HOST=180.153.18.170 TDX_PORT=7709   # 沙箱实测 0.1s 连上；也可换其他可达的 7709 服务器
> ```
> 因此无论在本 WorkBuddy 沙箱还是你自己的联网机器，都能跑真实同步；只是不能用 `select_best_ip` 自动选优。

---

## 数据流（端到端）

```
通达信服务器
   │  pytdx (sync.py)
   ▼
securities 表          ← 证券主数据（code/name/type/market/board…），data_origin='real'
   │  作为 universe
   ▼
quote_sync.py          ← 逐只拉日 K 线(category=9)，本地算 MA/MACD/RSI/KDJ/各交叉
   │  导出
   ▼
scripts/_tdx_import/quotes.json
   │  node scripts/import-tdx-quotes.mjs
   ▼
daily_quotes 表        ← 每日 OHLCV/估值，data_origin='real'
tech_indicators 表     ← 技术指标，data_origin='real'
   │  被后端读取
   ▼
/api/screener/pipeline/run   → 早盘/收盘筛选
/api/market/kline            → 详情抽屉 K 线
```

灌库语句均带 `ON CONFLICT(code,trade_date) DO UPDATE`，**可重复运行、幂等**。

---

## 1. 准备 Python 环境（只需一次）

需要 Python 3.10+。`pytdx` 是纯 Python，pip 即可安装：

```bash
cd tdx-bridge
python -m venv .venv
# Windows
.venv\Scripts\python.exe -m pip install -U pip pytdx
# macOS / Linux
python3 -m venv .venv && .venv/bin/pip install -U pip pytdx
```

验证安装（不联网也能 import）：
```bash
.venv/Scripts/python.exe -c "import pytdx, sys; print('pytdx ok', pytdx.__version__)"
```

> 离线自检：直接 `python quote_sync.py --help` 能正常打印说明即代表脚本语法/依赖 OK
> （pytdx 为懒导入，无网络只影响实际抓取，不影响导入与指标计算）。

---

## 2. 一键同步（推荐）

`quote_sync.py` 已内置「抓取 → 算指标 → 导出 JSON → 调用 import 脚本灌库」全流程：

```bash
# 先确保 securities 已有真实证券主数据（首次或增量时跑）
export TDX_HOST=180.153.18.170 TDX_PORT=7709
.venv/Scripts/python.exe sync.py

# 拉日线（默认近 250 根，覆盖 A 股/基金/指数）
.venv/Scripts/python.exe quote_sync.py --days 250

# 仅调试前 50 只、只导出不灌库：
.venv/Scripts/python.exe quote_sync.py --days 60 --limit 50 --no-import
```

> 全量（约 4.7 万只）跑批机制：`quote_sync.py` 已改为**每 300 只分批写 JSON 并立即灌库**（避免单文件几 GB 撑爆内存），并**每 500 只重连一次**行情服务器防止会话被断开。部分停牌/退市/无数据品种会被 `fetch_bars` 优雅跳过（`拿不到就跳过，绝不编造`）。

抓取前会校验「当天是否为交易日」（`tradingday.is_trading_day`，默认跳过非交易日）。
测试想绕过守卫可加 `--no-check`。

---

## 3. 手动分步（等价于上面的一键，便于排查）

```bash
# ① 导出 JSON（不灌库）
.venv/Scripts/python.exe quote_sync.py --no-import --out scripts/_tdx_import/quotes.json

# ② 用 Node 灌库（DB_PATH 可覆盖目标库）
DB_PATH=/abs/path/to/server/data/quantfolio.db \
  node scripts/import-tdx-quotes.mjs scripts/_tdx_import/quotes.json
```

技术指标计算是纯函数 `compute_indicators(bars)`，可离线单测，不依赖任何网络。
想离线造样例数据，可参考 `tdx-bridge/_gen_fixture.py`（生成 fixture 后导入验证用）。

---

## 4. 每日定时（可选）

`setup-cron.sh` 提供在交易日 16:30 自动跑 `quote_sync.py` 的 cron 模板
（Windows 用任务计划程序，macOS/Linux 用 crontab）。编辑其中的 python 路径与项目根即可。

---

## 5. 与演示数据的关系

- 种子库（77 条）的 `data_origin='derived'`，仅为功能演示，**真实股票无行情**。
- 本桥接灌入的 `data_origin='real'`，与 derived 共存，后端按 code 命中 real 优先展示。
- 前端在检测到存在 `derived` lineage 时会显示「演示数据」黄色告警；
  接满 real 数据后可忽略或移除 `MorningScreen/ClosingScreen` 里的 `demoMode` 提示。

## 文件清单

| 文件 | 作用 |
|------|------|
| `sync.py` | 同步证券主数据到 `securities`（real） |
| `quote_sync.py` | 拉日 K 线 + 计算技术指标 + 导出/灌库 |
| `tradingday.py` | 交易日守卫（节假日/周末） |
| `tdx_client.py` | pytdx 连接封装（含 best-ip 选择） |
| `server.mjs` | 可选：本地 HTTP 桥接服务（供后端按需调用） |
| `setup-cron.sh` | 定时任务模板 |
| `_gen_fixture.py` | 离线 fixture 生成（测试用，非生产） |
