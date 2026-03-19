import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, statusClass, statusLabel } from '../api';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/** Read-only driver details + today's tasks (same UX as Agent panel "Details"). */
export default function DriverDetailsModal({
  driverId,
  summaryDriver = null,
  onClose,
  onOpenTaskDetails,
  footer = null,
  size = 'default',
}) {
  const navigate = useNavigate();
  const [state, setState] = useState({
    loading: true,
    driver: null,
    tasks: [],
    error: null,
  });

  useEffect(() => {
    if (driverId == null || driverId === '') {
      setState({ loading: false, driver: null, tasks: [], error: null });
      return;
    }
    setState({ loading: true, driver: null, tasks: [], error: null });
    const dateStr = todayStr();
    api(`drivers/${encodeURIComponent(driverId)}/details?date=${encodeURIComponent(dateStr)}`)
      .then((res) => {
        setState({
          loading: false,
          driver: res?.driver ?? null,
          tasks: Array.isArray(res?.tasks) ? res.tasks : [],
          error: null,
        });
      })
      .catch((err) => {
        setState({
          loading: false,
          driver: null,
          tasks: [],
          error: err?.error || err?.message || 'Failed to load driver details',
        });
      });
  }, [driverId]);

  const handleTaskClick = useCallback(
    (taskId) => {
      if (taskId == null) return;
      if (typeof onOpenTaskDetails === 'function') {
        onOpenTaskDetails(taskId);
      } else {
        navigate(`/tasks?highlight=${encodeURIComponent(taskId)}`);
      }
    },
    [navigate, onOpenTaskDetails]
  );

  useEffect(() => {
    function handleEscape(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  if (driverId == null || driverId === '') return null;

  return (
    <div
      className="agent-detail-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="driver-details-modal-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`agent-detail-modal-card ${size === 'wide' ? 'agent-detail-modal-card--wide' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="agent-detail-modal-header">
          <div className="agent-detail-modal-header-text">
            <h2 id="driver-details-modal-title" className="agent-detail-modal-title">
              Driver Details
            </h2>
            <p className="agent-detail-modal-subtitle">
              {summaryDriver?.full_name ||
                summaryDriver?.username ||
                state.driver?.full_name ||
                `Driver #${driverId}`}
            </p>
          </div>
          <button type="button" className="agent-detail-modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="agent-detail-modal-body">
          {state.loading && <div className="agent-detail-modal-loading">Loading…</div>}

          {!state.loading && state.error && <div className="agent-detail-modal-error">{state.error}</div>}

          {!state.loading && !state.error && (
            <>
              <div className="agent-driver-details-grid">
                <div className="agent-driver-details-row">
                  <div className="agent-driver-details-label">Name :</div>
                  <div className="agent-driver-details-value">
                    {state.driver?.full_name ||
                      summaryDriver?.full_name ||
                      summaryDriver?.username ||
                      `Driver #${driverId}`}
                  </div>
                </div>
                <div className="agent-driver-details-row">
                  <div className="agent-driver-details-label">Phone :</div>
                  <div className="agent-driver-details-value">
                    {state.driver?.phone ?? summaryDriver?.phone ?? '—'}
                  </div>
                </div>

                <div className="agent-driver-details-row">
                  <div className="agent-driver-details-label">Email address :</div>
                  <div className="agent-driver-details-value">
                    {state.driver?.email ?? summaryDriver?.email ?? '—'}
                  </div>
                </div>
                <div className="agent-driver-details-row">
                  <div className="agent-driver-details-label">Team :</div>
                  <div className="agent-driver-details-value">{state.driver?.team_name ?? '—'}</div>
                </div>

                <div className="agent-driver-details-row">
                  <div className="agent-driver-details-label">Transport Type :</div>
                  <div className="agent-driver-details-value">{state.driver?.transport_type ?? '—'}</div>
                </div>
                <div className="agent-driver-details-row">
                  <div className="agent-driver-details-label">License Plate :</div>
                  <div className="agent-driver-details-value">
                    {state.driver?.licence_plate ?? state.driver?.license_plate ?? '—'}
                  </div>
                </div>

                <div className="agent-driver-details-row">
                  <div className="agent-driver-details-label">Device Platform :</div>
                  <div className="agent-driver-details-value">
                    {state.driver?.device_platform ?? summaryDriver?.device ?? '—'}
                  </div>
                </div>
                <div className="agent-driver-details-row">
                  <div className="agent-driver-details-label">App Version :</div>
                  <div className="agent-driver-details-value">{state.driver?.app_version ?? '—'}</div>
                </div>
              </div>

              <div className="agent-driver-details-section-title">Task</div>

              <div className="agent-driver-details-table-wrap">
                <table className="agent-driver-details-table">
                  <thead>
                    <tr>
                      <th>Task ID</th>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Address</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.tasks.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="agent-driver-details-table-empty">
                          No tasks
                        </td>
                      </tr>
                    ) : (
                      state.tasks.map((t) => (
                        <tr key={t.task_id ?? t.id}>
                          <td>
                            <button
                              type="button"
                              className="agent-driver-details-task-link"
                              onClick={() => handleTaskClick(t.task_id ?? t.id)}
                            >
                              {t.task_id ?? t.id}
                            </button>
                          </td>
                          <td>{t.customer_name ?? t.task_description ?? '—'}</td>
                          <td>{t.trans_type ?? t.task_type ?? t.type ?? '—'}</td>
                          <td>{t.delivery_address ?? '—'}</td>
                          <td>
                            <span className={`agent-driver-details-task-status ${statusClass(t.status)}`}>
                              {statusLabel(t.status)}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="agent-detail-modal-actions">
          {footer ?? (
            <button type="button" className="agent-detail-modal-btn" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
