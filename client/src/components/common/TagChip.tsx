// ============================================================
// TagChip：命中指标 Chip
// ============================================================
import Chip from '@mui/material/Chip';

interface TagChipProps {
  label: string;
  color?: 'default' | 'primary' | 'success' | 'warning' | 'error';
  size?: 'small' | 'medium';
}

export default function TagChip({ label, color = 'primary', size = 'small' }: TagChipProps) {
  return (
    <Chip
      label={label}
      color={color}
      size={size}
      variant="outlined"
      sx={{ mr: 0.5, mb: 0.5, height: size === 'small' ? 20 : 24, fontSize: size === 'small' ? 11 : 12 }}
    />
  );
}
