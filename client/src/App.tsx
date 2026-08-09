// ============================================================
// 路由表 + 布局包裹 + 路由守卫
// ============================================================
import { Routes, Route } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import LoginPage from './pages/LoginPage';
import PortfolioDashboard from './pages/PortfolioDashboard';
import MorningScreen from './pages/MorningScreen';
import ClosingScreen from './pages/ClosingScreen';
import StrategiesPage from './pages/StrategiesPage';
import WatchlistPage from './pages/WatchlistPage';
import SettingsPage from './pages/SettingsPage';
import AnalysisCenter from './pages/AnalysisCenter';
import NotFound from './pages/NotFound';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppLayout />}>
        <Route path="/" element={<PortfolioDashboard />} />
        <Route path="/portfolio" element={<PortfolioDashboard />} />
        <Route path="/morning" element={<MorningScreen />} />
        <Route path="/closing" element={<ClosingScreen />} />
        <Route path="/strategies" element={<StrategiesPage />} />
        <Route path="/watchlist" element={<WatchlistPage />} />
        <Route path="/analysis" element={<AnalysisCenter />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
