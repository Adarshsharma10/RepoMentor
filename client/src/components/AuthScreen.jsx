import { useEffect, useRef, useState } from 'react';
import { API_URL, userFacingError } from '../api.js';

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true">R</span>;
}

export default function AuthScreen({ onAuthenticated, healthState }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const formRef = useRef(null);

  useEffect(() => {
    formRef.current?.querySelector('input')?.focus();
  }, [mode]);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const response = await fetch(`${API_URL}/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Check your details and try again.');
      localStorage.setItem('repomentor-token', data.token);
      localStorage.setItem('repomentor-user', JSON.stringify(data.user));
      onAuthenticated(data.user);
    } catch (requestError) {
      setError(userFacingError(requestError, 'Check your details and try again.'));
    } finally {
      setBusy(false);
    }
  }

  function selectMode(nextMode) {
    setMode(nextMode);
    setError('');
  }

  return <main className="auth-page">
    {healthState === 'checking' && <p className="health-banner" role="status"><span className="loading-spinner" aria-hidden="true" />Waking up the server. Free hosting can take up to a minute.</p>}
    {healthState === 'failed' && <p className="health-banner health-banner-error" role="alert">The server is not responding. Try again in a minute.</p>}
    <header className="auth-header"><a className="brand" href="#home"><BrandMark /><span>RepoMentor</span></a><span className="auth-header-note">Understand your codebase</span></header>
    <div className="auth-layout">
      <section className="auth-intro" aria-labelledby="auth-title">
        <p className="eyebrow">Code answers with a trail</p>
        <h1 id="auth-title">A clearer way to understand your code.</h1>
        <p className="auth-lede">Ask about a repository and follow each answer back to the files and lines behind it.</p>
        <ul className="auth-benefits">
          <li><span className="benefit-mark" aria-hidden="true">✓</span><span><strong>Grounded in source code</strong><span>Answers use retrieved code from your repository.</span></span></li>
          <li><span className="benefit-mark" aria-hidden="true">⌕</span><span><strong>Citations you can open</strong><span>Jump from an answer to its file and line range.</span></span></li>
        </ul>
      </section>

      <section className="auth-card" aria-labelledby="form-title">
        <h2 id="form-title">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
        <p className="auth-card-copy">{mode === 'login' ? 'Sign in to continue to your repositories.' : 'Set up your RepoMentor workspace.'}</p>
        <div className="auth-switch" role="tablist" aria-label="Account action">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'selected' : ''} onClick={() => selectMode('login')}>Sign in</button>
          <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'selected' : ''} onClick={() => selectMode('register')}>Create account</button>
        </div>
        <form ref={formRef} onSubmit={submit} noValidate>
          {mode === 'register' && <label className="field"><span>Name</span><input autoComplete="name" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} required minLength={2} maxLength={80} aria-invalid={Boolean(error)} /></label>}
          <label className="field"><span>Email</span><input type="email" autoComplete="email" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} required maxLength={254} aria-invalid={Boolean(error)} /></label>
          <label className="field"><span>Password</span><input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} required minLength={8} maxLength={128} aria-invalid={Boolean(error)} /></label>
          {error && <p className="field-error" role="alert">{error}</p>}
          <button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        <p className="auth-secure">Your password is protected by RepoMentor’s authentication service.</p>
      </section>
    </div>
  </main>;
}
