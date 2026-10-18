import { useEffect, useRef, useState } from 'react';
import { PrismCode } from './MarkdownAnswer.jsx';

export default function CodeViewer({ source, mobileOpen = false, onClose }) {
  const [copyMessage, setCopyMessage] = useState('');
  const [wrapLines, setWrapLines] = useState(false);
  const viewerRef = useRef(null);

  useEffect(() => {
    if (mobileOpen) viewerRef.current?.focus();
  }, [mobileOpen]);

  useEffect(() => {
    setCopyMessage('');
  }, [source?.filePath, source?.startLine, source?.endLine]);

  async function copyCode() {
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source.code);
      setCopyMessage('Code copied.');
    } catch {
      setCopyMessage('Copy is unavailable in this browser.');
    }
  }

  return <>
    {mobileOpen && <button type="button" className="sheet-backdrop" aria-label="Close code viewer" onClick={onClose} />}
    <aside ref={viewerRef} className={`code-viewer${mobileOpen ? ' code-viewer-sheet' : ''}`} aria-label="Code viewer" role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen ? 'true' : undefined} aria-labelledby="code-viewer-title" tabIndex={mobileOpen ? -1 : undefined} onKeyDown={event => { if (event.key === 'Escape' && mobileOpen) onClose(); }}>
      <div className="code-viewer-header">
        <div className="code-file-info">
          <span className="code-file-path" id="code-viewer-title">{source ? <>{source.filePath}{source.symbol && <span className="code-symbol"> · {source.symbol}</span>}</> : 'Source viewer'}</span>
          {source && <span className="code-line-range">Lines {source.startLine}–{source.endLine}</span>}
        </div>
        <div className="code-viewer-actions">
          {source && <label className="wrap-toggle"><input type="checkbox" checked={wrapLines} onChange={event => setWrapLines(event.target.checked)} />Wrap lines</label>}
          {source && <button className="button button-code" type="button" onClick={copyCode}>Copy code</button>}
          {mobileOpen && <button className="button button-code close-viewer" type="button" onClick={onClose}>Close</button>}
        </div>
      </div>
      {copyMessage && <p className="copy-message" role="status">{copyMessage}</p>}
      {source ? <div className={`code-scroll${wrapLines ? ' wrap-lines' : ''}`}><PrismCode code={source.code} language={source.language} startLine={source.startLine} lineNumbers /></div> : <div className="code-empty">Select a citation to view its source code.</div>}
    </aside>
  </>;
}
