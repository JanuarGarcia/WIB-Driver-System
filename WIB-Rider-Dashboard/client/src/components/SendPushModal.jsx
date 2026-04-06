import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';

/**
 * Admin → single driver FCM (POST /drivers/:id/send-push).
 * Matches legacy WIB Rider “Send Push Notification” flow; styling uses dashboard send-push-* classes.
 */
export default function SendPushModal({ open, driverId, driverLabel = '', onClose, onSent }) {
  const [title, setTitle] = useState('Notification');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle('Notification');
    setMessage('');
    setSending(false);
  }, [open, driverId]);

  const handleClose = useCallback(() => {
    if (!sending) onClose();
  }, [sending, onClose]);

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
    const id = driverId != null ? parseInt(String(driverId), 10) : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      alert('Cannot send push: invalid driver ID.');
      return;
    }
    setSending(true);
    try {
      await api(`drivers/${id}/send-push`, {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim() || 'Notification',
          message: message.trim() || 'You have a new notification.',
        }),
      });
      onSent?.();
      onClose();
    } catch (err) {
      alert(err?.error || err?.message || 'Failed to send push');
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  const headingId = 'send-push-notification-modal-title';

  return createPortal(
    <div
      className="modal-backdrop send-push-modal-backdrop"
      role="presentation"
      onClick={handleClose}
    >
      <div
        className="modal-box send-push-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header send-push-modal-header">
          <h3 id={headingId} className="send-push-modal-title">
            Send Push Notification :
          </h3>
          <button
            type="button"
            className="send-push-modal-close"
            onClick={handleClose}
            disabled={sending}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="modal-body send-push-modal-body">
          {driverLabel ? (
            <p className="send-push-modal-recipient muted" style={{ marginTop: 0 }}>
              To: <strong>{driverLabel}</strong>
            </p>
          ) : null}
          <div className="send-push-field">
            <label className="modal-label" htmlFor="send-push-modal-title-input">
              Push Title
            </label>
            <input
              id="send-push-modal-title-input"
              type="text"
              className="form-control send-push-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Push Title"
              disabled={sending}
              autoComplete="off"
            />
          </div>
          <div className="send-push-field">
            <label className="modal-label" htmlFor="send-push-modal-message-input">
              Push Message
            </label>
            <textarea
              id="send-push-modal-message-input"
              className="form-control send-push-textarea"
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Push Message"
              disabled={sending}
            />
            <span className="send-push-char-count" aria-live="polite">
              {message.length} characters
            </span>
          </div>
          <div className="modal-actions send-push-modal-actions">
            <button
              type="button"
              className="btn btn-primary send-push-submit"
              onClick={submit}
              disabled={sending}
            >
              {sending ? 'Sending…' : 'Submit'}
            </button>
            <button
              type="button"
              className="btn send-push-cancel send-push-cancel-btn"
              onClick={handleClose}
              disabled={sending}
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
