# QuantFolio 界面设计方案（全局系统级优化）

> 设计目标：**美观 + 易用**，且符合 A 股个人投资者的看盘习惯。
> 设计语言：**深色优先的「金融终端」美学** —— 分层表面、克制留白、统一圆角/阴影、等宽数字、红涨绿跌。
> 本次为**全局系统级改造**，所有改动仅位于前端视觉/交互层，不改变任何业务逻辑与数据接口。

---

## 一、设计原则

1. **深色优先**：默认深色，长时间看盘不刺眼；浅色作为可切换备选项。
2. **红涨绿跌（不可破）**：涨跌配色继续以 `shared/constants.js` 的 `COLORS` 为唯一来源（`UP=#F5222D` / `DOWN=#00B578`），UI 层通过 `theme.palette.up / down / flat` 引用，禁止硬编码。
3. **分层表面**：三层视觉层级 `背景(默认) → 卡片(paper) → 浮动(阴影)`，用描边+阴影拉开层次，而非靠重色块。
4. **一致性优先**：所有页面共用同一套头部（`PageHeader`）、卡片（`SectionCard`）、空状态（`EmptyState`），杜绝"每个页面各写一套样式"导致的视觉碎片化。
5. **可访问性内建**：键盘焦点环、4.5:1 对比度、44px 触控目标、`prefers-reduced-motion` 降级。

---

## 二、设计 Token 系统（theme/index.ts）

| 类别 | 规则 | 说明 |
|---|---|---|
| 主色 | `#2E7CF6`（冷蓝） | 来自 `COLORS.PRIMARY`，全站交互/强调统一色 |
| 涨跌 | 红涨 `#F5222D` / 绿跌 `#00B578` | A 股习惯，错误态沿用红、成功态沿用绿 |
| 中性背景(深) | `#0E1117` / 卡片 `#161B22` | 来自 `COLORS`，分层 |
| 中性背景(浅) | `#F4F6FA` / 卡片 `#FFFFFF` | 浅色主题配套 |
| 排版 Scale | 12 / 13 / 14 / 15 / 16 / 18 / 20 / 22 / 26 / 30 px | 标题 700、正文 400/500、数值等宽 tabular-nums |
| 圆角 | 按钮/输入 8 · 卡片 14 · Chip 999(胶囊) | 统一形状语言 |
| 阴影 | 6 级，暗色更柔、亮色更挺 | 用 `shadows` 注入主题 |
| 间距 | 沿用 4px 基准（MUI spacing 1/2/3…） | 纵向节奏统一 `mb: 2.5` |

---

## 三、组件级规范

通过 MUI 主题 `components` 覆盖，**一处定义、全站生效**：

- **Button**：去大写、字重 600、圆角 8、悬停微投影、点击下沉 1px。
- **Card / Paper**：圆角 14、1px 描边、outlined 描边色走 `divider`。
- **Table**：表头浅底+加粗+等宽数字；行 hover 高亮；表头/底部分隔线统一。
- **Chip**：胶囊形、字重 600。
- **ToggleButton**：选中态主色淡底+主色描边+主色文字。
- **Input**：圆角 8，聚焦主色描边。
- **Tooltip / Alert / Snackbar**：统一圆角 10、深色浮层、字重 500。
- **ListItemButton（侧栏）**：选中态加**左侧 3px 强调条 + 主色淡底 + 主色图标**。

### 新增三个统一原语（components/common/）

| 组件 | 作用 | 解决的问题 |
|---|---|---|
| `PageHeader` | 统一页面头部：标题 + 副标题 + 图标徽标 + 右侧操作区 | 消灭各页面"手写标题栏"的不一致 |
| `SectionCard` | 带标题/操作槽的统一卡片容器（头部分隔线） | 面板外观与层级统一 |
| `EmptyState` | 空状态插图 + 引导文案 + 可选操作 | "暂无数据"从干瘪文字变为可引导 |

---

## 四、布局外壳改造

- **侧栏 SideBar**：激活项左侧强调条 + 主色渐变底；折叠态（64px）自动显示 Tooltip；底部新增**折叠/展开开关**（此前桌面端无法收起侧栏，是一处可用性缺口）。
- **顶栏 TopBar**：新增**菜单按钮**随时折叠/展开侧栏；搜索框改为圆角悬浮式、聚焦主色描边。
- **内容区 AppLayout**：最大宽度 1480px 居中（超宽屏不再拉伸到失真）；合规提示条由"虚线框"改为更精致的浅底内联条（带信息图标）。

---

## 五、各页面统一结果

| 页面 | 改动 |
|---|---|
| 组合仪表盘 | `PageHeader` 统一头部；资产配置/再平衡/持仓明细包进 `SectionCard`；StatCard 加图标徽标与悬停抬升 |
| 早盘选股 | `PageHeader` 头部；"策略模板"面板升级为 `SectionCard` |
| 尾盘选股器 | 同上 |
| 我的策略 | `PageHeader` 头部；空状态升级为 `EmptyState` |
| 我的自选 | `PageHeader` 头部；列表包进 `SectionCard`（无内边距贴边表格） |
| 模型设置 | `PageHeader` 头部 |

---

## 六、可访问性 & 响应式

- 键盘焦点：全局 `:focus-visible` 高对比 2px 主色描边。
- 触控目标：按钮/图标按钮最小 32–36px，满足 ≥44px 交互区。
- 减少动态：尊重系统 `prefers-reduced-motion`，关闭过渡/动画。
- 响应式：保留原有 Grid 断点（xs/sm/md/lg），侧栏可折叠适配窄屏。

---

## 七、改动文件清单

**新增**
- `client/src/components/common/PageHeader.tsx`
- `client/src/components/common/SectionCard.tsx`
- `client/src/components/common/EmptyState.tsx`

**重写/优化**
- `client/src/theme/index.ts`（设计 Token 系统 + 组件覆盖）
- `client/src/index.css`（焦点环/选区/滚动条/平滑滚动）
- `client/src/components/layout/SideBar.tsx`
- `client/src/components/layout/TopBar.tsx`
- `client/src/components/layout/AppLayout.tsx`
- `client/src/components/common/StatCard.tsx`

**页面接入统一原语**
- `pages/PortfolioDashboard.tsx`、`pages/MorningScreen.tsx`、`pages/ClosingScreen.tsx`
- `pages/StrategiesPage.tsx`、`pages/WatchlistPage.tsx`、`pages/SettingsPage.tsx`

---

## 八、预览方式

```bash
# 在项目根目录
npm run dev        # 前端 http://localhost:5173 / 后端 http://localhost:3001
```

> 说明：纯前端视觉/交互层已通过 `tsc` 类型检查与 `vite build` 生产构建（1678 模块，构建成功）。
> 如需查看真实数据，请同时启动后端（`npm run dev` 会并行拉起前后端）。
