import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

function normalizeAction(raw) {
  const a = String(raw || '').trim().toLowerCase();
  return a === 'clear' ? 'clear' : 'flag';
}

function reasonLabel(r) {
  const k = String(r || '').trim().toLowerCase();
  if (k === 'violation') return 'Violation';
  if (k === 'remittance') return 'Remittance';
  if (k === 'other') return 'Other';
  return 'Violation';
}

export default function OfficeHoldModal({
  open,
  action = 'flag',
  driverLabel = '',
  initialReason = 'violation',
  initialNote = '',
  initialForceOffDuty = true,
  submitting = false,
  onClose,
  onSubmit,
}) {
  const mode = normalizeAction(action);
  const [reason, setReason] = useState('violation');
  const [note, setNote] = useState('');
  const [forceOffDuty, setForceOffDuty] = useState(true);

  useEffect(() => {
    if (!open) return;
    setReason(String(initialReason || 'violation').trim().toLowerCase() || 'violation');
    setNote(String(initialNote || ''));
    setForceOffDuty(initialForceOffDuty !== false);
  }, [open, initialReason, initialNote, initialForceOffDuty]);

  const headingId = useMemo(
    () => (mode === 'flag' ? 'office-hold-modal-title-flag' : 'office-hold-modal-title-clear'),
    [mode]
  );

  const handleClose = useCallback(() => {
    if (!submitting) onClose?.();
  }, [submitting, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, handleClose]);

  const submit = async () => {
    if (typeof onSubmit !== 'function') return;
    if (mode === 'flag') {
      const r = String(reason || '').trim().toLowerCase();
      if (!['violation', 'remittance', 'other'].includes(r)) {
        alert('Please select a reason (violation, remittance, other).');
        return;
      }
      await onSubmit({
        action: 'flag',
        reason: r,
        note: note.trim() || '',
        force_off_duty: forceOffDuty,
      });
      return;
    }
    await onSubmit({
      action: 'clear',
      note: note.trim() || '',
    });
  };

  if (!open) return null;

  const headerClass =
    mode === 'flag'
      ? 'office-hold-modal-header office-hold-modal-header--flag'
      : 'office-hold-modal-header office-hold-modal-header--clear';

  const title = mode === 'flag' ? 'Office hold' : 'Clear office hold';
  const subtitle =
    mode === 'flag'
      ? 'Requires the rider to report to the office before resuming duty.'
      : 'Marks this rider as reported/complied and allows duty again.';

  return createPortal(
    <div className="modal-backdrop send-push-modal-backdrop" role="presentation" onClick={handleClose}>
      <div
        className="modal-box send-push-modal office-hold-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`modal-header send-push-modal-header ${headerClass}`}>
          <h3 id={headingId} className="send-push-modal-title">
            {title}
          </h3>
          <button
            type="button"
            className="send-push-modal-close"
            onClick={handleClose}
            disabled={submitting}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="modal-body send-push-modal-body">
          {driverLabel ? (
            <p className="send-push-modal-recipient muted" style={{ marginTop: 0 }}>
              Driver: <strong>{driverLabel}</strong>
            </p>
          ) : null}

          <p className="muted" style={{ marginTop: 0 }}>
            {subtitle}
          </p>

          {mode === 'flag' && (
            <div className="send-push-field">
              <label className="modal-label" htmlFor="office-hold-reason">
                Reason
              </label>
              <div className="office-hold-reason-row">
                <select
                  id="office-hold-reason"
                  className="form-control send-push-input"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={submitting}
                >
                  <option value="violation">Violation</option>
                  <option value="remittance">Remittance</option>
                  <option value="other">Other</option>
                </select>
                <span className="office-hold-reason-pill" title="Saved on the driver compliance record">
                  {reasonLabel(reason)}
                </span>
              </div>
              <p className="office-hold-help muted" style={{ marginBottom: 0 }}>
                This shows as “Not Reported” / “Not Remitted” on the drivers list.
              </p>
            </div>
          )}

          <div className="send-push-field">
            <label className="modal-label" htmlFor="office-hold-note">
              Note <span className="muted">(shown to admins only)</span>
            </label>
            <textarea
              id="office-hold-note"
              className="form-control send-push-textarea"
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={mode === 'flag' ? 'Example: Settle violation fee at office' : 'Example: Reported at office'}
              disabled={submitting}
            />
            <span className="send-push-char-count" aria-live="polite">
              {note.length} characters
            </span>
          </div>

          {mode === 'flag' && (
            <div className="send-push-field" style={{ marginBottom: 0 }}>
              <label className="office-hold-checkbox">
                <input
                  type="checkbox"
                  checked={!!forceOffDuty}
                  onChange={(e) => setForceOffDuty(e.target.checked)}
                  disabled={submitting}
                />
                <span>Force off duty immediately</span>
              </label>
              <p className="office-hold-help muted" style={{ marginTop: '0.35rem', marginBottom: 0 }}>
                Recommended. This will also remove the rider from the queue if present.
              </p>
            </div>
          )}

          <div className="modal-actions send-push-modal-actions">
            <button
              type="button"
              className={`btn btn-primary send-push-submit ${mode === 'flag' ? 'office-hold-submit--flag' : 'office-hold-submit--clear'}`}
              onClick={submit}
              disabled={submitting}
            >
              {submitting ? 'Saving…' : mode === 'flag' ? 'Apply hold' : 'Clear hold'}
            </button>
            <button
              type="button"
              className="btn send-push-cancel"
              onClick={handleClose}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

