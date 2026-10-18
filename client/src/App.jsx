import { useEffect, useRef, useState } from 'react';
import AuthScreen from './components/AuthScreen.jsx';
import CodeViewer from './components/CodeViewer.jsx';
import MarkdownAnswer from './components/MarkdownAnswer.jsx';
import { apiRequest, userFacingError } from './api.js';

const SUGGESTED_QUESTIONS = [
  'Where is authentication handled?',
  'How is the database connected?',
  'What does this project do?'
];

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true">R</span>;
}

function StatusIcon({ status }) {
  if (status === 'ready') return <svg className="status-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" /><path d="m6.5 10 2.2 2.2 4.8-5" /></svg>;
  if (status === 'failed') return <svg className="status-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" /><path d="m7.3 7.3 5.4 5.4m0-5.4-5.4 5.4" /></svg>;
  return <svg className="status-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" /><path d="M10 5.5V10l3 2" /></svg>;
}

function statusText(repo) {
  if (repo.status === 'ready') return 'Ready';
  if (repo.status === 'indexing') return 'Indexing';
  if (repo.status === 'failed') return 'Failed';
  return 'Waiting to index';
}

function StatusLabel({ repo }) {
  return <span className={`status-label status-${repo.status}`}><StatusIcon status={repo.status} />{statusText(repo)}</span>;
}

function Modal({ title, children, onClose, labelledBy }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const focusable = () => [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    focusable()[0]?.focus();
    function handleKeyDown(event) {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const items = focusable();
        if (!items.length) return;
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, []);

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={dialogRef} tabIndex={-1}>
      <h2 id={labelledBy}>{title}</h2>
      {children}
    </section>
  </div>;
}

function getStoredUser() {
  try { return JSON.parse(localStorage.getItem('repomentor-user') || 'null'); } catch { return null; }
}

function createSourceKey(source) {
  return `${source.filePath}:${source.startLine}-${source.endLine}`;
}

function SourceButton({ source, cited = false, onSelect }) {
  return <button className={`source-row${cited ? ' source-row-cited' : ''}`} type="button" onClick={() => onSelect(source)}>
    <span className="source-number">[{source.n}]</span>
    <span className="source-location">{source.filePath}:{source.startLine}-{source.endLine}</span>
    {cited && <span className="source-cited-label">Cited</span>}
  </button>;
}

function AnswerCard({ message, onSelectSource, selectedSource }) {
  const sources = message.sources || [];
  const sourceNumbers = new Set(sources.map(source => source.n));
  const citations = new Set(
  [...message.answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)]
    .flatMap((match) => match[1].split(',').map((value) => Number(value.trim())))
    .filter((number) => sourceNumbers.has(number)),
);
  const citedSources = sources.filter(source => citations.has(source.n));
  const otherSources = sources.filter(source => !citations.has(source.n));
  const messageKey = message._id || `${message.createdAt}-${message.question}`;
  const selectSource = source => onSelectSource(source, messageKey);

  return <article className="answer-card">
    <div className="message-question"><span className="message-label">You asked</span><p>{message.question}</p></div>
    <div className="answer-content" aria-live="polite">
      <span className="message-label">RepoMentor</span>
      <MarkdownAnswer answer={message.answer} sources={sources} onSelectSource={selectSource} selectedSourceNumber={selectedSource?.messageKey === messageKey ? selectedSource.source.n : null} />
    </div>
    {citedSources.length === 0
      ? <p className="conversation-empty">No relevant code found for this question.</p>
      : <section className="answer-sources" aria-label="Sources">
        <h3>Sources</h3>
        {citedSources.map(source => <SourceButton key={source.n} source={source} cited onSelect={selectSource} />)}
        {otherSources.length > 0 && <details className="other-sources">
          <summary>Other retrieved code ({otherSources.length})</summary>
          {otherSources.map(source => <SourceButton key={source.n} source={source} onSelect={selectSource} />)}
        </details>}
      </section>}
  </article>;
}

export default function App() {
  const [user, setUser] = useState(getStoredUser);
  const [repos, setRepos] = useState([]);
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [reposBusy, setReposBusy] = useState(false);
  const [reposError, setReposError] = useState('');
  const [repoMessage, setRepoMessage] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [addingRepo, setAddingRepo] = useState(false);
  const [addError, setAddError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingRepo, setDeletingRepo] = useState(false);
  const [activeTab, setActiveTab] = useState('ask');
  const [askQuestion, setAskQuestion] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState('');
  const [askMessages, setAskMessages] = useState({});
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [mobileViewerOpen, setMobileViewerOpen] = useState(false);

  const selectedRepo = repos.find(repo => repo._id === selectedRepoId) || null;

  useEffect(() => {
    if (!user) return undefined;
    let current = true;
    setReposBusy(true);
    setReposError('');
    apiRequest('/api/repos')
      .then(data => {
        if (!current) return;
        setRepos(data.repos);
        setSelectedRepoId(existingId => existingId || data.repos[0]?._id || '');
      })
      .catch(error => { if (current) setReposError(userFacingError(error)); })
      .finally(() => { if (current) setReposBusy(false); });
    return () => { current = false; };
  }, [user]);

  useEffect(() => {
    if (!selectedRepo || selectedRepo.status !== 'ready' || askMessages[selectedRepo._id] !== undefined) return undefined;
    let current = true;
    setHistoryBusy(true);
    setHistoryError('');
    apiRequest(`/api/repos/${selectedRepo._id}/messages`)
      .then(data => { if (current) setAskMessages(messages => ({ ...messages, [selectedRepo._id]: data.messages })); })
      .catch(error => { if (current) setHistoryError(userFacingError(error)); })
      .finally(() => { if (current) setHistoryBusy(false); });
    return () => { current = false; };
  }, [selectedRepo?._id, selectedRepo?.status, askMessages]);

  function logout() {
    localStorage.removeItem('repomentor-token');
    localStorage.removeItem('repomentor-user');
    setUser(null);
    setRepos([]);
    setSelectedRepoId('');
    setAskMessages({});
  }

  function selectRepository(repo) {
    setSelectedRepoId(repo._id);
    setActiveTab('ask');
    setAskQuestion('');
    setAskError('');
    setSearchError('');
    setHistoryError('');
    setHistoryBusy(false);
    setSearchResults([]);
    setSelectedSource(null);
    setMobileViewerOpen(false);
  }

  async function addRepository(event) {
    event.preventDefault();
    setAddingRepo(true);
    setAddError('');
    setRepoMessage('Adding and indexing repository…');
    try {
      const data = await apiRequest('/api/repos', { method: 'POST', body: JSON.stringify({ url: repoUrl }) });
      setRepos(current => [data.repo, ...current.filter(repo => repo._id !== data.repo._id)]);
      setSelectedRepoId(data.repo._id);
      setHistoryBusy(false);
      setActiveTab('ask');
      setRepoUrl('');
      setAddOpen(false);
      setRepoMessage(`${data.repo.owner}/${data.repo.name} is ready.`);
    } catch (error) {
      setAddError(userFacingError(error));
      setRepoMessage('');
      if (error.data?.repo) {
        setRepos(current => [error.data.repo, ...current.filter(repo => repo._id !== error.data.repo._id)]);
        setSelectedRepoId(error.data.repo._id);
        setHistoryBusy(false);
        setAddOpen(false);
      }
    } finally {
      setAddingRepo(false);
    }
  }

  async function deleteRepository() {
    if (!deleteTarget) return;
    setDeletingRepo(true);
    setReposError('');
    try {
      await apiRequest(`/api/repos/${deleteTarget._id}`, { method: 'DELETE' });
      setRepos(current => current.filter(repo => repo._id !== deleteTarget._id));
      setAskMessages(current => {
        const next = { ...current };
        delete next[deleteTarget._id];
        return next;
      });
      if (selectedRepoId === deleteTarget._id) {
        const nextRepo = repos.find(repo => repo._id !== deleteTarget._id);
        setSelectedRepoId(nextRepo?._id || '');
      }
      setRepoMessage(`${deleteTarget.owner}/${deleteTarget.name} was deleted.`);
      setSelectedSource(null);
      setMobileViewerOpen(false);
      setDeleteTarget(null);
    } catch (error) {
      setReposError(userFacingError(error));
    } finally {
      setDeletingRepo(false);
    }
  }

  async function askRepository(event) {
    event.preventDefault();
    if (!selectedRepo) return;
    const question = askQuestion.trim();
    setAskBusy(true);
    setAskError('');
    try {
      const data = await apiRequest(`/api/repos/${selectedRepo._id}/ask`, {
        method: 'POST',
        body: JSON.stringify({ question })
      });
      const message = { question, answer: data.answer, sources: data.sources, createdAt: new Date().toISOString() };
      setAskMessages(current => ({ ...current, [selectedRepo._id]: [...(current[selectedRepo._id] || []), message] }));
      setAskQuestion('');
    } catch (error) {
      setAskError(userFacingError(error));
    } finally {
      setAskBusy(false);
    }
  }

  async function searchRepository(event) {
    event.preventDefault();
    if (!selectedRepo) return;
    setSearchBusy(true);
    setSearchError('');
    setSearchResults([]);
    try {
      const data = await apiRequest(`/api/repos/${selectedRepo._id}/search`, {
        method: 'POST',
        body: JSON.stringify({ query: searchQuery.trim(), limit: 5 })
      });
      setSearchResults(data.results);
    } catch (error) {
      setSearchError(userFacingError(error));
    } finally {
      setSearchBusy(false);
    }
  }

  function openSource(source, messageKey = 'search') {
    setSelectedSource({ source, messageKey });
    setMobileViewerOpen(true);
  }

  useEffect(() => {
    if (!selectedSource) return undefined;
    function closeOnEscape(event) {
      if (event.key === 'Escape') {
        setSelectedSource(null);
        setMobileViewerOpen(false);
      }
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [selectedSource]);

  if (!user) return <AuthScreen onAuthenticated={setUser} />;

  const messages = selectedRepo ? askMessages[selectedRepo._id] || [] : [];

  return <div className="app-shell">
    <aside className="sidebar" aria-label="Repository navigation">
      <a className="brand" href="#home"><BrandMark /><span>RepoMentor</span></a>
      <div className="sidebar-heading"><h2>Repositories</h2><span className="repo-total">{repos.length}</span></div>
      <button className="button button-secondary add-repository-button" type="button" onClick={() => { setAddError(''); setAddOpen(true); }}><span aria-hidden="true">+</span> Add repository</button>
      <nav className="repo-navigation" aria-label="Your repositories">
        {reposBusy && <p className="sidebar-message" role="status">Loading repositories…</p>}
        {repos.map(repo => <button className={`repo-nav-item${selectedRepoId === repo._id ? ' selected' : ''}`} type="button" key={repo._id} onClick={() => selectRepository(repo)} aria-current={selectedRepoId === repo._id ? 'page' : undefined}>
          <span className="repo-nav-name">{repo.owner}/{repo.name}</span><StatusLabel repo={repo} />
        </button>)}
        {!reposBusy && repos.length === 0 && <p className="sidebar-message">No repositories added yet.</p>}
      </nav>
      <div className="sidebar-account"><span className="avatar" aria-hidden="true">{user.name?.slice(0, 1).toUpperCase() || 'U'}</span><span className="account-name">{user.name}</span><button className="button button-quiet sign-out-button" type="button" onClick={logout}>Sign out</button></div>
    </aside>

    <main className="main-area">
      {reposError && <p className="inline-error" role="alert">{reposError}</p>}
      {repoMessage && <p className="inline-status" role="status">{repoMessage}</p>}
      {!selectedRepo ? <section className="empty-workspace">
        <div className="empty-icon" aria-hidden="true">⌘</div>
        <h1>Workspace</h1>
        <p>Add a public GitHub repository to start asking questions about its code.</p>
        <button className="button button-primary" type="button" onClick={() => { setAddError(''); setAddOpen(true); }}>Add repository</button>
      </section> : <>
        <header className="repo-header">
          <div className="repo-heading-copy">
            <p className="breadcrumb">Your repositories <span aria-hidden="true">/</span> {selectedRepo.owner}</p>
            <h1>{selectedRepo.name}</h1>
            <a className="repo-url" href={selectedRepo.url} target="_blank" rel="noreferrer">{selectedRepo.url}</a>
          </div>
          <div className="repo-header-actions"><StatusLabel repo={selectedRepo} /><button className="button button-danger-quiet" type="button" onClick={() => setDeleteTarget(selectedRepo)}>Delete repository</button></div>
        </header>

        {selectedRepo.status === 'failed' && <section className="status-explanation" role="status"><StatusIcon status="failed" /><div><h2>Indexing failed</h2><p>{selectedRepo.errorMessage || 'The repository could not be indexed.'} Delete this repository and add it again after fixing the issue.</p></div></section>}
        {(selectedRepo.status === 'indexing' || selectedRepo.status === 'pending') && <section className="status-explanation" role="status"><StatusIcon status={selectedRepo.status} /><div><h2>{selectedRepo.status === 'indexing' ? 'Indexing repository' : 'Waiting to index'}</h2><p>RepoMentor is preparing the repository code. You can ask questions when indexing is ready.</p></div></section>}

        {selectedRepo.status === 'ready' && <>
          <div className="workspace-tabs" role="tablist" aria-label="Repository tools">
            <button className={activeTab === 'ask' ? 'active' : ''} type="button" role="tab" aria-selected={activeTab === 'ask'} onClick={() => setActiveTab('ask')}>Ask</button>
            <button className={activeTab === 'search' ? 'active' : ''} type="button" role="tab" aria-selected={activeTab === 'search'} onClick={() => setActiveTab('search')}>Search</button>
          </div>
          <div className="workspace-grid">
            <section className="conversation-panel" aria-label={activeTab === 'ask' ? 'Ask about this repository' : 'Search this repository'}>
              {activeTab === 'ask' ? <>
                <div className="conversation-heading"><h2>Ask about this repository</h2><p>Answers use the indexed code and link to their sources.</p></div>
                {historyError && <p className="inline-error" role="alert">{historyError}</p>}
                <div className="conversation-history" aria-live="polite">
                  {historyBusy && messages.length === 0 && <div className="answer-skeleton" role="status" aria-live="polite"><span>Loading your previous answers</span><i /><i /><i /></div>}
                  {!historyBusy && messages.length === 0 && <p className="conversation-empty">Ask a question to see an answer grounded in this repository.</p>}
                  {messages.map((message, index) => <AnswerCard key={message._id || `${message.createdAt}-${index}`} message={message} onSelectSource={openSource} selectedSource={selectedSource} />)}
                  {askBusy && <div className="answer-skeleton" role="status" aria-live="polite"><span>Finding an answer in your code</span><i /><i /><i /></div>}
                </div>
                {messages.length === 0 && <div className="suggested-questions" aria-label="Suggested questions"><p>Try a question</p>{SUGGESTED_QUESTIONS.map(question => <button type="button" key={question} onClick={() => setAskQuestion(question)}>{question}</button>)}</div>}
                {askError && <p className="inline-error" role="alert">{askError}</p>}
                <form className="question-form" onSubmit={askRepository}>
                  <label className="visually-hidden" htmlFor="question-input">Your question</label>
                  <textarea id="question-input" rows="2" maxLength={500} minLength={3} value={askQuestion} onChange={event => setAskQuestion(event.target.value)} placeholder="Ask about the code…" disabled={askBusy} required />
                  <button className="button button-primary question-submit" type="submit" disabled={askBusy || askQuestion.trim().length < 3}>{askBusy ? 'Thinking…' : 'Ask'}</button>
                </form>
              </> : <>
                <div className="conversation-heading"><h2>Closest matches</h2><p>Search for code by describing what you need.</p></div>
                <form className="search-form" onSubmit={searchRepository}>
                  <label className="visually-hidden" htmlFor="search-input">Search this repository</label>
                  <input id="search-input" type="search" minLength={3} maxLength={500} value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="What does this code do?" required />
                  <button className="button button-primary" type="submit" disabled={searchBusy || searchQuery.trim().length < 3}>{searchBusy ? 'Searching…' : 'Search'}</button>
                </form>
                {searchBusy && <div className="answer-skeleton" role="status" aria-live="polite"><span>Searching indexed code</span><i /><i /><i /></div>}
                {searchError && <p className="inline-error" role="alert">{searchError}</p>}
                {!searchBusy && searchResults.length === 0 && !searchError && <p className="conversation-empty">Closest code matches will appear here.</p>}
                <div className="closest-matches">{searchResults.map((result, index) => <article className="match-card" key={createSourceKey(result)}>
                  <button className="match-location" type="button" onClick={() => openSource({ ...result, n: index + 1 })}>{result.filePath}:{result.startLine}-{result.endLine}</button>
                  <span className="match-score" aria-label={`Similarity score ${Number(result.score).toFixed(3)}`}>{Number(result.score).toFixed(3)}</span>
                  <pre><code>{result.code}</code></pre>
                </article>)}</div>
              </>}
            </section>
            <CodeViewer source={selectedSource?.source} mobileOpen={mobileViewerOpen} onClose={() => { setMobileViewerOpen(false); setSelectedSource(null); }} />
          </div>
        </>}
      </>}
    </main>

    {addOpen && <Modal title="Add a public GitHub repository" labelledBy="add-repository-title" onClose={() => { if (!addingRepo) setAddOpen(false); }}>
      <p className="modal-description">Add a public GitHub repository to index its source code.</p>
      <form className="modal-form" onSubmit={addRepository}>
        <label className="field" htmlFor="repository-url"><span>GitHub repository URL</span><input id="repository-url" type="url" inputMode="url" placeholder="https://github.com/owner/repo" value={repoUrl} onChange={event => setRepoUrl(event.target.value)} required disabled={addingRepo} /></label>
        {addError && <p className="field-error" role="alert">{addError}</p>}
        <div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => setAddOpen(false)} disabled={addingRepo}>Cancel</button><button className="button button-primary" type="submit" disabled={addingRepo}>{addingRepo ? 'Indexing…' : 'Add repository'}</button></div>
      </form>
    </Modal>}

    {deleteTarget && <Modal title="Delete this repository and its indexed code?" labelledBy="delete-repository-title" onClose={() => { if (!deletingRepo) setDeleteTarget(null); }}>
      <p className="modal-description">This removes {deleteTarget.owner}/{deleteTarget.name} and its saved code from your workspace.</p>
      <div className="modal-actions"><button className="button button-secondary" type="button" onClick={() => setDeleteTarget(null)} disabled={deletingRepo}>Cancel</button><button className="button button-danger" type="button" onClick={deleteRepository} disabled={deletingRepo}>{deletingRepo ? 'Deleting…' : 'Delete repository'}</button></div>
    </Modal>}
  </div>;
}
