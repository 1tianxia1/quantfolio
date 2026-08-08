// ============================================================
// SnackbarProvider：全局提示
// ============================================================
import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';

type Severity = 'success' | 'info' | 'warning' | 'error';

interface SnackbarCtx {
  show: (message: string, severity?: Severity) => void;
}

const Ctx = createContext<SnackbarCtx>({ show: () => undefined });

export function useSnackbar() {
  return useContext(Ctx);
}

export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<Severity>('info');

  const show = useCallback((msg: string, sev: Severity = 'info') => {
    setMessage(msg);
    setSeverity(sev);
    setOpen(true);
  }, []);

  return (
    <Ctx.Provider value={{ show }}>
      {children}
      <Snackbar
        open={open}
        autoHideDuration={3000}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert onClose={() => setOpen(false)} severity={severity} variant="filled" sx={{ width: '100%' }}>
          {message}
        </Alert>
      </Snackbar>
    </Ctx.Provider>
  );
}
