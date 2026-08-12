// ============================================================
// 底部合规免责声明（O7：数据来源动态化，meta_kv 驱动，前端不硬编码）
// 读取 GET /api/market/meta（trade_date + seed_version + lineage），
// 失败时回落静态文案，不影响布局。
// ============================================================
import { useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { SCREENER_DISCLAIMER } from '@shared/constants';
import http, { unwrap } from '../../api/http';

const STATIC_SOURCE = '数据来源：2026-08-07 通达信真实快照 + 确定性派生';

interface MarketMeta {
  trade_date: string | null;
  version: string | null;
  lineage?: Record<string, unknown>;
}

export default function DisclaimerBar() {
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    unwrap<MarketMeta>(http.get('/market/meta'))
      .then((m) => {
        if (!alive) return;
        if (m?.trade_date) {
          setSource(`数据来源：${m.trade_date} ${m.version || ''}快照 + 派生`.trim());
        }
      })
      .catch(() => {
        /* 保持静态文案 */
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Box
      component="footer"
      sx={{
        py: 1.5,
        px: 2,
        borderTop: '1px solid',
        borderColor: 'divider',
        textAlign: 'center',
        bgcolor: 'background.paper',
      }}
    >
      <Typography variant="caption" color="text.secondary">
        {SCREENER_DISCLAIMER} · {source || STATIC_SOURCE}
      </Typography>
    </Box>
  );
}
