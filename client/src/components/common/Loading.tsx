// ============================================================
// Loading：Skeleton 加载态
// ============================================================
import { Box, Skeleton } from '@mui/material';

export default function Loading({ rows = 6 }: { rows?: number }) {
  return (
    <Box data-testid="loading-skeleton">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} variant="rounded" height={44} sx={{ mb: 1 }} />
      ))}
    </Box>
  );
}
