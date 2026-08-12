// ============================================================
// SourceList：情报来源链（模块 A）
// 每条带标题 + 链接 + 发布时间 + 检索时间；stale（超期）高亮警示
// ============================================================
import { Box, Link, Typography, Stack, Chip } from '@mui/material';
import type { SourceItem } from '../../api/analysis';
import { COLORS } from '@shared/constants';

export default function SourceList({ sources }: { sources: SourceItem[] }) {
  if (!sources.length) {
    return (
      <Typography variant="body2" color="text.secondary">
        本次检索未获得可用来源。
      </Typography>
    );
  }
  return (
    <Stack spacing={0.75}>
      {sources.map((s, i) => (
        <Box key={i} sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
          <Link href={s.url} target="_blank" rel="noreferrer" variant="body2" underline="hover" sx={{ fontWeight: 500 }}>
            {s.title}
          </Link>
          {s.stale && (
            <Chip size="small" label="超期" sx={{ height: 18, fontSize: 11, bgcolor: COLORS.DOWN, color: '#fff' }} />
          )}
          <Typography variant="caption" color="text.secondary" component="span">
            {s.published_at ? `发布于 ${s.published_at.slice(0, 10)}` : '发布时间未知'}
            {s.retrieved_at ? ` · 检索于 ${s.retrieved_at.slice(0, 16).replace('T', ' ')}` : ''}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}
