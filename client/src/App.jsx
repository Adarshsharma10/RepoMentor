import { useEffect, useRef, useState } from 'react';
import AuthScreen from './components/AuthScreen.jsx';
import CodeViewer from './components/CodeViewer.jsx';
import MarkdownAnswer from './components/MarkdownAnswer.jsx';
import { API_URL, apiRequest, userFacingError } from './api.js';
import { consumeSseStream, getStreamErrorMessage, removeTrailingIncompleteCitation, STREAM_ERROR_FALLBACK } from './streaming.js';
import { parseCitationMarkers } from './citationMarkers.js';

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
    <span className="source-location">{source.filePath}:{source.startLine}-{source.endLine}{source.symbol && <span className="source-symbol"> · {source.symbol}</span>}</span>
    {cited && <span className="source-cited-label">Cited</span>}
  </button>;
}

function AnswerCard({ message, onSelectSource, selectedSource, isStreaming = false }) {
  const sources = message.sources || [];
  const sourceNumbers = new Set(sources.map(source => source.n));
  const citations = new Set(
  parseCitationMarkers(message.answer, sourceNumbers)
    .flatMap((marker) => marker.numbers)
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
    {isStreaming && sources.length > 0
      ? <section className="answer-sources" aria-label="Sources"><h3>Sources</h3>{sources.map(source => <SourceButton key={source.n} source={source} cited={citations.has(source.n)} onSelect={selectSource} />)}</section>
      : citedSources.length === 0
      ? null
      : <section className="answer-sources" aria-label="Sources">
        <h3>Sources</h3>
        {citedSources.map(source => <SourceButton key={source.n} source={source} cited onSelect={selectSource} />)}
        {otherSources.length > 0 && <details className="other-sources">
          <summary>Other retrieved code ({otherSources.length})</summary>
          {otherSources.map(source => <SourceButton key={source.n} source={source} onSelect={selectSource} />)}
        </details>}
      </section>}
    {message.grounded === false && <p className="grounding-note">This answer isn't backed by code citations. Check it against the source.</p>}
    {message.stopped && <p className="conversation-empty">Stopped. This partial answer is not saved.</p>}
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
  const [streamingMessage, setStreamingMessage] = useState(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [mobileViewerOpen, setMobileViewerOpen] = useState(false);
  const [healthState, setHealthState] = useState('checking');
  const askControllerRef = useRef(null);
  const askRequestIdRef = useRef(0);

  const selectedRepo = repos.find(repo => repo._id === selectedRepoId) || null;

  useEffect(() => {
    let current = true;
    let retryTimer;
    const deadline = Date.now() + 90_000;
    const checkHealth = async () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (current) setHealthState('failed');
        return;
      }
      retryTimer = window.setTimeout(checkHealth, Math.min(3000, remaining));
      try {
        const response = await fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(Math.min(2500, remaining)) });
        if (!response.ok) throw new Error('Health check failed');
        if (current) {
          window.clearTimeout(retryTimer);
          setHealthState('ready');
        }
      } catch {
        if (!current) return;
        if (Date.now() >= deadline) {
          setHealthState('failed');
        }
      }
    };
    checkHealth();
    return () => {
      current = false;
      window.clearTimeout(retryTimer);
    };
  }, []);

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
    askRequestIdRef.current += 1;
    askControllerRef.current?.abort();
    localStorage.removeItem('repomentor-token');
    localStorage.removeItem('repomentor-user');
    setUser(null);
    setRepos([]);
    setSelectedRepoId('');
    setAskMessages({});
    setStreamingMessage(null);
    setAskBusy(false);
  }

  function selectRepository(repo) {
    askRequestIdRef.current += 1;
    askControllerRef.current?.abort();
    askControllerRef.current = null;
    setAskBusy(false);
    setStreamingMessage(null);
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
    const repoId = selectedRepo._id;
    askControllerRef.current?.abort();
    const requestId = askRequestIdRef.current + 1;
    askRequestIdRef.current = requestId;
    const controller = new AbortController();
    askControllerRef.current = controller;
    let current = { question, answer: '', sources: [], createdAt: new Date().toISOString() };
    let streamErrorMessage = '';
    setStreamingMessage({ repoId, message: current });
    setAskBusy(true);
    setAskError('');
    try {
      const token = localStorage.getItem('repomentor-token');
      const response = await fetch(`${API_URL}/api/repos/${repoId}/ask/stream`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ question })
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'The request could not be completed. Check the details and try again.');
      }
      if (!response.body) throw new Error('The server did not provide a readable answer stream.');
      let completed = false;
      await consumeSseStream(response.body.getReader(), event => {
        if (askRequestIdRef.current !== requestId || controller.signal.aborted) return;
        const payload = JSON.parse(event.data);
        if (event.event === 'sources') {
          current = { ...current, sources: payload };
          setStreamingMessage({ repoId, message: current });
        } else if (event.event === 'token') {
          current = { ...current, answer: current.answer + payload.text };
          setStreamingMessage({ repoId, message: current });
        } else if (event.event === 'done') {
          completed = true;
          current = { ...current, _id: payload.messageId, answer: payload.answer, grounded: payload.grounded };
          setAskMessages(messages => ({ ...messages, [repoId]: [...(messages[repoId] || []), current] }));
          setStreamingMessage(null);
          setAskQuestion('');
        } else if (event.event === 'error') {
          streamErrorMessage = getStreamErrorMessage(event.data);
          throw new Error(streamErrorMessage);
        }
      }, controller.signal);
      if (!completed && current.answer && askRequestIdRef.current === requestId) {
        // The stream may have ended without a done event; keep the transient answer visible.
        setStreamingMessage({ repoId, message: current });
        setAskError('The answer stream ended before it was saved. Try again.');
      } else if (!completed && askRequestIdRef.current === requestId) {
        throw new Error('The answer stream ended before completion. Try again.');
      }
    } catch (error) {
      if (askRequestIdRef.current === requestId && error.name !== 'AbortError') {
        const connectionFailed = !streamErrorMessage && (error instanceof TypeError || error.message === 'Failed to fetch');
        setAskError(streamErrorMessage || (connectionFailed ? STREAM_ERROR_FALLBACK : userFacingError(error)));
      }
    } finally {
      if (askRequestIdRef.current === requestId) {
        if (askControllerRef.current === controller) askControllerRef.current = null;
        setAskBusy(false);
      }
    }
  }

  function stopAsking() {
    const controller = askControllerRef.current;
    askRequestIdRef.current += 1;
    controller?.abort();
    askControllerRef.current = null;
    setAskBusy(false);
    setAskError('');
    setStreamingMessage(current => {
      if (current?.repoId !== selectedRepoId) {
        return {
          repoId: selectedRepoId,
          message: {
            question: askQuestion.trim(), answer: '', sources: [],
            createdAt: new Date().toISOString(), stopped: true
          }
        };
      }
      return {
        ...current,
        message: {
          ...current.message,
          answer: removeTrailingIncompleteCitation(current.message.answer),
          stopped: true
        }
      };
    });
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

  if (!user) return <AuthScreen onAuthenticated={setUser} healthState={healthState} />;

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
      {healthState === 'checking' && <p className="health-banner" role="status"><span className="loading-spinner" aria-hidden="true" />Waking up the server. Free hosting can take up to a minute.</p>}
      {healthState === 'failed' && <p className="health-banner health-banner-error" role="alert">The server is not responding. Try again in a minute.</p>}
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
        {(selectedRepo.status === 'indexing' || selectedRepo.status === 'pending') && <section className="status-explanation" role="status">{selectedRepo.status === 'indexing' ? <span className="loading-spinner indexing-spinner" aria-hidden="true" /> : <StatusIcon status={selectedRepo.status} />}<div><h2>{selectedRepo.status === 'indexing' ? 'Indexing repository' : 'Waiting to index'}</h2><p>{selectedRepo.status === 'indexing' ? 'Indexing can take up to a minute for larger repositories.' : 'RepoMentor is preparing the repository code. You can ask questions when indexing is ready.'}</p></div></section>}

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
                  {streamingMessage?.repoId === selectedRepo._id && <AnswerCard message={streamingMessage.message} onSelectSource={openSource} selectedSource={selectedSource} isStreaming />}
                  {askBusy && !streamingMessage && <div className="answer-skeleton" role="status" aria-live="polite"><span>Finding an answer in your code</span><i /><i /><i /></div>}
                </div>
                {messages.length === 0 && <div className="suggested-questions" aria-label="Suggested questions"><p>Try a question</p>{SUGGESTED_QUESTIONS.map(question => <button type="button" key={question} onClick={() => setAskQuestion(question)}>{question}</button>)}</div>}
                {askError && <p className="inline-error" role="alert">{askError}</p>}
                <form className="question-form" onSubmit={askRepository}>
                  <label className="visually-hidden" htmlFor="question-input">Your question</label>
                  <textarea id="question-input" rows="2" maxLength={500} minLength={3} value={askQuestion} onChange={event => setAskQuestion(event.target.value)} placeholder="Ask about the code…" required />
                  {askBusy && <button className="button button-secondary question-submit" type="button" onClick={stopAsking}>Stop</button>}
                  <button className="button button-primary question-submit" type="submit" disabled={askQuestion.trim().length < 3}>{askBusy ? 'Ask new question' : 'Ask'}</button>
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
                  <button className="match-location" type="button" onClick={() => openSource({ ...result, n: index + 1 })}>{result.filePath}:{result.startLine}-{result.endLine}{result.symbol && <span className="source-symbol"> · {result.symbol}</span>}</button>
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
