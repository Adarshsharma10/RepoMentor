import ReactMarkdown from 'react-markdown';
import { Highlight, themes } from 'prism-react-renderer';

const LANGUAGE_ALIASES = {
  javascript: 'jsx', typescript: 'tsx', shell: 'bash', csharp: 'csharp', cpp: 'cpp',
  fsharp: 'fsharp', markdown: 'markdown', dockerfile: 'docker', protobuf: 'protobuf',
  hcl: 'hcl', vue: 'markup', astro: 'jsx', text: 'plaintext'
};

function prismLanguage(language = '') {
  const normalized = language.toLowerCase();
  return LANGUAGE_ALIASES[normalized] || normalized || 'plaintext';
}

export function PrismCode({ code, language, startLine = 1, lineNumbers = false }) {
  return <Highlight theme={themes.vsDark} code={code} language={prismLanguage(language)}>
    {({ className, style, tokens, getLineProps, getTokenProps }) => <pre className={`prism-code ${className}`} style={{ ...style, background: 'transparent' }}>
      <code>{tokens.map((line, lineIndex) => {
        const lineProps = getLineProps({ line });
        return <span className={`prism-line ${lineProps.className || ''}`} style={lineProps.style} key={lineIndex}>
          {lineNumbers && <span className="line-number" aria-hidden="true">{startLine + lineIndex}</span>}
          <span className="line-content">{line.map((token, tokenIndex) => <span key={tokenIndex} {...getTokenProps({ token })} />)}</span>
        </span>;
      })}</code>
    </pre>}
  </Highlight>;
}

function remarkCitationLinks(options) {
  const availableSources = new Set(options.numbers);
  return tree => {
    function visit(node) {
      if (!Array.isArray(node.children) || ['link', 'linkReference', 'code', 'inlineCode'].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text') {
          visit(child);
          return [child];
        }
        const nextNodes = [];
        const pattern = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
        let previousEnd = 0;
        let match;
        while ((match = pattern.exec(child.value)) !== null) {
          const numbers = match[1].split(',').map(value => Number(value.trim())).filter(number => availableSources.has(number));
          if (numbers.length === 0) continue;
          if (match.index > previousEnd) nextNodes.push({ type: 'text', value: child.value.slice(previousEnd, match.index) });
          numbers.forEach((number, index) => {
            if (index > 0) nextNodes.push({ type: 'text', value: ' ' });
            nextNodes.push({ type: 'link', url: `#citation-${number}`, children: [{ type: 'text', value: `[${number}]` }] });
          });
          previousEnd = pattern.lastIndex;
        }
        if (previousEnd === 0) return [child];
        if (previousEnd < child.value.length) nextNodes.push({ type: 'text', value: child.value.slice(previousEnd) });
        return nextNodes;
      });
    }
    visit(tree);
  };
}

export default function MarkdownAnswer({ answer, sources, onSelectSource, selectedSourceNumber }) {
  return <div className="markdown-answer">
    <ReactMarkdown components={{
      a({ href = '', children }) {
        const citationMatch = href.match(/^#citation-(\d+)$/);
        if (citationMatch) {
          const number = Number(citationMatch[1]);
          const source = sources.find(item => item.n === number);
          return <button className={`citation-chip${selectedSourceNumber === number ? ' selected' : ''}`} type="button" onClick={() => source && onSelectSource(source)} aria-label={`Open source ${number}`} aria-pressed={selectedSourceNumber === number}>{children}</button>;
        }
        return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
      },
      code({ className, children }) {
        const match = /language-([\w-]+)/.exec(className || '');
        const code = String(children).replace(/\n$/, '');
        if (!match) return <code className="inline-code">{children}</code>;
        return <PrismCode code={code} language={match[1]} />;
      }
    }} remarkPlugins={[[remarkCitationLinks, { numbers: sources.map(source => source.n) }]]}>{answer}</ReactMarkdown>
  </div>;
}
