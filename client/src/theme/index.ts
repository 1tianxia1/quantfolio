// ============================================================
// QuantFolio 全局设计系统（MUI 主题）
// 设计语言：深色优先的「金融终端」美学 —— 分层表面、克制留白、
// 统一圆角/阴影、等宽数字、红涨绿跌（颜色唯一来源 shared/constants）。
// 仅做视觉与交互层增强，不改变任何业务逻辑。
// ============================================================
import { createTheme, type ThemeOptions, type Shadows } from '@mui/material/styles';
import { COLORS } from '@shared/constants';

// 将涨跌/平色注入主题，方便组件以 theme.palette.up / down / flat 引用
declare module '@mui/material/styles' {
  interface Palette {
    up: string;
    down: string;
    flat: string;
  }
  interface PaletteOptions {
    up?: string;
    down?: string;
    flat?: string;
  }
}

/** 字体栈：优先系统字体，中文回退 PingFang SC / 微软雅黑 */
const FONT_FAMILY = [
  '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto',
  '"Helvetica Neue"', 'Arial', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif',
].join(',');

/** 统一排版层级（px） */
const TYPOGRAPHY = {
  fontFamily: FONT_FAMILY,
  htmlFontSize: 16,
  h1: { fontSize: 30, fontWeight: 700, lineHeight: 1.3 },
  h2: { fontSize: 26, fontWeight: 700, lineHeight: 1.35 },
  h3: { fontSize: 22, fontWeight: 700, lineHeight: 1.4 },
  h4: { fontSize: 20, fontWeight: 700, lineHeight: 1.4 },
  h5: { fontSize: 18, fontWeight: 700, lineHeight: 1.4 },
  h6: { fontSize: 16, fontWeight: 700, lineHeight: 1.45, fontVariantNumeric: 'tabular-nums' },
  subtitle1: { fontSize: 15, fontWeight: 600, lineHeight: 1.5 },
  subtitle2: { fontSize: 14, fontWeight: 600, lineHeight: 1.5 },
  body1: { fontSize: 14, fontWeight: 400, lineHeight: 1.6 },
  body2: { fontSize: 13, fontWeight: 400, lineHeight: 1.6, fontVariantNumeric: 'tabular-nums' },
  caption: { fontSize: 12, fontWeight: 400, lineHeight: 1.5 },
  overline: { fontSize: 11, fontWeight: 600, lineHeight: 1.4, letterSpacing: '0.06em', textTransform: 'uppercase' as const },
  button: { fontSize: 13, fontWeight: 600, textTransform: 'none' as const },
};

/** 派生一套与主题匹配的阴影体系（暗色更柔、亮色更挺） */
function buildShadows(mode: 'dark' | 'light'): Shadows {
  const base = createTheme().shadows;
  const tint = mode === 'dark' ? '0,0,0' : '15,23,42';
  const set = (i: number, v: string) => { base[i] = v; };
  set(1, `0 1px 2px rgba(${tint},0.30)`);
  set(2, `0 2px 6px rgba(${tint},0.32)`);
  set(3, `0 4px 12px rgba(${tint},0.34)`);
  set(4, `0 8px 20px rgba(${tint},0.36)`);
  set(5, `0 12px 28px rgba(${tint},0.38)`);
  set(6, `0 18px 40px rgba(${tint},0.42)`);
  return base;
}

/** 组件级样式覆盖（深浅主题通用，颜色走 token） */
const COMPONENT_OVERRIDES: ThemeOptions['components'] = {
  MuiCssBaseline: {
    styleOverrides: {
      '*, *::before, *::after': { boxSizing: 'border-box' },
      body: {
        fontVariantNumeric: 'tabular-nums',
        WebkitFontSmoothing: 'antialiased',
        MozOsxFontSmoothing: 'grayscale',
        // 主题感知滚动条
        scrollbarColor: 'rgba(128,128,128,0.45) transparent',
        scrollbarWidth: 'thin',
      },
      // 键盘可见焦点环（高对比，满足 WCAG）
      '*:focus-visible': {
        outline: '2px solid #2E7CF6',
        outlineOffset: '2px',
        borderRadius: 4,
      },
      '::selection': { background: 'rgba(46,124,246,0.30)' },
      // 尊重「减少动态效果」系统偏好
      '@media (prefers-reduced-motion: reduce)': {
        '*, *::before, *::after': {
          animationDuration: '0.001ms !important',
          animationIterationCount: '1 !important',
          transitionDuration: '0.001ms !important',
        },
      },
      // WebKit 滚动条
      '::-webkit-scrollbar': { width: 8, height: 8 },
      '::-webkit-scrollbar-thumb': { background: 'rgba(128,128,128,0.40)', borderRadius: 8 },
      '::-webkit-scrollbar-thumb:hover': { background: 'rgba(128,128,128,0.60)' },
      '::-webkit-scrollbar-track': { background: 'transparent' },
    },
  },
  MuiButton: {
    defaultProps: { disableElevation: true },
    styleOverrides: {
      root: {
        textTransform: 'none',
        fontWeight: 600,
        borderRadius: 8,
        minHeight: 36,
        paddingInline: 14,
        transition: 'background-color .18s ease, box-shadow .18s ease, transform .08s ease, color .18s ease',
        '&:active': { transform: 'translateY(1px)' },
      },
      sizeSmall: { minHeight: 32, paddingInline: 12, fontSize: 13 },
      containedPrimary: {
        '&:hover': { boxShadow: '0 4px 12px rgba(46,124,246,0.35)' },
      },
    },
  },
  MuiPaper: {
    styleOverrides: {
      root: { backgroundImage: 'none' },
      outlined: { borderColor: 'divider' },
    },
  },
  MuiCard: {
    defaultProps: { elevation: 0 },
    styleOverrides: { root: { borderRadius: 14, border: '1px solid', borderColor: 'divider' } },
  },
  MuiChip: {
    styleOverrides: { root: { borderRadius: 999, fontWeight: 600 } },
  },
  MuiToggleButton: {
    styleOverrides: {
      root: {
        borderRadius: 8,
        textTransform: 'none',
        fontWeight: 600,
        border: '1px solid',
        borderColor: 'divider',
        '&.Mui-selected': {
          color: 'primary.main',
          backgroundColor: 'rgba(46,124,246,0.12)',
          borderColor: 'rgba(46,124,246,0.35)',
        },
        '&.Mui-selected:hover': { backgroundColor: 'rgba(46,124,246,0.18)' },
      },
    },
  },
  MuiToggleButtonGroup: {
    styleOverrides: { grouped: { margin: 0, '&:not(:first-of-type)': { borderRadius: 8, borderLeft: '1px solid', borderColor: 'divider' } } },
  },
  MuiTableCell: {
    styleOverrides: {
      root: { fontVariantNumeric: 'tabular-nums', borderColor: 'divider' },
      head: { backgroundColor: 'action.hover', color: 'text.secondary', fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' },
    },
  },
  MuiTableRow: {
    styleOverrides: { root: { '&:last-child td, &:last-child th': { borderBottom: 0 } } },
  },
  MuiOutlinedInput: {
    styleOverrides: { root: { borderRadius: 8 } },
  },
  MuiTooltip: {
    styleOverrides: {
      tooltip: { borderRadius: 8, fontSize: 12, padding: '4px 8px', backgroundColor: 'rgba(20,24,31,0.95)' },
      arrow: { color: 'rgba(20,24,31,0.95)' },
    },
  },
  MuiAlert: {
    styleOverrides: { root: { borderRadius: 10, alignItems: 'center' }, message: { fontWeight: 500 } },
  },
  MuiSnackbarContent: {
    styleOverrides: { root: { borderRadius: 10, fontWeight: 500 } },
  },
  MuiLink: { styleOverrides: { root: { textDecorationColor: 'rgba(46,124,246,0.4)' } } },
  MuiListItemButton: {
    styleOverrides: { root: { borderRadius: 10 } },
  },
  MuiTableSortLabel: {
    styleOverrides: { root: { '&:hover': { color: 'text.primary' } } },
  },
};

/** 构建主题（深色 / 浅色共用一套 token 结构） */
function buildTheme(mode: 'dark' | 'light'): ThemeOptions {
  const isDark = mode === 'dark';
  return {
    palette: {
      mode,
      primary: { main: COLORS.PRIMARY, contrastText: '#FFFFFF' },
      up: COLORS.UP,
      down: COLORS.DOWN,
      flat: COLORS.FLAT,
      error: { main: COLORS.UP },           // 错误/警示沿用「红」
      success: { main: COLORS.DOWN },         // 成功沿用「绿」
      warning: { main: '#F5A623' },
      info: { main: COLORS.PRIMARY },
      background: isDark
        ? { default: COLORS.BG_DARK, paper: COLORS.CARD_DARK }
        : { default: '#F4F6FA', paper: '#FFFFFF' },
      text: isDark
        ? { primary: '#E6EDF3', secondary: '#8B949E' }
        : { primary: '#1F2328', secondary: '#57606A' },
      divider: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.10)',
      action: isDark
        ? { hover: 'rgba(255,255,255,0.06)', selected: 'rgba(46,124,246,0.16)' }
        : { hover: 'rgba(15,23,42,0.05)', selected: 'rgba(46,124,246,0.12)' },
    },
    typography: TYPOGRAPHY,
    shape: { borderRadius: 12 },
    shadows: buildShadows(mode),
    components: COMPONENT_OVERRIDES,
  };
}

/** 深色主题（默认，长时间看盘不刺眼） */
export const darkTheme = createTheme(buildTheme('dark'));

/** 浅色主题 */
export const lightTheme = createTheme(buildTheme('light'));
