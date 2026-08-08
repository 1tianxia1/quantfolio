// ============================================================
// 入口：React 挂载 + ThemeProvider + Router + Snackbar
// ============================================================
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import App from './App';
import { SnackbarProvider } from './components/common/SnackbarProvider';
import { useUiStore } from './store/uiStore';
import { darkTheme, lightTheme } from './theme';
import './index.css';

/** 根据 uiStore 主题模式选择 MUI 主题 */
function ThemedApp() {
  const mode = useUiStore((s) => s.mode);
  return (
    <ThemeProvider theme={mode === 'dark' ? darkTheme : lightTheme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <SnackbarProvider>
        <ThemedApp />
      </SnackbarProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
