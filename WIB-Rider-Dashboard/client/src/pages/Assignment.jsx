import { useState, useEffect } from 'react';
import { api } from '../api';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Assignment() {
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({
    driver_enabled_auto_assign: false,
    driver_include_offline_driver: false,
    driver_assign_onduty: false,
    driver_autoassign_notify_email: '',
    driver_request_expire_minutes: 10,
    driver_auto_retry_assignment: false,
    driver_assign_to: 'all',
    driver_auto_assign_type: 'one_by_one',
  });

  useEffect(() => {
    api('assignment-settings')
      .then((data) => {
        setForm({
          driver_enabled_auto_assign: !!data.driver_enabled_auto_assign,
          driver_include_offline_driver: !!data.driver_include_offline_driver,
          driver_assign_onduty: !!data.driver_assign_onduty,
          driver_autoassign_notify_email: data.driver_autoassign_notify_email || '',
          driver_request_expire_minutes: typeof data.driver_request_expire_minutes === 'number' ? data.driver_request_expire_minutes : parseInt(data.driver_request_expire_minutes, 10) || 10,
          driver_auto_retry_assignment: !!data.driver_auto_retry_assignment,
          driver_assign_to: data.driver_assign_to && ['all', 'driver_with_no_task', 'all_with_max_number'].includes(data.driver_assign_to) ? data.driver_assign_to : 'all',
          driver_auto_assign_type: data.driver_auto_assign_type && ['one_by_one', 'send_to_all'].includes(data.driver_auto_assign_type) ? data.driver_auto_assign_type : 'one_by_one',
        });
      })
      .catch(() => {});
  }, []);

  const handleChange = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const emailValue = form.driver_autoassign_notify_email.trim();
  const emailInvalid = emailValue.length > 0 && !EMAIL_RE.test(emailValue);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (emailInvalid) return;
    setLoading(true);
    setSaved(false);
    api('assignment-settings', { method: 'PUT', body: JSON.stringify(form) })
      .then(() => setSaved(true))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const autoAssignEnabled = form.driver_enabled_auto_assign;

  return (
    <div className="listing-section">
      <p className="assignment-intro text-muted">
        Automatically assign tasks to drivers. Choose options such as one-by-one or send to all.
      </p>
      <form onSubmit={handleSubmit} className="assignment-form">
        <div className={`assignment-settings-card ${!autoAssignEnabled ? 'assignment-settings-disabled' : ''}`}>
          <div className="assignment-settings-header">
            <input
              type="checkbox"
              id="driver_enabled_auto_assign"
              className="assignment-checkbox"
              checked={form.driver_enabled_auto_assign}
              onChange={(e) => handleChange('driver_enabled_auto_assign', e.target.checked)}
            />
            <label htmlFor="driver_enabled_auto_assign" className="assignment-toggle-label">
              Enable auto assignment
            </label>
          </div>
          <div className="assignment-settings-body">
            <div className="assignment-option">
              <input
                type="checkbox"
                id="driver_include_offline_driver"
                className="assignment-checkbox"
                checked={form.driver_include_offline_driver}
                onChange={(e) => handleChange('driver_include_offline_driver', e.target.checked)}
                disabled={!autoAssignEnabled}
              />
              <label htmlFor="driver_include_offline_driver" className={!autoAssignEnabled ? 'assignment-label-disabled' : ''}>
                Include offline drivers
              </label>
            </div>
            <div className="assignment-option assignment-option-with-help">
              <div className="assignment-option-row">
                <input
                  type="checkbox"
                  id="driver_assign_onduty"
                  className="assignment-checkbox"
                  checked={form.driver_assign_onduty}
                  onChange={(e) => handleChange('driver_assign_onduty', e.target.checked)}
                  disabled={!autoAssignEnabled}
                />
                <label htmlFor="driver_assign_onduty" className={!autoAssignEnabled ? 'assignment-label-disabled' : ''}>
                  Assign to on-duty drivers only
                </label>
              </div>
              <p className="assignment-help">
                Assign only to drivers who are on duty, regardless of online status.
              </p>
            </div>
            <div className="assignment-email-row">
              <label htmlFor="driver_autoassign_notify_email" className={!autoAssignEnabled ? 'assignment-label-disabled' : ''}>
                Notification email
              </label>
              <input
                type="email"
                id="driver_autoassign_notify_email"
                className={`form-control assignment-email-input ${emailInvalid ? 'assignment-email-invalid' : ''}`}
                value={form.driver_autoassign_notify_email}
                onChange={(e) => handleChange('driver_autoassign_notify_email', e.target.value)}
                placeholder="email@example.com"
                disabled={!autoAssignEnabled}
                aria-invalid={emailInvalid}
                aria-describedby={emailInvalid ? 'assignment-email-err' : undefined}
              />
              {emailInvalid && (
                <span id="assignment-email-err" className="assignment-email-error" role="alert">
                  Please enter a valid email address.
                </span>
              )}
            </div>
            <div className="assignment-option assignment-option-with-help">
              <label htmlFor="driver_request_expire_minutes" className={`assignment-field-label ${!autoAssignEnabled ? 'assignment-label-disabled' : ''}`}>
                Request expire (minutes)
              </label>
              <input
                type="number"
                id="driver_request_expire_minutes"
                min={1}
                max={120}
                className="form-control assignment-number-input"
                value={form.driver_request_expire_minutes}
                onChange={(e) => handleChange('driver_request_expire_minutes', Math.max(1, Math.min(120, parseInt(e.target.value, 10) || 10)))}
                disabled={!autoAssignEnabled}
              />
              <p className="assignment-help">How long a push request is valid before expiring (1–120 minutes).</p>
            </div>
            <div className="assignment-option">
              <input
                type="checkbox"
                id="driver_auto_retry_assignment"
                className="assignment-checkbox"
                checked={form.driver_auto_retry_assignment}
                onChange={(e) => handleChange('driver_auto_retry_assignment', e.target.checked)}
                disabled={!autoAssignEnabled}
              />
              <label htmlFor="driver_auto_retry_assignment" className={!autoAssignEnabled ? 'assignment-label-disabled' : ''}>
                Auto retry assignment
              </label>
            </div>
            <div className="assignment-option assignment-option-with-help">
              <label htmlFor="driver_assign_to" className={`assignment-field-label ${!autoAssignEnabled ? 'assignment-label-disabled' : ''}`}>
                Assign to
              </label>
              <select
                id="driver_assign_to"
                className="form-control assignment-select"
                value={form.driver_assign_to}
                onChange={(e) => handleChange('driver_assign_to', e.target.value)}
                disabled={!autoAssignEnabled}
              >
                <option value="all">Assign to all</option>
                <option value="driver_with_no_task">Driver with no task</option>
                <option value="all_with_max_number">All with max number</option>
              </select>
              <p className="assignment-help">Which drivers receive the assignment push: all, only those with no task, or all up to a max.</p>
            </div>
            <div className="assignment-option assignment-option-with-help">
              <label htmlFor="driver_auto_assign_type" className={`assignment-field-label ${!autoAssignEnabled ? 'assignment-label-disabled' : ''}`}>
                Auto assign type
              </label>
              <select
                id="driver_auto_assign_type"
                className="form-control assignment-select"
                value={form.driver_auto_assign_type}
                onChange={(e) => handleChange('driver_auto_assign_type', e.target.value)}
                disabled={!autoAssignEnabled}
              >
                <option value="one_by_one">One by one</option>
                <option value="send_to_all">Send to all</option>
              </select>
              <p className="assignment-help">One by one: try drivers sequentially until one accepts. Send to all: broadcast to all selected drivers at once.</p>
            </div>
          </div>
        </div>
        <div className="assignment-actions">
          <button type="submit" className="btn btn-sm btn-primary assignment-save-btn" disabled={loading || emailInvalid}>
            {loading ? 'Saving…' : 'Save'}
          </button>
          {saved && <span className="assignment-saved">Saved</span>}
        </div>
      </form>
    </div>
  );
}
