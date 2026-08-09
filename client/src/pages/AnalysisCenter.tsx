// ============================================================
// 智能分析中心（架构 §3.2 / §9 T02 页面骨架）
// 本期只搭壳：统一 code 输入区 + 模块 A/B Tab + 结果区占位 + 流水线入口。
// 真实图表 / 结论卡片 / 流水线逻辑由 T03 / T04 / T05 填充。
// 深色「金融终端」风格，复用 PageHeader / SectionCard / EmptyState。
// ============================================================
import { useState } from 'react';
import {
  Box,
  TextField,
  Button,
  Tabs,
  Tab,
  Chip,
  Stepper,
  Step,
  StepLabel,
  Typography,
  Stack,
} from '@mui/material';
import InsightsIcon from '@mui/icons-material/Insights';
import SearchIcon from '@mui/icons-material/Search';
import PsychologyAltIcon from '@mui/icons-material/PsychologyAlt';
import CandlestickChartIcon from '@mui/icons-material/CandlestickChart';
import PageHeader from '../components/common/PageHeader';
import SectionCard from '../components/common/SectionCard';
import EmptyState from '../components/common/EmptyState';

const PIPELINE_STEPS = ['① 选股', '② 择时', '③ 回测'];

export default function AnalysisCenter() {
  const [code, setCode] = useState('');
  const [moduleTab, setModuleTab] = useState<'quant' | 'signal'>('quant');

  const handleAnalyze = () => {
    // T03 / T04 接入真实接口后在此发起分析；本期骨架仅提示
    // eslint-disable-next-line no-console
    console.log('[AnalysisCenter] 分析请求（待 T03/T04 接入）:', code, moduleTab);
  };

  return (
    <Box>
      <PageHeader
        icon={<InsightsIcon fontSize="small" />}
        title="智能分析中心"
        subtitle="统一代码入口（A 股 / 场内基金），量化分析（AI 基本面）与策略指标（技术面）双模块并行"
        actions={
          <Stack direction="row" spacing={1}>
            <Chip size="small" label="模块 A：AI 基本面 + 消息面" variant="outlined" color="primary" />
            <Chip size="small" label="模块 B：技术面买卖信号" variant="outlined" color="secondary" />
          </Stack>
        }
      />

      {/* 统一 code 输入区 */}
      <SectionCard title="代码输入" subtitle="股票 / 基金统一为 6 位代码，回车即分析">
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <TextField
            size="small"
            fullWidth
            placeholder="输入代码，如 000878 云南铜业 / 510300 沪深300ETF"
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

      {/* 模块入口 Tab */}
      <Box sx={{ mt: 2.5 }}>
        <Tabs
          value={moduleTab}
          onChange={(_e, v: 'quant' | 'signal') => setModuleTab(v)}
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

      {/* 结果展示区（T03/T04 填充真实图表与结论卡片） */}
      <Box sx={{ mt: 2 }}>
        <SectionCard
          title={moduleTab === 'quant' ? '量化分析结论' : '策略指标信号'}
          subtitle="结果将展示于此"
        >
          <EmptyState
            icon={<InsightsIcon fontSize="large" />}
            title={moduleTab === 'quant' ? '输入代码开始 AI 分析' : '输入代码查看技术面信号'}
            description={
              moduleTab === 'quant'
                ? 'AI 将联网收集财报、资金流、产业链与消息面，给出可解释结论（含来源与检索时间）。'
                : '系统将基于 MACD、背离、大资金流入、30 日趋势与量能给出买卖信号。'
            }
          />
        </SectionCard>
      </Box>

      {/* 流水线入口（选股 → 择时 → 回测；T05 填充真实步骤联动） */}
      <Box sx={{ mt: 2.5 }}>
        <SectionCard title="投研流水线" subtitle="前序结论作为后序输入，形成承前启后的选股 → 择时 → 回测链路">
          <Stepper activeStep={-1} alternativeLabel>
            {PIPELINE_STEPS.map((label) => (
              <Step key={label}>
                <StepLabel>{label}</StepLabel>
              </Step>
            ))}
          </Stepper>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5, textAlign: 'center' }}>
            流水线步骤将在后续版本启用（选股含 AI 自主选板块龙头 / 潜力股）。
          </Typography>
        </SectionCard>
      </Box>
    </Box>
  );
}
