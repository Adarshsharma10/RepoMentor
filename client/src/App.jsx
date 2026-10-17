import { useEffect, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

async function apiRequest(path, options = {}) {
  const token = localStorage.getItem('repomentor-token');
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong. Please try again.');
    error.data = data;
    throw error;
  }
  return data;
}

function Mark() {
  return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><rect width="40" height="40" rx="12" fill="currentColor"/><path d="M14 13.5 8 20l6 6.5M26 13.5 32 20l-6 6.5M23 11l-6 18" stroke="#F8FAFC" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg></span>;
}

export default function App() {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [repos, setRepos] = useState([]);
  const [reposBusy, setReposBusy] = useState(false);
  const [reposError, setReposError] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [addingRepo, setAddingRepo] = useState(false);
  const [repoMessage, setRepoMessage] = useState('');
  const [searchQueries, setSearchQueries] = useState({});
  const [searchResults, setSearchResults] = useState({});
  const [searchBusy, setSearchBusy] = useState({});
  const [searchErrors, setSearchErrors] = useState({});
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('repomentor-user') || 'null'); } catch { return null; }
  });

  useEffect(() => {
    if (!user) return;
    setReposBusy(true);
    setReposError('');
    apiRequest('/api/repos')
      .then(data => setRepos(data.repos))
      .catch(requestError => setReposError(requestError.message))
      .finally(() => setReposBusy(false));
  }, [user]);

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

  async function addRepository(event) {
    event.preventDefault();
    setAddingRepo(true);
    setReposError('');
    setRepoMessage('Indexing repository… this can take a little while.');
    try {
      const data = await apiRequest('/api/repos', {
        method: 'POST',
        body: JSON.stringify({ url: repoUrl })
      });
      setRepos(current => [data.repo, ...current]);
      setRepoUrl('');
      setRepoMessage(`Indexed ${data.repo.owner}/${data.repo.name}.`);
    } catch (requestError) {
      setReposError(requestError.message);
      setRepoMessage('');
      if (requestError.data?.repo) {
        setRepos(current => [requestError.data.repo, ...current.filter(repo => repo._id !== requestError.data.repo._id)]);
      }
    } finally {
      setAddingRepo(false);
    }
  }

  async function deleteRepository(repo) {
    if (!window.confirm(`Delete ${repo.owner}/${repo.name} and its saved chunks?`)) return;
    setReposError('');
    try {
      await apiRequest(`/api/repos/${repo._id}`, { method: 'DELETE' });
      setRepos(current => current.filter(item => item._id !== repo._id));
      setRepoMessage(`Deleted ${repo.owner}/${repo.name}.`);
    } catch (requestError) {
      setReposError(requestError.message);
    }
  }

  async function searchRepository(event, repo) {
    event.preventDefault();
    const query = (searchQueries[repo._id] || '').trim();
    setSearchBusy(current => ({ ...current, [repo._id]: true }));
    setSearchErrors(current => ({ ...current, [repo._id]: '' }));
    setSearchResults(current => ({ ...current, [repo._id]: [] }));
    try {
      const data = await apiRequest(`/api/repos/${repo._id}/search`, {
        method: 'POST',
        body: JSON.stringify({ query, limit: 5 })
      });
      setSearchResults(current => ({ ...current, [repo._id]: data.results }));
    } catch (requestError) {
      setSearchErrors(current => ({ ...current, [repo._id]: requestError.message }));
    } finally {
      setSearchBusy(current => ({ ...current, [repo._id]: false }));
    }
  }

  return <main className="page-shell">
    <header className="topbar"><a className="brand" href="#home"><Mark /><span>Repo<span className="brand-light">Mentor</span></span></a><span className="top-note">Your codebase, understood.</span></header>
    {user ? <section className="repo-workspace">
      <div className="workspace-heading">
        <div><div className="card-kicker">YOUR WORKSPACE</div><h1>Your repositories</h1><p>Add a GitHub repository to save its supported source files as line-numbered chunks. Without a GitHub token, only public repositories are available.</p></div>
        <div className="workspace-user"><span>Signed in as <strong>{user.name}</strong></span><button className="text-button" onClick={logout}>Sign out</button></div>
      </div>
      <div className="repo-add-card">
        <div><h2>Add repository</h2><p>Use a GitHub URL such as <code>https://github.com/owner/repo</code>.</p></div>
        <form className="repo-form" onSubmit={addRepository}>
          <label className="field"><span>GitHub repository URL</span><input type="text" inputMode="url" placeholder="https://github.com/owner/repo" value={repoUrl} onChange={event => setRepoUrl(event.target.value)} required /></label>
          <button className="submit-button" type="submit" disabled={addingRepo}>{addingRepo ? 'Indexing…' : 'Add repository'}<span>→</span></button>
        </form>
      </div>
      {repoMessage && <p className="repo-message" role="status">{repoMessage}</p>}
      {reposError && <p className="error-message repo-error" role="alert">{reposError}</p>}
      <div className="repo-list-heading"><h2>My repositories</h2><span>{repos.length} {repos.length === 1 ? 'repository' : 'repositories'}</span></div>
      {reposBusy ? <div className="repo-empty">Loading your repositories…</div> : repos.length === 0 ? <div className="repo-empty">No repositories yet. Add one above to get started.</div> : <div className="repo-list">
        {repos.map(repo => <article className="repo-item" key={repo._id}>
          <div className="repo-main"><a href={repo.url} target="_blank" rel="noreferrer">{repo.owner}/{repo.name} ↗</a><span className={`status-badge status-${repo.status}`}>{repo.status}</span>{repo.errorMessage && <small className="repo-item-error">{repo.errorMessage}</small>}
            {repo.status === 'ready' && <div className="repo-search">
              <form className="repo-search-form" onSubmit={event => searchRepository(event, repo)}>
                <label className="field"><span>Search this repo</span><input type="text" minLength={3} maxLength={500} placeholder="What does this code do?" value={searchQueries[repo._id] || ''} onChange={event => setSearchQueries(current => ({ ...current, [repo._id]: event.target.value }))} required /></label>
                <button className="text-button" type="submit" disabled={searchBusy[repo._id]}>{searchBusy[repo._id] ? 'Searching…' : 'Search'}</button>
              </form>
              {searchErrors[repo._id] && <p className="error-message repo-error" role="alert">{searchErrors[repo._id]}</p>}
              {searchResults[repo._id]?.length > 0 && <div className="search-results">
                {searchResults[repo._id].map(result => <article className="search-result" key={`${result.filePath}:${result.startLine}`}>
                  <div className="search-result-heading"><strong>{result.filePath}:{result.startLine}-{result.endLine}</strong><span>score {result.score.toFixed(3)}</span></div>
                  <pre><code>{result.code}</code></pre>
                </article>)}
              </div>}
              {searchResults[repo._id]?.length === 0 && !searchBusy[repo._id] && !searchErrors[repo._id] && <p className="no-search-results">No matching chunks found.</p>}
            </div>}
          </div>
          <div className="repo-counts"><span><strong>{repo.fileCount}</strong> files</span><span><strong>{repo.chunkCount}</strong> chunks</span></div>
          <button className="delete-button" onClick={() => deleteRepository(repo)} aria-label={`Delete ${repo.owner}/${repo.name}`}>Delete</button>
        </article>)}
      </div>}
    </section> : <section className="hero">
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
          <>
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
          </>
        </div>
        <p className="below-card">By continuing, you agree to our <a href="#terms">Terms</a> and <a href="#privacy">Privacy Policy</a>.</p>
      </div>
    </section>
    }
    <footer><span>© 2026 RepoMentor</span><span>Built for the curious engineer.</span></footer>
  </main>;
}
