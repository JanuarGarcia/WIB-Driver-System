import { Component } from 'react';

/**
 * Catches map render errors (e.g. Mapbox/Google failing) so the dashboard doesn't show a white screen.
 */
export default class MapErrorBoundary extends Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Map error:', error, errorInfo);
  }

  reset = () => this.setState({ hasError: false, error: null });

  render() {
    if (this.state.hasError) {
      const Fallback = this.props.fallback;
      if (typeof Fallback === 'function') {
        return Fallback({ error: this.state.error, reset: this.reset });
      }
      return (
        <div className="map-container map-error-fallback" style={{ minHeight: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, background: '#f5f5f5', borderRadius: 8 }}>
          <p style={{ margin: 0, color: '#b33' }}>Map failed to load.</p>
          <button type="button" className="btn" onClick={this.reset} style={{ marginTop: 12 }}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}
