'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { ArrowUp, Square, Download, Plus, ExternalLink, Monitor, Tablet, Smartphone, RefreshCw, FileCode2, FilePlus2, FileX2, FilePen, Eye, Code2, Trash2, ChevronDown, AlertTriangle, Wand2, Loader2, Sparkles, X, HardDriveDownload } from 'lucide-react';
import { useJarvis } from '@/lib/store';
import { Markdown } from '@/components/Markdown';
import { cx } from '@/components/ui';
import { parseSegments, applySegments, buildPreview, makeZip, LOCAL_CODE_PROMPT, continuePrompt, type Segment } from '@/lib/studio';
import type { CoreEvent } from '@/lib/types';

if (typeof window !== 'undefined') loader.config({ paths: { vs: `${location.origin}/monaco/vs` } });

type Change = { name: string; kind: 'create' | 'update' | 'delete'; lines: number };
type Msg = { id: string; role: 'user' | 'assistant'; content: string; auto?: boolean; changes?: Change[]; incomplete?: string[]; error?: string; ms?: number; streaming?: boolean };
type Project = { id: string; name: string; files: Record<string, string>; partials?: Record<string, string>; messages: Msg[]; conversationId: string | null; updatedAt: number };

const KEY = 'jarvis.studio.v1';
const uid = () => (crypto.randomUUID?.() ?? String(Date.now() + Math.random()));
const load = (): { projects: Project[]; current: string | null } => { try { return JSON.parse(localStorage.getItem(KEY) ?? '') as { projects: Project[]; current: string | null }; } catch { return { projects: [], current: null }; } };
const LANG: Record<string, string> = { html: 'html', css: 'css', js: 'javascript', mjs: 'javascript', ts: 'typescript', json: 'json', md: 'markdown', svg: 'xml', txt: 'plaintext' };
const langOf = (n: string) => LANG[n.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext';
const IDEAS = [
  { t: 'Landing page de startup', p: 'Crie uma landing page moderna para uma startup de IA chamada Nimbus: hero com gradiente animado, seção de recursos, depoimentos, planos de preço com toggle mensal/anual, FAQ em acordeão e rodapé. Tema escuro elegante.' },
  { t: 'Portfólio pessoal', p: 'Crie um portfólio de desenvolvedor com hero animado, sobre mim, grade de projetos com filtro por categoria, linha do tempo de experiência e formulário de contato com validação.' },
  { t: 'Cafeteria com cardápio', p: 'Crie o site de uma cafeteria artesanal: hero com foto, cardápio com abas por categoria, carrinho lateral funcional com total, horários e mapa estilizado. Paleta quente.' },
  { t: 'Dashboard financeiro', p: 'Crie um dashboard financeiro com sidebar, cards de KPIs, gráfico de linhas e barras em canvas puro (sem bibliotecas), tabela de transações com busca e ordenação, e modo claro/escuro.' },
  { t: 'Jogo da memória', p: 'Crie um jogo da memória com cartas que viram em 3D, contador de jogadas, cronômetro, níveis de dificuldade, recorde salvo no localStorage e animação de vitória.' },
  { t: 'Lista de tarefas', p: 'Crie um app de tarefas estilo kanban (A fazer / Fazendo / Feito) com arrastar e soltar, edição inline, prioridades com cores e salvamento automático no localStorage.' },
];

export function StudioView() {
  const { api, notify } = useJarvis();
  const [state, setState] = useState<{ projects: Project[]; current: string | null }>({ projects: [], current: null });
  const [ready, setReady] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<{ id: string; started: number; msgId: string | null } | null>(null);
  const [tab, setTab] = useState<'preview' | 'code'>('preview');
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [page, setPage] = useState('index.html');
  const [reloadKey, setReloadKey] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [menu, setMenu] = useState(false);
  const [now, setNow] = useState(Date.now());
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { const s = load(); setState(s.projects?.length ? s : { projects: [], current: null }); setReady(true); }, []);
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { notify('warn', 'Sem espaço para salvar o projeto neste navegador. Baixe o .zip.'); } }, 400);
    return () => clearTimeout(t);
  }, [state, ready, notify]);

  const project = state.projects.find((p) => p.id === state.current) ?? null;
  const files = project?.files ?? {};
  const fileNames = Object.keys(files).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  const update = useCallback((id: string, fn: (p: Project) => Project) => setState((s) => ({ ...s, projects: s.projects.map((p) => (p.id === id ? { ...fn(p), updatedAt: Date.now() } : p)) })), []);

  const newProject = () => { setState((s) => { const p: Project = { id: uid(), name: 'Novo projeto', files: {}, messages: [], conversationId: null, updatedAt: Date.now() }; return { projects: [p, ...s.projects], current: p.id }; }); setOpenFile(null); setPage('index.html'); setErrors([]); setMenu(false); setTimeout(() => taRef.current?.focus(), 50); };

  // tempo decorrido (como o Claude Code)
  useEffect(() => { if (!busy) return; const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, [busy]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [project?.messages.length, busy?.msgId]);

  // ---------------------------------------------------------------- enviar ao agente
  const send = async (raw?: string, auto = 0, pidArg?: string) => {
    const t = (raw ?? text).trim();
    if (!t || (busy && !auto)) return;
    let p = pidArg ? stateRef.current.projects.find((x) => x.id === pidArg) ?? null : project;
    if (!p) {
      p = { id: uid(), name: t.replace(/\s+/g, ' ').slice(0, 40), files: {}, messages: [], conversationId: null, updatedAt: Date.now() };
      const np = p;
      setState((s) => ({ projects: [np, ...s.projects], current: np.id }));
    } else if (!p.messages.length) {
      const name = t.replace(/\s+/g, ' ').slice(0, 40);
      update(p.id, (x) => ({ ...x, name }));
    }
    const pid = p.id;
    const userMsg: Msg = { id: uid(), role: 'user', content: t, auto: auto > 0 };
    const aid = uid();
    update(pid, (x) => ({ ...x, messages: [...x.messages, userMsg, { id: aid, role: 'assistant', content: '', streaming: true }] }));
    setText('');
    setErrors([]);
    const started = Date.now();
    setBusy({ id: pid, started, msgId: null });

    let realId: string | null = null;
    let full = '';
    const early: CoreEvent[] = [];
    let finished = false;
    let cancelled = false;
    let next: { name: string; partial: string } | null = null;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => { resolveDone = r; });
    const handle = (e: CoreEvent) => {
      if (!('messageId' in e) || e.messageId !== realId) return;
      if (e.type === 'chat.delta') {
        full += e.text;
        update(pid, (x) => ({ ...x, messages: x.messages.map((m) => (m.id === aid ? { ...m, content: full } : m)) }));
      } else if (e.type === 'chat.done' || e.type === 'chat.error') {
        finished = true;
        const err = e.type === 'chat.error' ? e.error : undefined;
        cancelled = e.type === 'chat.done' && e.metrics?.model === 'interrompido';
        const cur = stateRef.current.projects.find((x) => x.id === pid);
        const r = applySegments(cur?.files ?? {}, parseSegments(full), cur?.partials);
        const first = r.incomplete[0];
        next = first && !err ? { name: first, partial: r.partials[first]! } : null;
        update(pid, (x) => {
          return { ...x, files: r.files, partials: r.partials, messages: x.messages.map((m) => (m.id === aid ? { ...m, content: full, streaming: false, changes: r.changes, incomplete: r.incomplete, error: err, ms: Date.now() - started } : m)) };
        });
        resolveDone();
      }
    };
    const unsub = api.subscribe((e) => { if (realId) handle(e); else early.push(e); });
    try {
      const fileMap = p.files;
      const r = api.cloud
        ? await api.chat(t, p.conversationId, { mode: 'balanced', code: { files: fileMap } })
        : await api.chat(`${LOCAL_CODE_PROMPT}\n\n${Object.keys(fileMap).length ? `Arquivos atuais:\n${Object.entries(fileMap).map(([n, c]) => `\`\`\`${n.split('.').pop()} ${n}\n${c}\n\`\`\``).join('\n\n')}\n\n` : ''}Pedido: ${t}`, p.conversationId, { mode: 'balanced' });
      realId = r.messageId;
      setBusy({ id: pid, started, msgId: r.messageId });
      update(pid, (x) => ({ ...x, conversationId: r.conversationId }));
      for (const e of early.splice(0)) handle(e);
      if (!finished) await done;
    } catch (e) {
      update(pid, (x) => ({ ...x, messages: x.messages.map((m) => (m.id === aid ? { ...m, streaming: false, error: (e as Error).message } : m)) }));
    } finally {
      unsub();
      if (!next || cancelled || auto >= 5) setBusy(null);
    }
    // O provedor cortou um arquivo: continua sozinho de onde parou (até 5 vezes).
    await new Promise((r) => setTimeout(r, 60));
    const cont = next as { name: string; partial: string } | null;
    if (cont && !cancelled && auto < 5) await send(continuePrompt(cont.name, cont.partial), auto + 1, pid);
  };
  const stop = () => { if (busy?.msgId) void api.cancelMessage(busy.msgId); };

  // ---------------------------------------------------------------- arquivo sendo escrito agora
  const live = useMemo(() => {
    const last = project?.messages[project.messages.length - 1];
    if (!busy || !last?.streaming) return null;
    const segs = parseSegments(last.content);
    const f = [...segs].reverse().find((s): s is Extract<Segment, { kind: 'file' }> => s.kind === 'file' && !s.done);
    // preview evolui conforme cada arquivo termina
    const applied = applySegments(files, segs, project?.partials).files;
    return { writing: f ?? null, files: applied };
  }, [project, busy, files]);
  const viewFiles = live?.files ?? files;

  // segue o arquivo que está sendo escrito na aba Código
  useEffect(() => { if (live?.writing && tab === 'code') setOpenFile(live.writing.name); }, [live?.writing?.name, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- preview
  const doc = useMemo(() => (Object.keys(viewFiles).length ? buildPreview(viewFiles, page) : ''), [viewFiles, page, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [shownDoc, setShownDoc] = useState('');
  useEffect(() => { const t = setTimeout(() => setShownDoc(doc), busy ? 600 : 0); return () => clearTimeout(t); }, [doc, busy]);
  // App do PC: o preview é servido pelo core numa rota isolada (CSP própria), senão herdaria a CSP do app.
  const local = api.mode === 'local';
  const [localSrc, setLocalSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!local || !shownDoc) return;
    let alive = true;
    api.req<{ url: string }>('/api/studio/preview', { method: 'POST', json: { html: shownDoc } }).then((r) => { if (alive) setLocalSrc(`${api.coreUrl ?? ''}${r.url}`); }).catch(() => {});
    return () => { alive = false; };
  }, [local, shownDoc, api]);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const d = e.data as { __jarvis?: number; type?: string; msg?: string };
      if (!d?.__jarvis) return;
      if (d.type === 'error' && d.msg) setErrors((x) => (x.includes(d.msg!) ? x : [...x, d.msg!].slice(-8)));
      if (d.type === 'nav' && d.msg) { if (viewFiles[d.msg]) setPage(d.msg); else notify('warn', `A página ${d.msg} não existe no projeto.`); }
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [viewFiles, notify]);
  useEffect(() => setErrors([]), [shownDoc]);

  const download = () => {
    if (!project) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(makeZip(project.files));
    a.download = `${project.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'site'}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const openTab = async () => {
    const html = buildPreview(files, page);
    const url = local ? `${api.coreUrl ?? ''}${(await api.req<{ url: string }>('/api/studio/preview', { method: 'POST', json: { html } })).url}` : URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const w = window.open(url, '_blank');
    if (!w) notify('warn', 'Permita pop-ups para abrir em nova aba.');
  };
  const saveToPc = async () => {
    if (!project) return;
    const dir = prompt('Salvar em qual pasta do PC? (precisa estar entre as pastas liberadas)', 'C:\\Users\\Public\\Documents\\' + (project.name.replace(/[^\w\- ]+/g, '').trim() || 'site'));
    if (!dir) return;
    try {
      for (const [n, c] of Object.entries(project.files)) await api.req('/api/code/file', { method: 'PUT', json: { path: `${dir.replace(/[\\/]+$/, '')}/${n}`, content: c } });
      notify('ok', `Projeto salvo em ${dir}`);
    } catch (e) { notify('err', (e as Error).message); }
  };
  const removeProject = (id: string) => { if (!confirm('Apagar este projeto deste navegador?')) return; setState((s) => { const projects = s.projects.filter((p) => p.id !== id); return { projects, current: s.current === id ? projects[0]?.id ?? null : s.current }; }); };

  const width = device === 'mobile' ? 390 : device === 'tablet' ? 820 : null;
  const elapsed = busy ? Math.floor((now - busy.started) / 1000) : 0;
  const editing = openFile && openFile in viewFiles ? openFile : fileNames[0] ?? null;

  return (
    <div className="h-full grid grid-cols-[minmax(340px,440px)_minmax(0,1fr)] max-lg:grid-cols-1 max-lg:grid-rows-[minmax(0,1fr)_minmax(0,1fr)] view-enter">
      {/* ------------------------------------------------ agente */}
      <section className="flex flex-col min-h-0 border-r border-line">
        <header className="h-12 px-3 flex items-center gap-2 border-b border-line relative">
          <button onClick={() => setMenu((v) => !v)} className="press flex items-center gap-1.5 min-w-0 rounded-lg px-2 h-8 hover:bg-white/[0.05]">
            <Sparkles className="size-4 text-orange-glow shrink-0" />
            <span className="text-[13px] font-medium truncate">{project?.name ?? 'Jarvis Code'}</span>
            <ChevronDown className={cx('size-3.5 text-dim transition-transform', menu && 'rotate-180')} />
          </button>
          <button onClick={newProject} title="Novo projeto" className="press ml-auto grid place-items-center size-8 rounded-lg hover:bg-white/[0.06] text-muted hover:text-fg"><Plus className="size-4" /></button>
          {menu && (
            <div className="absolute left-3 top-11 z-30 w-[300px] surface-raised rounded-xl p-1.5 shadow-2xl enter">
              <button onClick={newProject} className="w-full flex items-center gap-2 px-2.5 h-9 rounded-lg text-[13px] hover:bg-white/[0.05]"><Plus className="size-4 text-orange-glow" />Novo projeto</button>
              <div className="my-1 border-t border-line" />
              <div className="max-h-72 overflow-y-auto scroll-thin">
                {!state.projects.length && <p className="px-2.5 py-2 text-[12px] text-dim">Nenhum projeto ainda.</p>}
                {state.projects.map((p) => (
                  <div key={p.id} className={cx('group flex items-center gap-2 px-2.5 h-9 rounded-lg text-[12.5px] hover:bg-white/[0.05] cursor-pointer', p.id === state.current && 'bg-orange/[0.09]')} onClick={() => { setState((s) => ({ ...s, current: p.id })); setMenu(false); setOpenFile(null); setPage('index.html'); }}>
                    <FileCode2 className="size-3.5 text-dim shrink-0" /><span className="truncate">{p.name}</span>
                    <span className="ml-auto text-[10.5px] text-dim">{Object.keys(p.files).length} arq.</span>
                    <button aria-label="Apagar projeto" onClick={(e) => { e.stopPropagation(); removeProject(p.id); }} className="opacity-0 group-hover:opacity-100 text-dim hover:text-err"><Trash2 className="size-3.5" /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-4 py-4 space-y-5">
          {!project?.messages.length ? (
            <div className="enter pt-4">
              <div className="size-11 rounded-2xl grid place-items-center bg-gradient-to-br from-orange to-amber text-black shadow-[0_0_30px_rgba(255,109,10,.35)]"><Code2 className="size-5" /></div>
              <h2 className="mt-4 font-display text-[22px] leading-tight">O que vamos construir?</h2>
              <p className="mt-1.5 text-[13px] text-muted">Descreva o site ou app. O Jarvis escreve todos os arquivos, você vê o resultado ao vivo e pede ajustes até ficar perfeito.</p>
              <div className="mt-5 grid gap-2">
                {IDEAS.map((i, n) => (
                  <button key={i.t} onClick={() => void send(i.p)} style={{ animationDelay: `${n * 45}ms` }} className="enter lift text-left rounded-xl border border-line bg-white/[0.02] hover:bg-white/[0.045] hover:border-orange/30 px-3.5 py-2.5">
                    <div className="text-[13px] font-medium">{i.t}</div>
                    <div className="text-[11.5px] text-dim line-clamp-1">{i.p}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : project.messages.map((m) => <AgentMessage key={m.id} m={m} onOpen={(n) => { setTab('code'); setOpenFile(n); }} elapsed={m.streaming ? elapsed : undefined} busy={!!busy} last={m.id === project.messages[project.messages.length - 1]?.id} />)}
          {errors.length > 0 && !busy && (
            <div className="enter rounded-xl border border-err/30 bg-err/[0.06] p-3 text-[12.5px]">
              <div className="flex items-center gap-2 text-err font-medium"><AlertTriangle className="size-4" />{errors.length} erro(s) no preview</div>
              <ul className="mt-1.5 space-y-0.5 font-mono text-[11px] text-fg/80">{errors.slice(0, 4).map((e) => <li key={e} className="truncate">{e}</li>)}</ul>
              <button onClick={() => void send(`O preview mostrou estes erros no console. Encontre a causa e corrija:\n${errors.map((e) => `- ${e}`).join('\n')}`)} className="press mt-2.5 flex items-center gap-1.5 rounded-lg bg-err/15 hover:bg-err/25 px-2.5 h-8 text-[12px] text-fg"><Wand2 className="size-3.5" />Pedir para o Jarvis corrigir</button>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="p-3 border-t border-line">
          <div className={cx('surface rounded-2xl transition-shadow focus-within:shadow-[0_0_0_1px_rgba(255,140,40,.35),0_0_24px_rgba(255,109,10,.12)]')}>
            <textarea ref={taRef} value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Pedido ao Jarvis Code"
              placeholder={project?.messages.length ? 'Peça uma alteração… (ex.: deixe o hero mais impactante e adicione modo claro)' : 'Descreva o site que você quer…'}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } if (e.key === 'Escape' && busy) stop(); }}
              className="w-full bg-transparent resize-none outline-none text-[13.5px] px-3.5 pt-3 placeholder:text-dim" />
            <div className="flex items-center gap-2 px-2.5 pb-2.5">
              <span className="text-[11px] text-dim">{api.cloud ? 'IA na nuvem' : 'Modelo local do PC'} · Enter envia</span>
              {busy ? (
                <button aria-label="Parar" onClick={stop} className="press ml-auto grid place-items-center size-8 rounded-xl bg-white/10 hover:bg-white/15"><Square className="size-3 fill-current" /></button>
              ) : (
                <button aria-label="Enviar" onClick={() => void send()} disabled={!text.trim()} className="press ml-auto grid place-items-center size-8 rounded-xl bg-gradient-to-b from-orange to-[#e85d00] text-black disabled:opacity-30 transition-opacity"><ArrowUp className="size-4" /></button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ preview / código */}
      <section className="flex flex-col min-h-0 min-w-0 bg-[#0a0b0d]">
        <header className="h-12 px-3 flex items-center gap-1.5 border-b border-line">
          <div className="flex items-center rounded-lg bg-white/[0.04] p-0.5">
            {([['preview', 'Preview', Eye], ['code', 'Código', Code2]] as const).map(([id, label, I]) => (
              <button key={id} onClick={() => setTab(id)} className={cx('press flex items-center gap-1.5 px-3 h-7 rounded-md text-[12px] transition-colors', tab === id ? 'bg-white/[0.09] text-fg shadow-sm' : 'text-dim hover:text-muted')}><I className="size-3.5" />{label}</button>
            ))}
          </div>
          {tab === 'preview' && (
            <>
              <div className="ml-2 flex items-center gap-0.5">
                {([['desktop', Monitor], ['tablet', Tablet], ['mobile', Smartphone]] as const).map(([id, I]) => (
                  <button key={id} aria-label={id} onClick={() => setDevice(id)} className={cx('press grid place-items-center size-7 rounded-md', device === id ? 'text-orange-glow bg-orange/10' : 'text-dim hover:text-muted')}><I className="size-3.5" /></button>
                ))}
              </div>
              {fileNames.filter((n) => n.endsWith('.html')).length > 1 && (
                <select value={page} onChange={(e) => setPage(e.target.value)} className="ml-1 h-7 rounded-md bg-white/[0.04] border border-line text-[11.5px] px-1.5 outline-none">
                  {fileNames.filter((n) => n.endsWith('.html')).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              )}
              <button aria-label="Recarregar" onClick={() => setReloadKey((k) => k + 1)} className="press grid place-items-center size-7 rounded-md text-dim hover:text-muted"><RefreshCw className="size-3.5" /></button>
            </>
          )}
          <div className="ml-auto flex items-center gap-1">
            {!!fileNames.length && <button onClick={openTab} className="press flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[12px] text-muted hover:text-fg hover:bg-white/[0.05]"><ExternalLink className="size-3.5" /><span className="max-sm:hidden">Abrir</span></button>}
            {!!fileNames.length && api.mode === 'local' && <button onClick={saveToPc} className="press flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[12px] text-muted hover:text-fg hover:bg-white/[0.05]"><HardDriveDownload className="size-3.5" /><span className="max-sm:hidden">Salvar no PC</span></button>}
            {!!fileNames.length && <button onClick={download} className="press flex items-center gap-1.5 px-3 h-8 rounded-lg text-[12px] font-medium bg-gradient-to-b from-orange to-[#e85d00] text-black hover:brightness-110"><Download className="size-3.5" />Baixar .zip</button>}
          </div>
        </header>

        <div className="flex-1 min-h-0 relative">
          {!fileNames.length && !live?.writing ? (
            <div className="h-full grid place-items-center p-8 text-center">
              <div className="enter max-w-sm">
                <div className="mx-auto size-14 rounded-2xl border border-line grid place-items-center bg-white/[0.02]"><Monitor className="size-6 text-dim" /></div>
                <p className="mt-4 text-[13.5px] text-muted">{busy ? 'O Jarvis está planejando o projeto…' : 'O preview do seu site aparece aqui, ao vivo, enquanto o Jarvis escreve.'}</p>
                {busy && <div className="mt-4 h-1 rounded-full overflow-hidden bg-white/[0.05]"><div className="h-full w-1/3 bg-gradient-to-r from-transparent via-orange to-transparent animate-scan" /></div>}
              </div>
            </div>
          ) : tab === 'preview' ? (
            <div className="h-full overflow-auto scroll-thin flex justify-center" style={{ padding: width ? 16 : 0 }}>
              <div className={cx('relative shrink-0 bg-white transition-[width] duration-300 ease-out', width ? 'rounded-2xl overflow-hidden border border-line shadow-2xl' : '')} style={{ width: width ? Math.min(width, 9999) : '100%', maxWidth: '100%', height: '100%' }}>
                <iframe key={reloadKey} title="Preview do site" {...(local ? { src: localSrc ?? 'about:blank' } : { srcDoc: shownDoc })} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock" className="absolute inset-0 w-full h-full border-0 bg-white" />
                {busy && <div className="absolute top-2 right-2 flex items-center gap-1.5 rounded-full bg-black/70 backdrop-blur px-2.5 py-1 text-[11px] text-white enter"><Loader2 className="size-3 animate-spin text-orange" />atualizando ao vivo</div>}
              </div>
            </div>
          ) : (
            <div className="h-full grid grid-cols-[180px_minmax(0,1fr)] max-sm:grid-cols-1">
              <aside className="border-r border-line overflow-y-auto scroll-thin py-1.5 max-sm:hidden">
                {[...new Set([...fileNames, ...(live?.writing ? [live.writing.name] : [])])].map((n) => (
                  <button key={n} onClick={() => setOpenFile(n)} className={cx('w-full flex items-center gap-2 h-7 px-3 text-[12px] text-left', editing === n || (live?.writing?.name === n && openFile === n) ? 'bg-orange/[0.1] text-fg' : 'text-muted hover:bg-white/[0.04]')}>
                    <FileCode2 className="size-3.5 shrink-0 text-dim" /><span className="truncate">{n}</span>
                    {live?.writing?.name === n && <Loader2 className="ml-auto size-3 animate-spin text-orange" />}
                  </button>
                ))}
              </aside>
              <div className="min-h-0">
                {(() => {
                  const name = live?.writing && openFile === live.writing.name ? live.writing.name : editing;
                  if (!name) return null;
                  const writingNow = live?.writing?.name === name;
                  const value = writingNow ? live!.writing!.content : viewFiles[name] ?? '';
                  return (
                    <Editor key={name} theme="jarvis-studio" path={`studio/${name}`} language={langOf(name)} value={value} beforeMount={defineTheme}
                      onChange={(v) => { if (!writingNow && project && !busy) update(project.id, (x) => ({ ...x, files: { ...x.files, [name]: v ?? '' } })); }}
                      options={{ readOnly: writingNow || !!busy, fontSize: 13, fontFamily: 'JetBrains Mono Variable, monospace', minimap: { enabled: false }, smoothScrolling: true, cursorSmoothCaretAnimation: 'on', padding: { top: 12 }, scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, wordWrap: 'on' }} />
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/** Mensagem no estilo Claude Code: texto fluido + cartões de cada arquivo escrito. */
function AgentMessage({ m, onOpen, elapsed, busy, last }: { m: Msg; onOpen: (name: string) => void; elapsed?: number; busy: boolean; last: boolean }) {
  const segs = useMemo(() => (m.role === 'assistant' ? parseSegments(m.content) : []), [m.content, m.role]);
  if (m.role === 'user' && m.auto) return <div className="enter flex items-center gap-2 text-[11.5px] text-dim"><RefreshCw className="size-3" />Continuando o arquivo que foi cortado…</div>;
  if (m.role === 'user') return <div className="enter ml-6 rounded-2xl rounded-br-md bg-white/[0.06] border border-line px-3.5 py-2.5 text-[13.5px] whitespace-pre-wrap break-words">{m.content}</div>;
  const changed = new Map((m.changes ?? []).map((c) => [c.name, c]));
  return (
    <div className="enter space-y-2.5">
      {segs.map((s, i) => {
        if (s.kind === 'text') return <div key={i} className="text-[13.5px]"><Markdown text={s.text} streaming={m.streaming && i === segs.length - 1} /></div>;
        if (s.kind === 'delete') return <ToolCard key={i} icon={<FileX2 className="size-3.5 text-err" />} verb="Remover" name={s.name} detail="arquivo removido" done onClick={() => {}} />;
        const cont = s.name.endsWith('.continue');
        const name = cont ? s.name.slice(0, -'.continue'.length) : s.name;
        const c = changed.get(name);
        const lines = s.content.split('\n').length - (s.done ? 1 : 0);
        const writing = !s.done && !!m.streaming;
        return <ToolCard key={i} icon={c?.kind === 'update' || cont ? <FilePen className="size-3.5 text-amber" /> : <FilePlus2 className="size-3.5 text-ok" />} verb={cont ? 'Continuar' : c?.kind === 'update' ? 'Editar' : 'Criar'} name={name} detail={s.done ? `${lines} linhas` : writing ? `escrevendo… ${lines} linhas` : `${lines} linhas · continua abaixo`} done={!writing} onClick={() => onOpen(name)} />;
      })}
      {m.streaming && (
        <div className="flex items-center gap-2 text-[12px] text-muted" role="status">
          <span className="studio-star">✻</span>
          <span className="shimmer-text font-medium">{segs.some((s) => s.kind === 'file' && !s.done) ? 'Escrevendo código' : m.content ? 'Pensando' : 'Planejando'}…</span>
          <span className="text-dim tabular-nums">({elapsed ?? 0}s · Esc para interromper)</span>
        </div>
      )}
      {!m.streaming && !!m.changes?.length && <div className="text-[11.5px] text-dim">✓ {m.changes.length} arquivo(s) atualizados{m.ms ? ` em ${(m.ms / 1000).toFixed(1)} s` : ''}</div>}
      {!!m.incomplete?.length && !busy && last && <div className="rounded-lg border border-amber/30 bg-amber/[0.06] px-3 py-2 text-[12px] text-amber">A resposta foi cortada antes de terminar {m.incomplete.join(', ')}. Peça “continue e reenvie {m.incomplete[0]} completo”.</div>}
      {m.error && <div className="rounded-lg border border-err/30 bg-err/[0.07] px-3 py-2 text-[12.5px] text-err flex items-start gap-2"><X className="size-3.5 mt-0.5 shrink-0" />{m.error}</div>}
    </div>
  );
}

function ToolCard({ icon, verb, name, detail, done, onClick }: { icon: React.ReactNode; verb: string; name: string; detail: string; done: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="enter lift w-full flex items-center gap-2.5 rounded-xl border border-line bg-white/[0.025] hover:bg-white/[0.05] hover:border-orange/25 px-3 py-2 text-left">
      <span className={cx('size-1.5 rounded-full shrink-0', done ? 'bg-ok' : 'bg-orange animate-pulse')} />
      {icon}
      <span className="text-[12.5px]"><span className="font-medium">{verb}</span><span className="text-dim">(</span><span className="font-mono text-orange-soft">{name}</span><span className="text-dim">)</span></span>
      <span className="ml-auto text-[11px] text-dim tabular-nums flex items-center gap-1.5">{!done && <Loader2 className="size-3 animate-spin text-orange" />}{detail}</span>
    </button>
  );
}

function defineTheme(monaco: Parameters<NonNullable<React.ComponentProps<typeof Editor>['beforeMount']>>[0]) {
  monaco.editor.defineTheme('jarvis-studio', {
    base: 'vs-dark', inherit: true,
    rules: [{ token: 'comment', foreground: '6b7280', fontStyle: 'italic' }, { token: 'keyword', foreground: 'ff9a4a' }, { token: 'string', foreground: 'f6c177' }, { token: 'number', foreground: 'ffb35c' }, { token: 'tag', foreground: 'ff9a4a' }, { token: 'attribute.name', foreground: 'e8d4b0' }],
    colors: { 'editor.background': '#0a0b0d', 'editor.lineHighlightBackground': '#14161a', 'editorLineNumber.foreground': '#3d424b', 'editorLineNumber.activeForeground': '#ffb35c', 'editorCursor.foreground': '#ff8a2b', 'editor.selectionBackground': '#ff6d0a33', 'minimap.background': '#0a0b0d' },
  });
}
