// ============================================================
// AiPanel：AI 输出面板（Markdown 小节渲染/重新生成/免责声明/降级提示）
// ============================================================
import { useState } from 'react';
import { Box, Button, Typography, Paper, CircularProgress, Chip } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Link as RouterLink } from 'react-router-dom';
import { AI_DISCLAIMER } from '@shared/constants';
import { useAiConfigStore } from '../../store/aiConfigStore';
import { useAuthStore } from '../../store/authStore';

interface AiPanelProps {
  title: string;
  content: string | null;
  loading: boolean;
  cached?: boolean;
  generatedAt?: string;
  onRefresh: () => void;
  emptyText?: string;
  /** 是否处于流式生成中 */
  streaming?: boolean;
  /** 已经等待的秒数（用于倒计时展示） */
  elapsedSeconds?: number;
}

/** 将 Markdown 按 ## 小节切分渲染 */
function renderMarkdownSections(text: string) {
  const sections = text
    .split(/\n(?=##\s)/g)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sections.length <= 1) {
    return (
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', color: 'text.primary' }}>
        {text}
      </Typography>
    );
  }

  return sections.map((section, idx) => {
    const m = section.match(/^##\s+(.+)$/m);
    const title = m ? m[1] : '';
    const body = m ? section.slice(m[0].length).trim() : section;
    return (
      <Box key={idx} sx={{ mb: 1.5 }}>
        {title && (
          <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'primary.main', mb: 0.5 }}>
            {title}
          </Typography>
        )}
        {body.split('\n').filter((l) => l.trim()).map((line, li) => (
          <Typography key={li} variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', pl: title ? 1 : 0 }}>
            {line}
          </Typography>
        ))}
      </Box>
    );
  });
}

export default function AiPanel({ title, content, loading, cached, generatedAt, onRefresh, emptyText = '点击「生成」获取 AI 分析', streaming = false, elapsedSeconds = 0 }: AiPanelProps) {
  const [refreshing, setRefreshing] = useState(false);
  const { displayActive, displayLabel, hasKey } = useAiConfigStore();
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  // 登录用户且明确未配置 AI Key → 强制引导去「模型设置」
  const needsConfig = isLoggedIn() && hasKey === false;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            🤖 {title}
          </Typography>
          {displayActive && displayLabel && !needsConfig && (
            <Chip
              size="small"
              variant="outlined"
              color="primary"
              label={`模型：${displayLabel}`}
            />
          )}
          {cached && !needsConfig && (
            <Typography variant="caption" color="text.secondary" sx={{ bgcolor: 'action.hover', px: 0.75, py: 0.25, borderRadius: 1 }}>
              缓存
            </Typography>
          )}
          {generatedAt && !needsConfig && (
            <Typography variant="caption" color="text.secondary">
              生成于 {new Date(generatedAt).toLocaleTimeString('zh-CN')}
            </Typography>
          )}
        </Box>
        <Button size="small" startIcon={refreshing ? <CircularProgress size={14} /> : <RefreshIcon />} onClick={handleRefresh} disabled={loading || refreshing || needsConfig}>
          重新生成
        </Button>
      </Box>

      {needsConfig ? (
        <Box sx={{ py: 2, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            ⚠️ 你尚未配置 AI 模型，无法使用 AI 分析功能。请先填写你自己的 API Key。
          </Typography>
          <Button variant="contained" size="small" component={RouterLink} to="/settings">
            前往「模型设置」配置
          </Button>
        </Box>
      ) : loading || streaming ? (
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1 }}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              AI 正在分析中，已等待 {elapsedSeconds}s / 最长 180s…
            </Typography>
          </Box>
          {content && (
            <Box sx={{ maxHeight: 360, overflowY: 'auto', opacity: 0.85, pt: 1 }}>
              {renderMarkdownSections(content)}
            </Box>
          )}
        </Box>
      ) : content ? (
        <Box sx={{ maxHeight: 420, overflowY: 'auto' }}>{renderMarkdownSections(content)}</Box>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          {emptyText}
        </Typography>
      )}

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, borderTop: '1px dashed', borderColor: 'divider', pt: 1 }}>
        ⓘ {AI_DISCLAIMER}
      </Typography>
    </Paper>
  );
}
