'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor, loader } from '@monaco-editor/react';
import { Folder, FolderOpen, FileCode2, ChevronRight, Save, GitBranch, TerminalSquare, Bot, RotateCcw, X, Play, Loader2, Diff, Square, ArrowUp, GitCommit } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { useChat } from '@/lib/chat';
import { Markdown } from '@/components/Markdown';
import { Button, Select, Empty, cx, Badge } from '@/components/ui';

// Monaco servido localmente (public/monaco): funciona offline no app desktop.
if (typeof window !== 'undefined') loader.config({ paths: { vs: `${location.origin}/monaco/vs` }, 'vs/nls': { availableLanguages: { '*': 'pt-br' } } });

type Entry = { path: string; dir: boolean; size: number };
type Tab = { path: string; abs: string; content: string; saved: string; lang: string };
type Root = { id: string; path: string; access: string };

const LANG: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go', java: 'java', cs: 'csharp', css: 'css', scss: 'scss', html: 'html', yml: 'yaml', yaml: 'yaml', sql: 'sql', sh: 'shell', ps1: 'powershell', xml: 'xml', toml: 'ini', c: 'c', cpp: 'cpp', h: 'cpp', php: 'php', rb: 'ruby', kt: 'kotlin', swift: 'swift', vue: 'html', txt: 'plaintext' };
const langOf = (p: string) => LANG[p.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext';

export function CodeView() {
  const { api, notify } = useJarvis();
  const perms = useAsync(() => api.req<{ roots: Root[]; grants: Record<string, string[]> }>('/api/permissions'), [api]);
  const [root, setRoot] = useState<string>('');
  const [project, setProject] = useState<string>('');
  const tree = useAsync<{ root: string; git: boolean; entries: Entry[] } | null>(() => (project ? api.req(`/api/code/tree?root=${encodeURIComponent(project)}`) : Promise.resolve(null)), [api, project]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ original: string; modified: string; title: string } | null>(null);
  const [panel, setPanel] = useState<'terminal' | 'git' | 'agent'>('agent');
  const [backups, setBackups] = useState<Record<string, string>>({});

  useEffect(() => { if (!root && perms.data?.roots[0]) { setRoot(perms.data.roots[0].path); } }, [perms.data, root]);
  useEffect(() => { try { const p = localStorage.getItem('jarvis.code.project'); if (p) setProject(p); } catch {} }, []);
  const chooseProject = (p: string) => { setProject(p); setTabs([]); setActive(null); try { localStorage.setItem('jarvis.code.project', p); } catch {} };

  const tab = tabs.find((t) => t.path === active) ?? null;
  const dirty = tabs.filter((t) => t.content !== t.saved);

  const openFile = useCallback(async (rel: string) => {
    if (tabs.some((t) => t.path === rel)) return setActive(rel);
    try {
      const abs = `${project}/${rel}`;
      const r = await api.req<{ content: string; path: string }>(`/api/code/file?path=${encodeURIComponent(abs)}`);
      setTabs((ts) => [...ts, { path: rel, abs: r.path, content: r.content, saved: r.content, lang: langOf(rel) }]);
      setActive(rel);
      setDiff(null);
    } catch (e) { notify('err', (e as Error).message); }
  }, [api, project, tabs, notify]);

  const save = useCallback(async (t: Tab) => {
    try {
      const r = await api.req<{ backup: string | null }>('/api/code/file', { method: 'PUT', json: { path: t.abs, content: t.content } });
      setTabs((ts) => ts.map((x) => (x.path === t.path ? { ...x, saved: x.content } : x)));
      if (r.backup) setBackups((b) => ({ ...b, [t.path]: r.backup! }));
      notify('ok', `${t.path} salvo${r.backup ? ' (backup criado)' : ''}`);
    } catch (e) { notify('err', (e as Error).message); }
  }, [api, notify]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && tab) { e.preventDefault(); void save(tab); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [tab, save]);

  const restore = async (t: Tab) => {
    const b = backups[t.path];
    if (!b || !confirm(`Restaurar ${t.path} para a versão anterior ao último salvamento?`)) return;
    const r = await api.req<{ ok: boolean; error?: string }>('/api/code/restore', { method: 'POST', json: { backup: b, path: t.abs } });
    if (!r.ok) return notify('err', r.error ?? 'falha');
    const f = await api.req<{ content: string }>(`/api/code/file?path=${encodeURIComponent(t.abs)}`);
    setTabs((ts) => ts.map((x) => (x.path === t.path ? { ...x, content: f.content, saved: f.content } : x)));
    notify('ok', 'Alteração desfeita');
  };

  const showDiff = async (t: Tab) => {
    if (t.content !== t.saved) return setDiff({ original: t.saved, modified: t.content, title: `${t.path} · alterações não salvas` });
    if (tree.data?.git) {
      const r = await api.req<{ output: string }>(`/api/code/git?root=${encodeURIComponent(project)}&action=show&file=${encodeURIComponent(t.path)}`);
      return setDiff({ original: r.output, modified: t.content, title: `${t.path} · comparado ao último commit` });
    }
    notify('warn', 'Sem alterações para comparar.');
  };

  const entries = useMemo(() => (tree.data?.entries ?? []).filter((e) => {
    const parts = e.path.split('/');
    for (let i = 1; i < parts.length; i++) if (!open.has(parts.slice(0, i).join('/'))) return false;
    return true;
  }), [tree.data, open]);

  if (!perms.data) return <div className="p-6 text-muted text-sm">{perms.error ?? 'Carregando…'}</div>;
  if (!project) return <ProjectPicker roots={perms.data.roots} root={root} setRoot={setRoot} onPick={chooseProject} />;

  return (
    <div className="h-full grid grid-rows-[minmax(0,1fr)] grid-cols-[220px_minmax(0,1fr)_minmax(300px,380px)] max-xl:grid-cols-[200px_minmax(0,1fr)]">
      {/* Arquivos */}
      <aside className="border-r border-line flex flex-col min-h-0">
        <div className="px-3 h-10 flex items-center gap-2 border-b border-line">
          <FolderOpen className="size-4 text-accent-glow" />
          <span className="text-[12.5px] font-medium truncate" title={project}>{project.split(/[\\/]/).pop()}</span>
          <button className="ml-auto text-[11px] text-dim hover:text-fg" onClick={() => chooseProject('')}>trocar</button>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin py-1 text-[12.5px]">
          {tree.loading && <div className="p-3 text-dim">Carregando…</div>}
          {tree.error && <div className="p-3 text-err text-[12px]">{tree.error}</div>}
          {entries.map((e) => {
            const depth = e.path.split('/').length - 1;
            const name = e.path.split('/').pop();
            const isOpen = open.has(e.path);
            return (
              <button key={e.path} onClick={() => (e.dir ? setOpen((o) => { const n = new Set(o); if (n.has(e.path)) n.delete(e.path); else n.add(e.path); return n; }) : openFile(e.path))}
                className={cx('w-full flex items-center gap-1.5 h-7 pr-2 text-left hover:bg-white/[0.04]', active === e.path && 'bg-accent/[0.1] text-fg', !e.dir && 'text-muted')} style={{ paddingLeft: 8 + depth * 12 }}>
                {e.dir ? <ChevronRight className={cx('size-3 shrink-0 transition-transform', isOpen && 'rotate-90')} /> : <span className="w-3" />}
                {e.dir ? <Folder className="size-3.5 shrink-0 text-warn/80" /> : <FileCode2 className="size-3.5 shrink-0 text-dim" />}
                <span className="truncate">{name}</span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Editor */}
      <section className="flex flex-col min-h-0 min-w-0">
        <div className="h-10 flex items-center border-b border-line overflow-x-auto scroll-thin">
          {tabs.map((t) => (
            <div key={t.path} className={cx('group flex items-center gap-1.5 h-full px-3 border-r border-line text-[12px] cursor-pointer whitespace-nowrap', active === t.path ? 'bg-white/[0.04] text-fg' : 'text-dim hover:text-muted')} onClick={() => { setActive(t.path); setDiff(null); }}>
              {t.content !== t.saved && <span className="size-1.5 rounded-full bg-accent" aria-label="não salvo" />}
              {t.path.split('/').pop()}
              <button aria-label={`Fechar ${t.path}`} onClick={(e) => { e.stopPropagation(); if (t.content !== t.saved && !confirm('Descartar alterações não salvas?')) return; setTabs((ts) => ts.filter((x) => x.path !== t.path)); if (active === t.path) setActive(null); }} className="opacity-50 hover:opacity-100"><X className="size-3" /></button>
            </div>
          ))}
          {tab && (
            <div className="ml-auto flex items-center gap-1 px-2">
              <Button size="sm" variant="ghost" icon={<Diff className="size-3.5" />} onClick={() => (diff ? setDiff(null) : showDiff(tab))}>{diff ? 'Editor' : 'Diferenças'}</Button>
              {backups[tab.path] && <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => restore(tab)}>Desfazer</Button>}
              <Button size="sm" variant={tab.content !== tab.saved ? 'primary' : 'subtle'} icon={<Save className="size-3.5" />} disabled={tab.content === tab.saved} onClick={() => save(tab)}>Salvar</Button>
            </div>
          )}
        </div>
        <div className="flex-1 min-h-0">
          {diff ? (
            <DiffEditor theme="jarvis" original={diff.original} modified={diff.modified} language={tab?.lang} beforeMount={defineTheme} options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 13 }} />
          ) : tab ? (
            <Editor key={tab.path} theme="jarvis" path={tab.path} language={tab.lang} value={tab.content} beforeMount={defineTheme}
              onChange={(v) => setTabs((ts) => ts.map((x) => (x.path === tab.path ? { ...x, content: v ?? '' } : x)))}
              options={{ fontSize: 13, fontFamily: 'JetBrains Mono Variable, monospace', minimap: { enabled: true, scale: 1 }, smoothScrolling: true, cursorSmoothCaretAnimation: 'on', padding: { top: 12 }, scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, renderLineHighlight: 'all' }} />
          ) : <Empty icon={<FileCode2 className="size-8" />} title="Abra um arquivo">Escolha um arquivo à esquerda. Ctrl+S salva (com backup automático).</Empty>}
        </div>
        {diff && <div className="px-3 py-1.5 text-[11.5px] text-dim border-t border-line">{diff.title}</div>}
        {dirty.length > 0 && <div className="px-3 py-1.5 text-[11.5px] text-warn border-t border-line">{dirty.length} arquivo(s) com alterações não salvas</div>}
      </section>

      {/* Painel lateral: agente / terminal / git */}
      <aside className="border-l border-line flex flex-col min-h-0 max-xl:hidden">
        <div className="h-10 flex items-center gap-1 px-2 border-b border-line">
          {([['agent', 'Agente', Bot], ['terminal', 'Terminal', TerminalSquare], ['git', 'Git', GitBranch]] as const).map(([id, label, I]) => (
            <button key={id} onClick={() => setPanel(id)} className={cx('press flex items-center gap-1.5 px-2.5 h-7 rounded-md text-[12px]', panel === id ? 'bg-white/[0.07] text-fg' : 'text-dim hover:text-muted')}><I className="size-3.5" />{label}</button>
          ))}
        </div>
        <div className="flex-1 min-h-0">
          {panel === 'agent' && <AgentPanel project={project} activeFile={tab?.path ?? null} />}
          {panel === 'terminal' && <TerminalPanel cwd={project} enabled={!!perms.data.grants.local?.includes('terminal.exec')} />}
          {panel === 'git' && <GitPanel root={project} git={!!tree.data?.git} onChanged={() => tree.reload()} />}
        </div>
      </aside>
    </div>
  );
}

function defineTheme(monaco: Parameters<NonNullable<React.ComponentProps<typeof Editor>['beforeMount']>>[0]) {
  monaco.editor.defineTheme('jarvis', {
    base: 'vs-dark', inherit: true,
    rules: [{ token: 'comment', foreground: '6b7280', fontStyle: 'italic' }, { token: 'keyword', foreground: 'ff9a4a' }, { token: 'string', foreground: 'f6c177' }, { token: 'number', foreground: 'ffb35c' }, { token: 'type', foreground: 'e8d4b0' }],
    colors: { 'editor.background': '#0c0d10', 'editor.lineHighlightBackground': '#16181c', 'editorLineNumber.foreground': '#3d424b', 'editorLineNumber.activeForeground': '#6ee7b7', 'editorCursor.foreground': '#34d399', 'editor.selectionBackground': '#10b98133', 'editorIndentGuide.background1': '#1d2025', 'minimap.background': '#0c0d10', 'editorWidget.background': '#15171b', 'diffEditor.insertedTextBackground': '#35d49a22', 'diffEditor.removedTextBackground': '#ff5d6722' },
  });
}

function ProjectPicker({ roots, root, setRoot, onPick }: { roots: Root[]; root: string; setRoot: (r: string) => void; onPick: (p: string) => void }) {
  const { api } = useJarvis();
  const list = useAsync(() => (root ? api.req<{ data?: { entries: { name: string; path: string; type: string }[] } }>('/api/tools/invoke', { method: 'POST', json: { tool: 'fs.list', args: { path: root } } }) : Promise.resolve(null)), [api, root]);
  const dirs = (list.data?.data?.entries ?? []).filter((e) => e.type === 'dir');
  return (
    <div className="max-w-2xl mx-auto p-6">
      <h2 className="font-display text-xl">Abrir um projeto</h2>
      <p className="text-[13px] text-muted mt-1">Escolha uma pasta dentro das pastas liberadas. Para liberar outra, use Desktop Control → Permissões.</p>
      {!roots.length ? <Empty title="Nenhuma pasta liberada">Libere uma pasta de projetos para começar.</Empty> : (
        <>
          <div className="mt-4 flex items-center gap-2"><span className="text-[12px] text-dim">Pasta liberada</span><Select value={root} onChange={setRoot} options={roots.map((r) => ({ value: r.path, label: r.path }))} className="flex-1" /></div>
          <div className="mt-3 surface rounded-xl divide-y divide-[var(--color-line)]">
            <button onClick={() => onPick(root)} className="w-full flex items-center gap-2 px-4 h-11 text-left hover:bg-white/[0.03]"><FolderOpen className="size-4 text-accent-glow" /><span className="text-[13px]">Usar a própria pasta</span><span className="ml-auto text-[11px] text-dim truncate">{root}</span></button>
            {dirs.map((d) => <button key={d.path} onClick={() => onPick(d.path)} className="w-full flex items-center gap-2 px-4 h-11 text-left hover:bg-white/[0.03]"><Folder className="size-4 text-warn/80" /><span className="text-[13px]">{d.name}</span></button>)}
            {list.loading && <div className="px-4 py-3 text-[12px] text-dim">Carregando…</div>}
          </div>
        </>
      )}
    </div>
  );
}

function AgentPanel({ project, activeFile }: { project: string; activeFile: string | null }) {
  const chat = useChat();
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [chat.messages]);
  const send = async () => {
    if (!text.trim() || chat.busy) return;
    const ctx = `[Projeto: ${project}${activeFile ? ` · arquivo aberto: ${activeFile}` : ''}]\n`;
    const t = text;
    setText('');
    await chat.send(ctx + t);
  };
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-y-auto scroll-thin p-3 space-y-4 text-[13px]">
        {!chat.messages.length && <p className="text-[12.5px] text-dim">Peça à Lume para analisar o projeto, explicar um arquivo, corrigir um erro, criar uma função ou rodar os testes. Ele lê e edita apenas dentro das pastas liberadas e mostra cada ação.</p>}
        {chat.messages.map((m) => (
          <div key={m.id} className={cx(m.role === 'user' && 'rounded-xl bg-white/[0.05] px-3 py-2 whitespace-pre-wrap')}>
            {m.role === 'user' ? m.content.replace(/^\[Projeto:[^\]]*\]\n/, '') : (
              <>
                {m.tools?.map((t) => <div key={t.callId} className="text-[11px] font-mono text-dim">{t.running ? '…' : t.ok ? '✓' : '✗'} {t.tool} {t.summary ? `— ${t.summary.slice(0, 80)}` : ''}</div>)}
                <Markdown text={m.content} />
                {m.error && <div className="text-err">{m.error}</div>}
              </>
            )}
          </div>
        ))}
        {chat.busy && <div className="text-[12px] text-muted flex items-center gap-2"><Loader2 className="size-3.5 animate-spin text-accent" />{chat.stage.kind === 'tool' ? `Usando ${chat.stage.tool}` : 'Trabalhando'}</div>}
        <div ref={endRef} />
      </div>
      <div className="p-2 border-t border-line">
        <div className="surface rounded-xl flex items-end">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Ex.: encontre e corrija o erro no build" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} className="flex-1 bg-transparent resize-none outline-none text-[12.5px] p-2.5" aria-label="Pedido ao agente de código" />
          {chat.busy ? <button aria-label="Parar" onClick={chat.cancel} className="m-1.5 grid place-items-center size-8 rounded-lg bg-white/10"><Square className="size-3 fill-current" /></button>
            : <button aria-label="Enviar" onClick={send} className="m-1.5 grid place-items-center size-8 rounded-lg bg-accent text-black disabled:opacity-30" disabled={!text.trim()}><ArrowUp className="size-4" /></button>}
        </div>
      </div>
    </div>
  );
}

function TerminalPanel({ cwd, enabled }: { cwd: string; enabled: boolean }) {
  const { api } = useJarvis();
  const [cmd, setCmd] = useState('');
  const [lines, setLines] = useState<{ kind: string; text: string }[]>([]);
  const [running, setRunning] = useState(false);
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const ac = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [lines]);
  const exec = async () => {
    const c = cmd.trim();
    if (!c || running) return;
    setHist((h) => [c, ...h.filter((x) => x !== c)].slice(0, 50));
    setHi(-1);
    setCmd('');
    setRunning(true);
    setLines((l) => [...l, { kind: 'cmd', text: `› ${c}` }]);
    ac.current = new AbortController();
    try {
      const r = await fetch(`${api.coreUrl}/api/terminal/run`, { method: 'POST', signal: ac.current.signal, headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ command: c, cwd }) });
      if (!r.ok) throw new Error((await r.json()).error);
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const p of parts.filter(Boolean)) {
          const ev = JSON.parse(p);
          if (ev.type === 'stdout' || ev.type === 'stderr') setLines((l) => [...l.slice(-1500), { kind: ev.type, text: ev.text }]);
          if (ev.type === 'exit') setLines((l) => [...l, { kind: ev.code === 0 ? 'ok' : 'err', text: `processo terminou com código ${ev.code}${ev.timedOut ? ' (tempo esgotado)' : ''} em ${(ev.ms / 1000).toFixed(1)} s` }]);
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setLines((l) => [...l, { kind: 'err', text: (e as Error).message }]);
    } finally {
      setRunning(false);
    }
  };
  if (!enabled) return <div className="p-4 text-[12.5px] text-muted">O terminal está desligado. Libere em <a href="#/desktop" className="text-accent-soft underline">Desktop Control → Permissões → Terminal</a>. Comandos destrutivos (apagar em massa, git push, formatação…) sempre pedem confirmação.</div>;
  return (
    <div className="h-full flex flex-col bg-[#0a0b0d]">
      <div className="flex-1 overflow-y-auto scroll-thin p-3 font-mono text-[11.5px] leading-relaxed">
        <div className="text-dim">{cwd}</div>
        {lines.map((l, i) => <div key={i} className={cx('whitespace-pre-wrap break-all', l.kind === 'cmd' && 'text-accent-soft mt-1.5', l.kind === 'stderr' && 'text-[#ff9aa1]', l.kind === 'err' && 'text-err', l.kind === 'ok' && 'text-ok', l.kind === 'stdout' && 'text-fg/85')}>{l.text}</div>)}
        <div ref={end} />
      </div>
      <div className="flex items-center gap-2 border-t border-line px-2 h-11">
        <span className="font-mono text-accent-soft text-[12px]">›</span>
        <input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="npm test, git status, python main.py…" aria-label="Comando do terminal" className="flex-1 bg-transparent outline-none font-mono text-[12px]"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void exec();
            if (e.key === 'ArrowUp') { e.preventDefault(); const n = Math.min(hist.length - 1, hi + 1); setHi(n); if (hist[n]) setCmd(hist[n]!); }
            if (e.key === 'ArrowDown') { e.preventDefault(); const n = Math.max(-1, hi - 1); setHi(n); setCmd(n >= 0 ? hist[n]! : ''); }
          }} />
        {running ? <button aria-label="Interromper" onClick={() => ac.current?.abort()} className="text-err"><Square className="size-3.5 fill-current" /></button> : <button aria-label="Executar" onClick={exec}><Play className="size-4 text-accent-glow" /></button>}
      </div>
    </div>
  );
}

function GitPanel({ root, git, onChanged }: { root: string; git: boolean; onChanged: () => void }) {
  const { api, notify } = useJarvis();
  const status = useAsync(() => (git ? api.req<{ output: string }>(`/api/code/git?root=${encodeURIComponent(root)}&action=status`) : Promise.resolve({ output: '' })), [api, root, git]);
  const log = useAsync(() => (git ? api.req<{ output: string }>(`/api/code/git?root=${encodeURIComponent(root)}&action=log`) : Promise.resolve({ output: '' })), [api, root, git]);
  const [msg, setMsg] = useState('');
  const [diff, setDiff] = useState<string | null>(null);
  if (!git) return <div className="p-4 text-[12.5px] text-muted">Este projeto não usa Git. Inicialize com <code>git init</code> no terminal para ter histórico, diferenças e restauração.</div>;
  const lines = (status.data?.output ?? '').split('\n').filter(Boolean);
  const branch = lines[0]?.replace(/^## /, '');
  const files = lines.slice(1).map((l) => ({ st: l.slice(0, 2).trim(), file: l.slice(3) }));
  const act = async (body: Record<string, unknown>, ok: string) => {
    try { await api.req('/api/code/git', { method: 'POST', json: { root, ...body } }); notify('ok', ok); await status.reload(); await log.reload(); onChanged(); } catch (e) { notify('err', (e as Error).message); }
  };
  return (
    <div className="h-full overflow-y-auto scroll-thin p-3 space-y-3 text-[12.5px]">
      <div className="flex items-center gap-2"><GitBranch className="size-3.5 text-accent-glow" /><span className="font-mono">{branch}</span></div>
      <div>
        <div className="label-tech mb-1.5">Alterações ({files.length})</div>
        {!files.length && <p className="text-dim">Nada a commitar.</p>}
        {files.map((f) => (
          <div key={f.file} className="group flex items-center gap-2 h-7">
            <Badge tone={f.st.includes('D') ? 'err' : f.st.includes('?') ? 'ok' : 'warn'}>{f.st || 'M'}</Badge>
            <button className="truncate text-left hover:text-fg text-muted" onClick={async () => setDiff((await api.req<{ output: string }>(`/api/code/git?root=${encodeURIComponent(root)}&action=diff&file=${encodeURIComponent(f.file)}`)).output || '(arquivo novo, sem diff)')}>{f.file}</button>
            {!f.st.includes('?') && <button title="Descartar alterações deste arquivo" className="ml-auto opacity-0 group-hover:opacity-100 text-dim hover:text-err" onClick={() => confirm(`Descartar as alterações de ${f.file}? Isso não pode ser desfeito.`) && act({ action: 'restore', file: f.file }, 'Alterações descartadas')}><RotateCcw className="size-3.5" /></button>}
          </div>
        ))}
      </div>
      {diff && <pre className="max-h-64 overflow-auto scroll-thin rounded-lg bg-black/40 p-2 font-mono text-[11px]">{diff.split('\n').map((l, i) => <div key={i} className={l.startsWith('+') ? 'text-ok' : l.startsWith('-') ? 'text-err' : 'text-dim'}>{l}</div>)}</pre>}
      {files.length > 0 && (
        <div className="space-y-2">
          <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Mensagem do commit" className="w-full h-8 rounded-lg bg-black/30 border border-line px-2.5 outline-none focus:border-accent/50" />
          <Button size="sm" variant="primary" className="w-full" icon={<GitCommit className="size-3.5" />} disabled={!msg.trim()} onClick={() => act({ action: 'commit', message: msg }, 'Commit criado').then(() => setMsg(''))}>Commit de tudo</Button>
        </div>
      )}
      <div><div className="label-tech mb-1.5">Histórico</div><pre className="font-mono text-[11px] text-dim whitespace-pre-wrap">{log.data?.output}</pre></div>
    </div>
  );
}
