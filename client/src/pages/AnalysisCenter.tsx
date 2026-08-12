// ============================================================
// 智能分析中心（架构 §3.2 / §9 T02 骨架 → T03/T04/T05 已填充）
// 统一 code 输入区 + 模块 A/B Tab + 结果区 + 投研流水线（选股→择时→回测）
// 深色「金融终端」风格，复用 PageHeader / SectionCard / EmptyState。
//
// 【请求触发约定 · 勿改】
// 页面是分析请求的唯一「触发源」：两个面板都由各自的运行令牌（RunToken）驱动，
// 令牌只在用户显式点击（「分析」按钮 / 回车 / 面板内的手动生成按钮）时才会新建。
// 切换 Tab 只改变 CSS display，不改变令牌、不卸载面板，因此绝不会产生任何 API 调用。
// ============================================================
import { useRef, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box,
  TextField,
  Button,
  Tabs,
  Tab,
  Chip,
  Stack,
} from '@mui/material';
import InsightsIcon from '@mui/icons-material/Insights';
import SearchIcon from '@mui/icons-material/Search';
import PsychologyAltIcon from '@mui/icons-material/PsychologyAlt';
import CandlestickChartIcon from '@mui/icons-material/CandlestickChart';
import PageHeader from '../components/common/PageHeader';
import SectionCard from '../components/common/SectionCard';
import EmptyState from '../components/common/EmptyState';
import TechnicalPanel from '../components/analysis/TechnicalPanel';
import QuantPanel from '../components/analysis/QuantPanel';
import PipelinePanel from '../components/analysis/PipelinePanel';

/** 模块标识：quant = A 量化分析（AI 基本面）；signal = B 策略指标（技术面） */
type ModuleKey = 'quant' | 'signal';

/**
 * 一次分析运行的令牌。
 * `seq` 全局自增，面板以它作为 useEffect 依赖：seq 不变 → 永不重新请求。
 */
interface RunToken {
  code: string;
  seq: number;
}

export default function AnalysisCenter() {
  const [code, setCode] = useState('');
  const [submittedCode, setSubmittedCode] = useState<string | null>(null);
  const [moduleTab, setModuleTab] = useState<ModuleKey>('quant');

  // 两个模块各自独立的运行令牌：为 null 表示「尚未运行过」，展示空状态而非发请求
  const [quantRun, setQuantRun] = useState<RunToken | null>(null);
  const [signalRun, setSignalRun] = useState<RunToken | null>(null);

  // 自增序号放在 ref 里：只在事件回调中自增，不参与渲染，避免多余的 state
  const seqRef = useRef(0);

  // 支持从自选页 / 外部链接带 ?code=XXX 跳入时，自动填充并触发当前模块分析（等价于用户点一次「分析」）
  const [searchParams] = useSearchParams();
  useEffect(() => {
    const q = (searchParams.get('code') || '').trim();
    if (!q) return;
    setCode(q);
    if (q !== submittedCode) {
      if (moduleTab === 'quant') setSignalRun(null); else setQuantRun(null);
    }
    setSubmittedCode(q);
    seqRef.current += 1;
    const token = { code: q, seq: seqRef.current };
    if (moduleTab === 'quant') setQuantRun(token); else setSignalRun(token);
    // 仅在挂载时根据 query 触发一次，不参与后续渲染
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 为指定模块发起一次分析。这是本页唯一的请求入口，必须由用户点击触发。
   * @param module 目标模块
   * @param targetCode 已校验的 6 位代码
   */
  const runModule = (module: ModuleKey, targetCode: string): void => {
    seqRef.current += 1;
    const token: RunToken = { code: targetCode, seq: seqRef.current };
    if (module === 'quant') {
      setQuantRun(token);
    } else {
      setSignalRun(token);
    }
  };

  /**
   * 点击「分析」/输入框回车：只运行「当前 Tab」对应的模块。
   * 另一个模块保持原样（或在换标的时清空），由用户按需手动触发，
   * 避免用户只想看技术面时却在后台悄悄启动 3 分钟的 AI 生成。
   */
  const handleAnalyze = (): void => {
    const c = code.trim();
    if (!c) return;

    // 换了标的 → 另一模块的旧结果作废，防止两个 Tab 展示不同标的的数据
    if (c !== submittedCode) {
      if (moduleTab === 'quant') {
        setSignalRun(null);
      } else {
        setQuantRun(null);
      }
    }
    setSubmittedCode(c);
    runModule(moduleTab, c);
  };

  return (
    <Box>
      <PageHeader
        icon={<InsightsIcon fontSize="small" />}
        title="智能分析中心"
        subtitle="统一代码入口（A 股 / 场内基金 / 场外基金自动取净值），量化分析（AI 基本面）与策略指标（技术面）双模块并行"
        actions={
          <Stack direction="row" spacing={1}>
            <Chip size="small" label="模块 A：AI 基本面 + 消息面" variant="outlined" color="primary" />
            <Chip size="small" label="模块 B：技术面买卖信号" variant="outlined" color="secondary" />
          </Stack>
        }
      />

      {/* 统一 code 输入区 */}
      <SectionCard title="代码输入" subtitle="股票 / 基金统一为 6 位代码，回车即分析当前所选模块">
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <TextField
            size="small"
            fullWidth
            placeholder="输入代码，如 000878 云南铜业 / 510300 沪深300ETF / 008929 宏利消费红利指数C"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAnalyze();
            }}
            sx={{ maxWidth: { sm: 420 } }}
          />
          <Button
            variant="contained"
            startIcon={<SearchIcon />}
            onClick={handleAnalyze}
            sx={{ flexShrink: 0 }}
          >
            分析
          </Button>
        </Stack>
      </SectionCard>

      {/* 模块入口 Tab：仅切换显示，不触发任何请求 */}
      <Box sx={{ mt: 2.5 }}>
        <Tabs
          value={moduleTab}
          onChange={(_e, v: ModuleKey) => setModuleTab(v)}
          variant="scrollable"
          scrollButtons="auto"
        >
          <Tab
            value="quant"
            label="A 量化分析 · AI 基本面"
            icon={<PsychologyAltIcon fontSize="small" />}
            iconPosition="start"
          />
          <Tab
            value="signal"
            label="B 策略指标 · 技术面"
            icon={<CandlestickChartIcon fontSize="small" />}
            iconPosition="start"
          />
        </Tabs>
      </Box>

      {/* 结果展示区：两个面板同时挂载，用 display 切换以保留各自结果与进度 */}
      <Box sx={{ mt: 2 }}>
        <SectionCard
          title={moduleTab === 'quant' ? '量化分析结论' : '策略指标信号'}
          subtitle={submittedCode ? `基于 ${submittedCode} 的分析结果` : '结果将展示于此'}
        >
          <Box sx={{ display: moduleTab === 'quant' ? 'block' : 'none' }}>
            {quantRun ? (
              <QuantPanel code={quantRun.code} runId={quantRun.seq} />
            ) : (
              <EmptyState
                icon={<InsightsIcon fontSize="large" />}
                title={submittedCode ? `${submittedCode} 尚未生成 AI 基本面分析` : '输入代码开始 AI 分析'}
                description="AI 将联网收集财报、资金流、产业链与消息面，给出可解释结论（含来源与检索时间）。单次生成最长约 3 分钟，仅在你主动点击后才会调用。"
                action={
                  submittedCode ? (
                    <Button
                      variant="contained"
                      startIcon={<PsychologyAltIcon />}
                      onClick={() => runModule('quant', submittedCode)}
                    >
                      生成 AI 基本面分析
                    </Button>
                  ) : undefined
                }
              />
            )}
          </Box>
          <Box sx={{ display: moduleTab === 'signal' ? 'block' : 'none' }}>
            {signalRun ? (
              <TechnicalPanel code={signalRun.code} runId={signalRun.seq} />
            ) : (
              <EmptyState
                icon={<InsightsIcon fontSize="large" />}
                title={submittedCode ? `${submittedCode} 尚未生成技术面信号` : '输入代码查看技术面信号'}
                description="系统将基于 MACD、背离、大资金流入、30 日趋势与量能给出买卖信号。仅在你主动点击后才会调用。"
                action={
                  submittedCode ? (
                    <Button
                      variant="contained"
                      color="secondary"
                      startIcon={<CandlestickChartIcon />}
                      onClick={() => runModule('signal', submittedCode)}
                    >
                      生成技术面信号
                    </Button>
                  ) : undefined
                }
              />
            )}
          </Box>
        </SectionCard>
      </Box>

      {/* 投研流水线（T05：选股 → 择时 → 回测，步骤间数据传递） */}
      <Box sx={{ mt: 2.5 }}>
        <SectionCard title="投研流水线" subtitle="前序结论作为后序输入，形成承前启后的选股 → 择时 → 回测链路">
          <PipelinePanel />
        </SectionCard>
      </Box>
    </Box>
  );
}
