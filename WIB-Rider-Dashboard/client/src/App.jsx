import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Routes, Route, useNavigate, useLocation, Navigate } from 'react-router-dom';
import { isAuthenticated } from './auth';
import {
  hydrateMapMerchantFilterFromServer,
  setupMapMerchantFilterServerListeners,
} from './utils/mapMerchantFilterPrefs';
import { TeamFilterProvider } from './context/TeamFilterContext';
import Sidebar from './components/Sidebar';
import MainHeader from './components/MainHeader';
import NewTaskModal from './components/NewTaskModal';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Tasks from './pages/Tasks';
import Drivers from './pages/Drivers';
import NewTask from './pages/NewTask';
import Settings from './pages/Settings';
import Teams from './pages/Teams';
import PushLogs from './pages/PushLogs';
import BroadcastLogs from './pages/BroadcastLogs';
import DriverTrackback from './pages/DriverTrackback';
import Assignment from './pages/Assignment';
import Notifications from './pages/Notifications';
import Reports from './pages/Reports';
import SmsLogs from './pages/SmsLogs';
import EmailLogs from './pages/EmailLogs';
import MapApiLogs from './pages/MapApiLogs';
import Merchants from './pages/Merchants';

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

export default function App() {
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
                <NewTaskModal onClose={closeNewTaskModal} onSuccess={onNewTaskSuccess} />
              </div>,
              document.body
            )}
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
          </main>
        </TeamFilterProvider>
      </div>
    </div>
  );
}
