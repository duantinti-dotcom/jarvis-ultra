'use client';
import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check } from 'lucide-react';

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const [ok, setOk] = useState(false);
  const lang = /language-(\w+)/.exec(className ?? '')?.[1];
  const text = String(children ?? '').replace(/\n$/, '');
  return (
    <div className="relative group">
      <div className="absolute right-2 top-2 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition">
        {lang && <span className="label-tech">{lang}</span>}
        <button aria-label="Copiar código" className="rounded-md p-1 bg-white/10 hover:bg-white/20" onClick={() => { void navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1200); }}>
          {ok ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <pre><code className={className}>{text}</code></pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-jarvis">
      <ReactMarkdown remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => (/language-|\n/.test(String(children)) || className ? <CodeBlock className={className}>{children}</CodeBlock> : <code>{children}</code>),
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
        }}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
