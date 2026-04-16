import { useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { setToken, setDashboardAdminId, notifyDashboardAdminIdChanged } from '../auth';
import { API_BASE } from '../api';
import { migrateLegacyMapMerchantFilterLocalStorage } from '../utils/mapMerchantFilterPrefs';
const LOGO_IMG = '/when-in-baguio-logo.png';

function IconEnvelope() {
  return (
    <svg className="login-svg-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  );
}
function IconLock() {
  return (
    <svg className="login-svg-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
function IconEye() {
  return (
    <svg className="login-svg-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function IconEyeOff() {
  return (
    <svg className="login-svg-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

export default function Login() {
  const [emailOrUsername, setEmailOrUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotLogin, setForgotLogin] = useState('');
  const [forgotCode, setForgotCode] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotMessage, setForgotMessage] = useState('');
  const [forgotError, setForgotError] = useState('');
  const submitLockRef = useRef(false);
  const navigate = useNavigate();
  const location = useLocation();

  const from = (location.state && location.state.from) ? location.state.from.pathname : '/';

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitLockRef.current) return;
    setError('');
    const login = (emailOrUsername || '').trim();
    if (!login || !password) {
      setError('Invalid credentials.');
      return;
    }
    submitLockRef.current = true;
    setLoading(true);
    try {
      const loginUrl = `${API_BASE.replace(/\/$/, '')}/auth/login`;
      const res = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_or_username: login,
          password,
          remember_me: rememberMe,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Invalid credentials.');
        return;
      }
      setToken(data.token || '', rememberMe);
      if (data.user?.admin_id != null) {
        setDashboardAdminId(data.user.admin_id, { skipEvent: true });
        migrateLegacyMapMerchantFilterLocalStorage();
        notifyDashboardAdminIdChanged();
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError('Invalid credentials.');
    } finally {
      setLoading(false);
      submitLockRef.current = false;
    }
  };

  const handleRequestResetCode = async () => {
    const login = (forgotLogin || emailOrUsername || '').trim();
    if (!login) {
      setForgotError('Enter your email or username first.');
      return;
    }
    setForgotLoading(true);
    setForgotError('');
    setForgotMessage('');
    try {
      const res = await fetch(`${API_BASE.replace(/\/$/, '')}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email_or_username: login }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setForgotError(data.error || 'Failed to request reset code.');
        return;
      }
      if (data.reset_code) {
        setForgotMessage(`Reset code (debug): ${data.reset_code}`);
      } else {
        setForgotMessage(data.message || 'If the account exists, a reset code has been sent.');
      }
    } catch (_) {
      setForgotError('Failed to request reset code.');
    } finally {
      setForgotLoading(false);
    }
  };

  const handleResetPassword = async () => {
    const login = (forgotLogin || emailOrUsername || '').trim();
    if (!login) {
      setForgotError('Enter your email or username.');
      return;
    }
    if (!forgotCode.trim()) {
      setForgotError('Enter the reset code.');
      return;
    }
    if (!forgotNewPassword || forgotNewPassword.length < 6) {
      setForgotError('New password must be at least 6 characters.');
      return;
    }
    if (forgotNewPassword !== forgotConfirmPassword) {
      setForgotError('Passwords do not match.');
      return;
    }
    setForgotLoading(true);
    setForgotError('');
    setForgotMessage('');
    try {
      const res = await fetch(`${API_BASE.replace(/\/$/, '')}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_or_username: login,
          reset_code: forgotCode.trim(),
          new_password: forgotNewPassword,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setForgotError(data.error || 'Failed to reset password.');
        return;
      }
      setForgotMessage(data.message || 'Password has been reset. You can log in now.');
      setForgotCode('');
      setForgotNewPassword('');
      setForgotConfirmPassword('');
      if (!emailOrUsername) setEmailOrUsername(login);
    } catch (_) {
      setForgotError('Failed to reset password.');
    } finally {
      setForgotLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-bg" aria-hidden="true" />
      <div className="login-card">
        <div className="login-logo-wrap">
          <img
            src={LOGO_IMG}
            className="login-logo-img"
            alt=""
            onError={(e) => {
              e.target.style.display = 'none';
              const fallback = e.target.nextElementSibling;
              if (fallback) fallback.classList.add('visible');
            }}
          />
          <div className="login-logo-fallback">
            <span className="login-logo-when">WHEN IN</span>
            <span className="login-logo-baguio"> BAGUIO</span>
          </div>
        </div>
        <p className="login-welcome">
          Welcome back! Log in to the Rider Dashboard. Use your admin email or username.
        </p>
        {error && (
          <div className="login-error" role="alert">
            {error}
          </div>
        )}
        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-label" htmlFor="login-email">
            Email or username
          </label>
          <div className="login-input-wrap">
            <span className="login-input-icon"><IconEnvelope /></span>
            <input
              id="login-email"
              type="text"
              className="login-input"
              value={emailOrUsername}
              onChange={(e) => setEmailOrUsername(e.target.value)}
              placeholder="admin@gmail.com"
              autoComplete="username"
              autoFocus
            />
          </div>
          <label className="login-label" htmlFor="login-password">
            Password
          </label>
          <div className="login-input-wrap">
            <span className="login-input-icon"><IconLock /></span>
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              className="login-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete="current-password"
            />
            <button
              type="button"
              className="login-password-toggle"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              tabIndex={-1}
            >
              {showPassword ? <IconEyeOff /> : <IconEye />}
            </button>
          </div>
          <div className="login-options">
            <label className="login-remember">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="login-checkbox"
              />
              <span>Remember Me</span>
            </label>
            <button
              type="button"
              className="login-forgot"
              onClick={() => {
                setForgotOpen((v) => !v);
                setForgotError('');
                setForgotMessage('');
                if (!forgotLogin && emailOrUsername) setForgotLogin(emailOrUsername);
              }}
            >
              Forgot password?
            </button>
          </div>
          {forgotOpen && (
            <div className="login-forgot-panel">
              <label className="login-label" htmlFor="forgot-login-id">
                Email or username
              </label>
              <input
                id="forgot-login-id"
                type="text"
                className="login-input"
                value={forgotLogin}
                onChange={(e) => setForgotLogin(e.target.value)}
                placeholder="admin@gmail.com"
                autoComplete="username"
              />
              <div className="login-forgot-actions">
                <button type="button" className="btn btn-sm" onClick={handleRequestResetCode} disabled={forgotLoading}>
                  {forgotLoading ? 'Sending…' : 'Send reset code'}
                </button>
              </div>

              <label className="login-label" htmlFor="forgot-code">
                Reset code
              </label>
              <input
                id="forgot-code"
                type="text"
                className="login-input"
                value={forgotCode}
                onChange={(e) => setForgotCode(e.target.value)}
                placeholder="6-digit code"
                autoComplete="one-time-code"
              />
              <label className="login-label" htmlFor="forgot-new-password">
                New password
              </label>
              <input
                id="forgot-new-password"
                type="password"
                className="login-input"
                value={forgotNewPassword}
                onChange={(e) => setForgotNewPassword(e.target.value)}
                placeholder="New password"
                autoComplete="new-password"
              />
              <label className="login-label" htmlFor="forgot-confirm-password">
                Confirm password
              </label>
              <input
                id="forgot-confirm-password"
                type="password"
                className="login-input"
                value={forgotConfirmPassword}
                onChange={(e) => setForgotConfirmPassword(e.target.value)}
                placeholder="Confirm password"
                autoComplete="new-password"
              />
              <div className="login-forgot-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={handleResetPassword} disabled={forgotLoading}>
                  {forgotLoading ? 'Resetting…' : 'Reset password'}
                </button>
              </div>
              {forgotError ? <div className="login-error" role="alert">{forgotError}</div> : null}
              {forgotMessage ? <div className="login-info" role="status">{forgotMessage}</div> : null}
            </div>
          )}
          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? 'Logging in…' : 'Login'}
          </button>
        </form>
        <p className="login-footer">
          Admin access only. Accounts are managed internally.
        </p>
      </div>
    </div>
  );
}
