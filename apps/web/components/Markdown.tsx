'use client';
import { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check, RefreshCw, Download } from 'lucide-react';

/** Imagem gerada: mostra carregamento e permite tentar de novo (o serviço gratuito pode estar ocupado). */
function GenImage({ src, alt }: { src?: string; alt?: string }) {
  const [state, setState] = useState<'loading' | 'ok' | 'err'>('loading');
  const [n, setN] = useState(0);
  if (!src) return null;
  const url = n ? `${src}${src.includes('?') ? '&' : '?'}retry=${n}` : src;
  return (
    <span className="block my-2 max-w-[520px]">
      <span className="relative block rounded-xl overflow-hidden border border-line bg-white/[0.03] aspect-square">
        {state !== 'ok' && <span className={`absolute inset-0 grid place-items-center text-[12.5px] text-muted ${state === 'loading' ? 'shimmer' : ''}`}>{state === 'loading' ? 'Gerando imagem…' : 'O gerador gratuito está ocupado.'}</span>}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img key={url} src={url} alt={alt ?? 'imagem gerada'} onLoad={() => setState('ok')} onError={() => setState('err')} className={`w-full h-full object-cover transition-opacity duration-500 ${state === 'ok' ? 'opacity-100' : 'opacity-0'}`} />
      </span>
      <span className="mt-1.5 flex gap-3 text-[11.5px] text-dim">
        {state === 'err' && <button className="flex items-center gap-1 hover:text-fg" onClick={() => { setState('loading'); setN((x) => x + 1); }}><RefreshCw className="size-3" />Tentar de novo</button>}
        {state === 'ok' && <a className="flex items-center gap-1 hover:text-fg" href={url} target="_blank" rel="noopener noreferrer" download><Download className="size-3" />Abrir em tamanho original</a>}
      </span>
    </span>
  );
}

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
          img: ({ src, alt }) => <GenImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
          p: ({ children }) => <div className="my-[0.45em]">{children}</div>,
        }}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
