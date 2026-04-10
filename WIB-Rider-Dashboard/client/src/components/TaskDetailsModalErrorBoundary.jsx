import { Component } from 'react';

/**
 * Prevents a TaskDetailsModal render crash from taking down the whole dashboard (black screen + dark backdrop).
 */
export default class TaskDetailsModalErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[TaskDetailsModal]', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    const { children, onClose } = this.props;
    if (error) {
      return (
        <div
          className="modal-backdrop task-details-backdrop"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="task-details-error-title"
          onClick={() => {
            this.setState({ error: null });
            onClose?.();
          }}
        >
          <div className="modal-box modal-box-lg task-details-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header task-details-modal-header">
              <h3 id="task-details-error-title">Could not open task</h3>
            </div>
            <div className="modal-body">
              <p className="muted">
                The order details view hit an unexpected error. You can close this and try again, or refresh the page if
                it keeps happening.
              </p>
            </div>
            <div className="modal-footer-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  this.setState({ error: null });
                  onClose?.();
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      );
    }
    return children;
  }
}
