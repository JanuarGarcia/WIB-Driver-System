import React from 'react';

/**
 * Catches render errors during bootstrap so a failed chunk or bad import
 * does not leave a totally blank white page.
 */
export default class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err) {
    return { err };
  }

  render() {
    if (this.state.err) {
      const msg = this.state.err && this.state.err.message ? String(this.state.err.message) : String(this.state.err);
      return (
        <div
          style={{
            minHeight: '100vh',
            padding: 24,
            fontFamily: 'system-ui, sans-serif',
            background: '#1a1a1a',
            color: '#eee',
            boxSizing: 'border-box',
          }}
        >
          <h1 style={{ margin: '0 0 12px', fontSize: '1.25rem' }}>Dashboard could not load</h1>
          <p style={{ margin: '0 0 16px', opacity: 0.85, fontSize: '0.95rem' }}>
            Try a hard refresh (Ctrl+Shift+R). If this persists, redeploy the latest <code>client/dist</code> build so every{' '}
            <code>/assets/*.js</code> file matches <code>index.html</code> (stale chunks cause a blank page).
          </p>
          <pre
            style={{
              margin: 0,
              padding: 12,
              background: '#000',
              borderRadius: 8,
              fontSize: '0.8rem',
              overflow: 'auto',
              maxHeight: '40vh',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {msg}
          </pre>
          <button
            type="button"
            style={{ marginTop: 20, padding: '10px 18px', cursor: 'pointer', borderRadius: 8, fontSize: '1rem' }}
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
