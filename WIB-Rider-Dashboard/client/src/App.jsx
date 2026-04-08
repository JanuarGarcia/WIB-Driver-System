import { useState, useEffect, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { isAuthenticated } from './auth';
import { useTheme } from './context/ThemeContext';
import {
  hydrateMapMerchantFilterFromServer,
  setupMapMerchantFilterServerListeners,
} from './utils/mapMerchantFilterPrefs';
import { TeamFilterProvider } from './context/TeamFilterContext';
import Sidebar from './components/Sidebar';
import MainHeader from './components/MainHeader';
import Login from './pages/Login';

const NewTaskModal = lazy(() => import('./components/NewTaskModal'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Tasks = lazy(() => import('./pages/Tasks'));
const Drivers = lazy(() => import('./pages/Drivers'));
const NewTask = lazy(() => import('./pages/NewTask'));
const Settings = lazy(() => import('./pages/Settings'));
const Teams = lazy(() => import('./pages/Teams'));
const PushLogs = lazy(() => import('./pages/PushLogs'));
const BroadcastLogs = lazy(() => import('./pages/BroadcastLogs'));
const DriverTrackback = lazy(() => import('./pages/DriverTrackback'));
const Assignment = lazy(() => import('./pages/Assignment'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Reports = lazy(() => import('./pages/Reports'));
const SmsLogs = lazy(() => import('./pages/SmsLogs'));
const EmailLogs = lazy(() => import('./pages/EmailLogs'));
const MapApiLogs = lazy(() => import('./pages/MapApiLogs'));
const Merchants = lazy(() => import('./pages/Merchants'));

function AppRouteFallback() {
  return (
    <div
      className="app-route-fallback"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '40vh',
        color: 'var(--text-muted, #888)',
        fontSize: '0.95rem',
      }}
      aria-busy="true"
      aria-live="polite"
    >
      Loading…
    </div>
  );
}

function MapMerchantFilterServerSync() {
  useEffect(() => {
    hydrateMapMerchantFilterFromServer();
    const retry = setTimeout(() => hydrateMapMerchantFilterFromServer(), 2000);
    const removeListeners = setupMapMerchantFilterServerListeners();
    return () => {
      clearTimeout(retry);
      removeListeners();
    };
  }, []);
  return null;
}

/** Notification panel → open task modal on Dashboard (navigate home if on another route). */
function OpenTaskFromNotificationBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    const onOpen = (e) => {
      const raw = e?.detail?.taskId;
      if (raw == null || !Number.isFinite(Number(raw)) || Number(raw) === 0) return;
      navigate('/', { state: { wibOpenTaskId: Number(raw) } });
    };
    window.addEventListener('wib-dashboard-open-task', onOpen);
    return () => window.removeEventListener('wib-dashboard-open-task', onOpen);
  }, [navigate]);
  return null;
}

/** After api.js clears the token on 401/HTML auth walls, return the user to login. */
function SessionExpiredRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    const onExpired = () => navigate('/login', { replace: true });
    window.addEventListener('wib-dashboard-session-expired', onExpired);
    return () => window.removeEventListener('wib-dashboard-session-expired', onExpired);
  }, [navigate]);
  return null;
}

export default function App() {
  const { theme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showNewTaskModal, setShowNewTaskModal] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const closeNewTaskModal = () => setShowNewTaskModal(false);
  const onNewTaskSuccess = () => {
    setShowNewTaskModal(false);
    navigate('/tasks');
  };

  if (location.pathname === '/login') {
    return <Login />;
  }
  if (!isAuthenticated()) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return (
    <div className="app-layout">
      <ToastContainer
        position="bottom-right"
        theme={theme === 'dark' ? 'dark' : 'light'}
        autoClose={12500}
        newestOnTop
        pauseOnFocusLoss={false}
        closeOnClick
        rtl={false}
        limit={24}
        toastClassName="rider-notif-toast"
        bodyClassName="rider-notif-toast-body"
        progressClassName="rider-notif-toast-progress"
      />
      {sidebarOpen && (
        <div
          className="sidebar-backdrop"
          role="button"
          tabIndex={0}
          onClick={() => setSidebarOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setSidebarOpen(false)}
          aria-label="Close menu"
        />
      )}
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="main-wrap">
        <TeamFilterProvider>
          <SessionExpiredRedirect />
          <OpenTaskFromNotificationBridge />
          <MapMerchantFilterServerSync />
          <MainHeader onMenuClick={() => setSidebarOpen(true)} onOpenNewTask={() => setShowNewTaskModal(true)} />
          <main className="main">
          {showNewTaskModal &&
            createPortal(
              <div
                className="new-task-backdrop"
                role="dialog"
                aria-modal="true"
                aria-labelledby="new-task-modal-title"
                onClick={(e) => e.target === e.currentTarget && closeNewTaskModal()}
                onKeyDown={(e) => e.key === 'Escape' && closeNewTaskModal()}
              >
                <Suspense
                  fallback={
                    <div
                      style={{
                        background: 'var(--panel-bg, #fff)',
                        borderRadius: 8,
                        padding: '2rem 2.5rem',
                        maxWidth: 360,
                        margin: 'auto',
                        textAlign: 'center',
                        color: 'var(--text-muted, #888)',
                      }}
                    >
                      Loading…
                    </div>
                  }
                >
                  <NewTaskModal onClose={closeNewTaskModal} onSuccess={onNewTaskSuccess} />
                </Suspense>
              </div>,
              document.body
            )}
          <Suspense fallback={<AppRouteFallback />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/tasks" element={<Tasks />} />
              <Route path="/drivers" element={<Drivers />} />
              <Route path="/new-task" element={<NewTask />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/teams" element={<Teams />} />
              <Route path="/push-logs" element={<PushLogs />} />
              <Route path="/broadcast-logs" element={<BroadcastLogs />} />
              <Route path="/driver-trackback" element={<DriverTrackback />} />
              <Route path="/assignment" element={<Assignment />} />
              <Route path="/notifications" element={<Notifications />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/sms-logs" element={<SmsLogs />} />
              <Route path="/email-logs" element={<EmailLogs />} />
              <Route path="/map-api-logs" element={<MapApiLogs />} />
              <Route path="/merchants" element={<Merchants />} />
            </Routes>
          </Suspense>
          </main>
        </TeamFilterProvider>
      </div>
    </div>
  );
}
