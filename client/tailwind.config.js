/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  corePlugins: {
    // 关闭 preflight，避免与 MUI CssBaseline 重置冲突（硬约束）
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        up: '#F5222D',
        down: '#00B578',
        flat: '#8B949E',
        primary: '#2E7CF6',
      },
    },
  },
  plugins: [],
};
