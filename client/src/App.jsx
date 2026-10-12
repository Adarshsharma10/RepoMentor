import { useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

function Mark() {
  return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><rect width="40" height="40" rx="12" fill="currentColor"/><path d="M14 13.5 8 20l6 6.5M26 13.5 32 20l-6 6.5M23 11l-6 18" stroke="#F8FAFC" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg></span>;
}

export default function App() {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('repomentor-user') || 'null'); } catch { return null; }
  });

  function changeMode(nextMode) {
    setMode(nextMode);
    setError('');
  }

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
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
      localStorage.setItem('repomentor-token', data.token);
      localStorage.setItem('repomentor-user', JSON.stringify(data.user));
      setUser(data.user);
    } catch (requestError) {
      setError(requestError.message === 'Failed to fetch' ? 'Could not reach the server. Check that the API is running.' : requestError.message);
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    localStorage.removeItem('repomentor-token');
    localStorage.removeItem('repomentor-user');
    setUser(null);
  }

  return <main className="page-shell">
    <header className="topbar"><a className="brand" href="#home"><Mark /><span>Repo<span className="brand-light">Mentor</span></span></a><span className="top-note">Your codebase, understood.</span></header>
    <section className="hero">
      <div className="intro">
        <div className="eyebrow"><span className="eyebrow-dot" />A clearer way to explore code</div>
        <h1>Meet your codebase<br /><span>where it is.</span></h1>
        <p className="intro-copy">Ask questions about your repositories and get answers grounded in the code, with citations you can follow.</p>
        <div className="feature-list">
          <div className="feature"><span className="feature-icon">⌘</span><span><strong>Context, not guesswork</strong><small>Answers connected to your source code</small></span></div>
          <div className="feature"><span className="feature-icon">↗</span><span><strong>Every answer has a trail</strong><small>Jump straight to the relevant file and line</small></span></div>
        </div>
        <div className="code-note"><span className="code-dots"><i /><i /><i /></span><span><span className="code-muted">const answer =</span> <span className="code-green">yourCodebase</span><span className="code-muted">.explain();</span></span><span className="code-cursor" /></div>
      </div>

      <div className="auth-wrap">
        <div className="auth-card">
          {user ? <div className="signed-in">
            <div className="success-icon">✓</div><div className="card-kicker">YOU’RE SIGNED IN</div><h2>Welcome, {user.name}.</h2><p className="form-subtitle">Your RepoMentor account is ready. Repository Q&amp;A will arrive in a later phase.</p><button className="submit-button" onClick={logout}>Sign out</button>
          </div> : <>
            <div className="card-kicker">{mode === 'login' ? 'WELCOME BACK' : 'GET STARTED'}</div>
            <h2>{mode === 'login' ? 'Sign in to RepoMentor' : 'Create your account'}</h2>
            <p className="form-subtitle">{mode === 'login' ? 'Pick up where you left off in your codebase.' : 'Set up your workspace in just a moment.'}</p>
            <div className="mode-switch" role="tablist" aria-label="Account action">
              <button className={mode === 'login' ? 'active' : ''} onClick={() => changeMode('login')} role="tab" aria-selected={mode === 'login'}>Sign in</button>
              <button className={mode === 'register' ? 'active' : ''} onClick={() => changeMode('register')} role="tab" aria-selected={mode === 'register'}>Create account</button>
            </div>
            <form onSubmit={submit}>
              {mode === 'register' && <label className="field"><span>Your name</span><input autoComplete="name" placeholder="Alex Morgan" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} required minLength={2} maxLength={80} /></label>}
              <label className="field"><span>Email address</span><input type="email" autoComplete="email" placeholder="you@company.com" value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} required maxLength={254} /></label>
              <label className="field"><span>Password</span><input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder="At least 8 characters" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} required minLength={8} maxLength={128} /></label>
              {error && <p className="error-message" role="alert">{error}</p>}
              <button className="submit-button" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}<span>→</span></button>
            </form>
            <p className="secure-note"><span>◈</span> Your credentials are encrypted and secure.</p>
          </>}
        </div>
        <p className="below-card">By continuing, you agree to our <a href="#terms">Terms</a> and <a href="#privacy">Privacy Policy</a>.</p>
      </div>
    </section>
    <footer><span>© 2026 RepoMentor</span><span>Built for the curious engineer.</span></footer>
  </main>;
}
