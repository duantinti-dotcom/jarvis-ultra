'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor, loader } from '@monaco-editor/react';
import {
  ArrowUp, Square, Download, Plus, ExternalLink, Monitor, Tablet, Smartphone, RefreshCw, FileCode2, FilePlus2, FileX2, FilePen, Eye, Code2, Trash2,
  ChevronDown, AlertTriangle, Wand2, Loader2, X, HardDriveDownload, Play, ShieldCheck, GitCompare, TerminalSquare, ImagePlus, Image as ImageIcon, Palette, RotateCcw, CheckCircle2,
} from 'lucide-react';
import { useJarvis } from '@/lib/store';
import { Markdown } from '@/components/Markdown';
import { ModeSelector } from '@/components/ModeSelector';
import { cx } from '@/components/ui';
import { parseSegments, applySegments, buildPreview, makeZip, applyImages, staticProblems, lostFunctions, locateLine, imageToAsset, type Segment, type Brief } from '@/lib/studio';
import { cloudBridge, hasCloudSession } from '@/lib/cloudBridge';
import { CloudLogin } from '@/components/CloudLogin';
import type { JarvisApi } from '@/lib/types';
import { useStudio, setStudio, updateProject, studioSend, studioStop, onStudioSaveError, setStudioMode, generateImage, uid, type Msg, type Project } from '@/lib/studioStore';

if (typeof window !== 'undefined') loader.config({ paths: { vs: `${location.origin}/monaco/vs` } });

const LANG: Record<string, string> = { html: 'html', css: 'css', js: 'javascript', mjs: 'javascript', ts: 'typescript', json: 'json', md: 'markdown', svg: 'xml', txt: 'plaintext' };
const langOf = (n: string) => LANG[n.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext';
const IDEAS = [
  { t: 'Loja de roupas', p: 'Crie um site sofisticado para uma marca de roupas femininas, com catálogo de produtos com filtros, página de produto, sacola e imagens coerentes.' },
  { t: 'Cardápio com painel', p: 'Crie um cardápio digital para uma pizzaria artesanal com categorias, carrinho e pedido pelo WhatsApp, e um painel admin que edita os itens de verdade.' },
  { t: 'Landing de produto', p: 'Crie a landing page de um app de finanças pessoais: hero com mockup, recursos, comparativo de planos com toggle mensal/anual, depoimentos e FAQ.' },
  { t: 'Portfólio de fotógrafo', p: 'Crie um portfólio editorial para uma fotógrafa de casamentos, com galeria em grade, lightbox, depoimentos e formulário de orçamento com validação.' },
  { t: 'Dashboard de vendas', p: 'Crie um dashboard de vendas com KPIs, gráficos em canvas sem bibliotecas, tabela com busca e ordenação, e filtros por período.' },
  { t: 'Ferramenta (não é site)', p: 'Crie um conversor de unidades com histórico salvo, testes automáticos das conversões rodando na página e uma interface simples.' },
];
type Tab = 'preview' | 'code' | 'changes' | 'problems' | 'console';
type Metrics = { width: number; overflow: number; wide: string[]; images: number; broken: string[]; h1: number; title: string };
type Check = { at: number; mobile?: Metrics; desktop?: Metrics; errors: string[] };

export function StudioView() {
  const { api, notify } = useJarvis();
  const state = useStudio();
  const busy = state.busy;
  const mode = state.mode ?? 'balanced';
  const [text, setText] = useState('');
  // Motor: no site é a própria nuvem; no app do PC usa a nuvem também (login da conta Lume).
  const [engine, setEngine] = useState<JarvisApi | 'login' | null>(api.cloud ? api : null);
  useEffect(() => {
    if (api.cloud) { setEngine(api); return; }
    void hasCloudSession().then((ok) => setEngine(ok ? cloudBridge() : 'login'));
  }, [api]);
  const ready = engine && engine !== 'login' ? engine : null;
  useEffect(() => {
    if (!ready || !state.pending || busy) return;
    const t = state.pending;
    setStudio((s) => ({ ...s, pending: null }));
    void studioSend(ready, t);
  }, [ready, state.pending, busy]);

  const [tab, setTab] = useState<Tab>('preview');
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [page, setPage] = useState('index.html');
  const [reloadKey, setReloadKey] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [check, setCheck] = useState<Check | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [menu, setMenu] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [diffSel, setDiffSel] = useState<{ msg: string; file: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const mobileRef = useRef<HTMLIFrameElement>(null);
  const pageRefs = useRef<Record<string, HTMLIFrameElement | null>>({});
  const deskRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => { onStudioSaveError(() => notify('warn', 'Sem espaço para salvar o projeto neste navegador. Baixe o .zip.')); }, [notify]);

  const project = state.projects.find((p) => p.id === state.current) ?? null;
  const files = project?.files ?? {};
  const images = project?.images ?? {};
  const fileNames = Object.keys(files).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  const imaging = state.imaging && state.imaging.pid === project?.id ? state.imaging : null;
  const setProjects = (fn: (s: { projects: Project[]; current: string | null }) => { projects: Project[]; current: string | null }) => setStudio((s) => ({ ...s, ...fn(s) }));

  const newProject = () => { setProjects((s) => { const p: Project = { id: uid(), name: 'Novo projeto', files: {}, messages: [], conversationId: null, updatedAt: Date.now() }; return { projects: [p, ...s.projects], current: p.id }; }); setOpenFile(null); setPage('index.html'); setErrors([]); setLogs([]); setCheck(null); setMenu(false); setTimeout(() => taRef.current?.focus(), 50); };

  useEffect(() => { if (!busy) return; const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, [busy]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [project?.messages.length, busy?.msgId]);

  // ---------------------------------------------------------------- enviar ao agente (roda fora da tela)
  const autoFix = useRef(0);
  const send = (raw?: string) => {
    const t = (raw ?? text).trim();
    if (!t || busy || !ready) return;
    autoFix.current = 0;
    setText('');
    setErrors([]);
    setCheck(null);
    void studioSend(ready, t);
  };
  const stop = () => { if (ready) studioStop(ready); };
  const last = project?.messages[project.messages.length - 1];
  const canResume = !busy && last?.role === 'assistant' && (last.cancelled || !!last.error || !!last.incomplete?.length);

  // ---------------------------------------------------------------- arquivo sendo escrito agora
  const live = useMemo(() => {
    const lm = project?.messages[project.messages.length - 1];
    if (!busy || !lm?.streaming) return null;
    const segs = parseSegments(lm.content);
    const f = [...segs].reverse().find((s): s is Extract<Segment, { kind: 'file' }> => s.kind === 'file' && !s.done);
    return { writing: f ?? null, files: applySegments(files, segs, project?.partials).files };
  }, [project, busy, files]);
  const viewFiles = live?.files ?? files;
  useEffect(() => { if (live?.writing && tab === 'code') setOpenFile(live.writing.name); }, [live?.writing?.name, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- preview (executa o projeto de verdade, isolado)
  const doc = useMemo(() => (Object.keys(viewFiles).length ? buildPreview(viewFiles, page, images) : ''), [viewFiles, page, images, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [shownDoc, setShownDoc] = useState('');
  useEffect(() => { const t = setTimeout(() => setShownDoc(doc), busy ? 600 : 0); return () => clearTimeout(t); }, [doc, busy]);
  const local = api.mode === 'local';
  const [localSrc, setLocalSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!local || !shownDoc) return;
    let alive = true;
    api.req<{ url: string }>('/api/studio/preview', { method: 'POST', json: { html: shownDoc } }).then((r) => { if (alive) setLocalSrc(`${api.coreUrl ?? ''}${r.url}`); }).catch(() => {});
    return () => { alive = false; };
  }, [local, shownDoc, api]);
  useEffect(() => { setErrors([]); setLogs([]); }, [shownDoc]);

  // mensagens do projeto em execução: erros, console, navegação, métricas e imagens pedidas em tempo de execução
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const d = e.data as { __jarvis?: number; type?: string; msg?: string; data?: Metrics };
      if (!d?.__jarvis) return;
      const other = Object.entries(pageRefs.current).find(([, f]) => f && e.source === f.contentWindow)?.[0];
      const fromCheck = e.source === mobileRef.current?.contentWindow ? 'mobile' : e.source === deskRef.current?.contentWindow ? 'desktop' : other ? 'page' : null;
      // depois de carregar, a verificação desktop (e as outras páginas) preenche e envia os formulários
      if (d.type === 'metrics' && fromCheck && fromCheck !== 'mobile') (e.source as Window | null)?.postMessage({ __lume: 'smoke' }, '*');
      if (d.type === 'metrics' && (fromCheck === 'mobile' || fromCheck === 'desktop') && d.data) setCheck((c) => (c ? { ...c, [fromCheck]: d.data } : c));
      if (d.type === 'error' && d.msg) {
        // "(linha N)" do documento montado vira arquivo:linha do projeto + trecho, para a correção acertar o lugar
        const srcDoc = other ? buildPreview(files, other, images) : shownDoc;
        const located = d.msg.replace(/\(linha (\d+)\)$/, (all, n: string) => { const l = locateLine(srcDoc, Number(n), other ?? page); return l ? `(em ${l})` : all; });
        const msg = other ? `${other}: ${located}` : located;
        if (fromCheck) setCheck((c) => (c && !c.errors.includes(msg) ? { ...c, errors: [...c.errors, msg].slice(-10) } : c));
        else setErrors((x) => (x.includes(msg) ? x : [...x, msg].slice(-10)));
      }
      if (d.type === 'console' && d.msg && !fromCheck) setLogs((x) => [...x, d.msg!].slice(-200));
      if (d.type === 'nav' && d.msg && !fromCheck) { if (viewFiles[d.msg]) setPage(d.msg); else notify('warn', `A página ${d.msg} não existe no projeto.`); }
      if (d.type === 'img-request' && d.msg && project) {
        const ref = d.msg.trim();
        const [desc, q = ''] = ref.split('?');
        const ps = new URLSearchParams(q);
        const src = e.source as Window | null;
        void generateImage(project.id, ref, decodeURIComponent(desc!).trim(), Number(ps.get('w')) || 800, Number(ps.get('h')) || 800).then((url) => { if (url) src?.postMessage({ __lume: 'img', ref, url }, '*'); });
      }
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [viewFiles, notify, project, files, images, shownDoc, page]);

  // ---------------------------------------------------------------- verificação: roda o projeto no celular e no desktop
  const problems = useMemo(() => {
    const out: { kind: 'erro' | 'layout' | 'imagem' | 'estrutura'; text: string }[] = [];
    for (const p of staticProblems(files)) out.push({ kind: 'estrutura', text: p });
    // compara com o estado de antes do último pedido seu (somando as continuações e correções automáticas)
    if (!busy && project) {
      const msgs = project.messages;
      let i = msgs.length - 1;
      while (i >= 0 && !(msgs[i]!.role === 'user' && !msgs[i]!.auto)) i--;
      const before: Record<string, string | null> = {};
      for (const m of msgs.slice(i + 1)) for (const [n, c] of Object.entries(m.before ?? {})) if (!(n in before)) before[n] = c;
      for (const p of lostFunctions(before, files)) out.push({ kind: 'estrutura', text: p });
    }
    for (const e of [...errors, ...(check?.errors ?? [])].filter((v, i, a) => a.indexOf(v) === i)) out.push({ kind: 'erro', text: e });
    if (check?.mobile && check.mobile.overflow > 4) out.push({ kind: 'layout', text: `No celular (390px) a página estoura ${check.mobile.overflow}px na horizontal${check.mobile.wide.length ? `: ${check.mobile.wide.join(', ')}` : ''}` });
    for (const b of check?.mobile?.broken ?? []) out.push({ kind: 'imagem', text: `Imagem não carregou: ${b}` });
    if (check?.desktop && check.desktop.h1 === 0) out.push({ kind: 'estrutura', text: 'A página não tem título principal (h1)' });
    return out;
  }, [files, errors, check, busy, project]);
  const verify = () => {
    if (!fileNames.length) return;
    setCheck({ at: Date.now(), errors: [] });
    setVerifying(true);
    setTimeout(() => setVerifying(false), 5500);
  };
  // depois de cada geração: verifica sozinha e, se houver problema, corrige (até 2 vezes por pedido seu)
  const lastDone = !busy && last?.role === 'assistant' && !last.streaming ? last.id : null;
  useEffect(() => { if (lastDone && fileNames.length) verify(); }, [lastDone]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (busy || verifying || !check?.mobile || !ready || autoFix.current >= 2 || !lastDone || imaging) return;
    const serious = problems.filter((p) => p.kind !== 'imagem');
    if (!serious.length) return;
    autoFix.current += 1;
    // diz exatamente quais arquivos precisam voltar (a IA tende a reenviar só parte deles)
    const must = [...new Set(serious.flatMap((p) => [/^([\w./-]+\.(?:html|css|js|json))\b/.exec(p.text)?.[1], /\(em ([\w./-]+\.(?:html|css|js)):\d+/.exec(p.text)?.[1]]).filter((f): f is string => !!f && f in files))];
    // só os arquivos citados nos problemas vão completos para a IA (sobra mais espaço para a resposta)
    const named = Object.keys(files).filter((n) => serious.some((p) => p.text.includes(n)));
    // + os scripts que essas páginas carregam (é neles que a lógica costuma estar)
    const focus = [...new Set([...named, ...named.filter((n) => n.endsWith('.html')).flatMap((n) => [...(files[n] ?? '').matchAll(/<script[^>]*\bsrc=["']([^"':]+)["']/gi)].map((m) => m[1]!.replace(/^\.\//, '')))])].filter((n) => n in files);
    void studioSend(ready, `A verificação automática (projeto executado no celular 390px e no desktop) encontrou estes problemas. Corrija a causa de cada um e reenvie COMPLETOS só os arquivos alterados, preservando o visual e as funcionalidades:\n${serious.map((p) => `- ${p.text}`).join('\n')}${must.length ? `\n\nArquivos que você DEVE reenviar completos nesta resposta: ${must.join(', ')}. Confira cada problema da lista antes de terminar.` : ''}`, 0, undefined, 'fix', focus.length ? focus : undefined);
  }, [check, verifying, busy, ready, lastDone, imaging]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- ações
  const exported = () => applyImages(files, images);
  const download = () => {
    if (!project) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(makeZip(exported()));
    a.download = `${project.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'site'}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const openTab = async () => {
    const html = buildPreview(files, page, images);
    const url = local ? `${api.coreUrl ?? ''}${(await api.req<{ url: string }>('/api/studio/preview', { method: 'POST', json: { html } })).url}` : URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    if (!window.open(url, '_blank')) notify('warn', 'Permita pop-ups para abrir em nova aba.');
  };
  const saveToPc = async () => {
    if (!project) return;
    const dir = prompt('Salvar em qual pasta do PC? (precisa estar entre as pastas liberadas)', 'C:\\Users\\Public\\Documents\\' + (project.name.replace(/[^\w\- ]+/g, '').trim() || 'site'));
    if (!dir) return;
    try {
      for (const [n, c] of Object.entries(exported())) await api.req('/api/code/file', { method: 'PUT', json: { path: `${dir.replace(/[\\/]+$/, '')}/${n}`, content: c } });
      notify('ok', `Projeto salvo em ${dir}`);
    } catch (e) { notify('err', (e as Error).message); }
  };
  const removeProject = (id: string) => { if (!confirm('Apagar este projeto deste navegador?')) return; setProjects((s) => { const projects = s.projects.filter((p) => p.id !== id); return { projects, current: s.current === id ? projects[0]?.id ?? null : s.current }; }); };
  const attach = async (list: FileList | null) => {
    if (!list?.length) return;
    let p = project;
    if (!p) { newProject(); await new Promise((r) => setTimeout(r, 0)); p = null; }
    const pid = p?.id ?? state.current;
    const added: string[] = [];
    for (const f of [...list].slice(0, 8)) {
      if (!f.type.startsWith('image/')) { notify('warn', `${f.name}: envie imagens (JPG, PNG, WebP).`); continue; }
      try {
        const a = await imageToAsset(f);
        added.push(`${a.name} (${a.w}x${a.h})`);
        const id = pid ?? undefined;
        if (id) updateProject(id, (x) => ({ ...x, files: { ...x.files, [a.name]: a.dataUrl } }));
      } catch { notify('err', `Não consegui ler ${f.name}.`); }
    }
    if (added.length) {
      notify('ok', `${added.length} imagem(ns) adicionada(s) ao projeto.`);
      setText((t) => (t ? t + '\n' : '') + `Use as imagens que enviei: ${added.join(', ')}.`);
    }
  };

  const width = device === 'mobile' ? 390 : device === 'tablet' ? 820 : null;
  const elapsed = busy ? Math.floor((now - busy.started) / 1000) : 0;
  const editing = openFile && openFile in viewFiles ? openFile : fileNames.find((n) => !files[n]!.startsWith('data:')) ?? null;
  const changeSets = (project?.messages ?? []).filter((m) => m.role === 'assistant' && m.before && m.changes?.length).reverse();
  const sel = diffSel ?? (changeSets[0] ? { msg: changeSets[0].id, file: changeSets[0].changes![0]!.name } : null);
  const selMsg = changeSets.find((m) => m.id === sel?.msg);
  const frameProps = (src: string) => (local ? { src: localSrc ?? 'about:blank' } : { srcDoc: src });

  const tabs: [Tab, string, typeof Eye, number?][] = [['preview', 'Preview', Eye], ['code', 'Código', Code2], ['changes', 'Alterações', GitCompare, changeSets.length || undefined], ['problems', 'Problemas', AlertTriangle, problems.length || undefined], ['console', 'Console', TerminalSquare, logs.length || undefined]];

  return (
    <div className="h-full grid grid-cols-[minmax(340px,420px)_minmax(0,1fr)] max-lg:grid-cols-1 max-lg:grid-rows-[minmax(0,1fr)_minmax(0,1fr)] view-enter">
      {/* ------------------------------------------------ agente */}
      <section className="flex flex-col min-h-0 border-r border-line max-lg:border-r-0 max-lg:border-b">
        <header className="h-12 px-3 flex items-center gap-2 border-b border-line relative">
          <button onClick={() => setMenu((v) => !v)} className="press flex items-center gap-1.5 min-w-0 rounded-lg px-2 h-8 hover:bg-white/[0.05]" aria-haspopup="menu" aria-expanded={menu}>
            <FileCode2 className="size-4 text-accent-glow shrink-0" />
            <span className="text-[13px] font-medium truncate">{project?.name ?? 'Projetos'}</span>
            <ChevronDown className={cx('size-3.5 text-dim transition-transform', menu && 'rotate-180')} />
          </button>
          <button onClick={newProject} title="Novo projeto" className="press ml-auto flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[12px] text-muted hover:bg-white/[0.06] hover:text-fg"><Plus className="size-4" />Novo</button>
          {menu && (
            <div className="absolute left-3 top-11 z-30 w-[320px] surface-raised rounded-xl p-1.5 shadow-2xl enter" role="menu">
              <div className="label-tech px-2.5 pt-1.5 pb-1">Seus projetos</div>
              <div className="max-h-80 overflow-y-auto scroll-thin">
                {!state.projects.length && <p className="px-2.5 py-2 text-[12px] text-dim">Nenhum projeto ainda.</p>}
                {state.projects.map((p) => (
                  <div key={p.id} role="menuitem" className={cx('group flex items-center gap-2 px-2.5 h-10 rounded-lg text-[12.5px] hover:bg-white/[0.05] cursor-pointer', p.id === state.current && 'bg-accent/[0.08]')} onClick={() => { setProjects((s) => ({ ...s, current: p.id })); setMenu(false); setOpenFile(null); setPage('index.html'); setCheck(null); }}>
                    <span className="size-6 rounded-md shrink-0 border border-line" style={{ background: p.brief?.paleta?.destaque ?? 'rgb(255 255 255 / .05)' }} />
                    <div className="min-w-0"><div className="truncate">{p.name}</div><div className="text-[10.5px] text-dim">{Object.keys(p.files).length} arquivos · {new Date(p.updatedAt).toLocaleDateString('pt-BR')}</div></div>
                    <button aria-label="Apagar projeto" onClick={(e) => { e.stopPropagation(); removeProject(p.id); }} className="ml-auto opacity-0 group-hover:opacity-100 text-dim hover:text-err"><Trash2 className="size-3.5" /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-4 py-4 space-y-5">
          {engine === 'login' ? <CloudLogin onDone={() => setEngine(cloudBridge())} onLocal={() => setEngine(api)} /> : !project?.messages.length ? (
            <div className="enter pt-2">
              <h2 className="font-display text-[22px] leading-tight">O que vamos construir?</h2>
              <p className="mt-1.5 text-[13px] text-muted">A Lume define o plano de design, escreve os arquivos, gera imagens coerentes, executa o projeto no celular e no desktop e corrige o que encontrar. Depois é só pedir ajustes.</p>
              <ol className="mt-4 grid grid-cols-2 gap-1.5 text-[11.5px] text-dim">
                {['1. Plano de design', '2. Código completo', '3. Imagens por IA', '4. Execução e verificação'].map((s) => <li key={s} className="rounded-md border border-line px-2 py-1.5">{s}</li>)}
              </ol>
              <div className="mt-5 label-tech">Comece por um exemplo</div>
              <div className="mt-2 grid gap-1.5">
                {IDEAS.map((i, n) => (
                  <button key={i.t} onClick={() => void send(i.p)} disabled={!ready} style={{ animationDelay: `${n * 40}ms` }} className="enter text-left rounded-lg border border-line bg-white/[0.015] hover:bg-accent/[0.04] hover:border-accent/30 px-3 py-2 transition-colors disabled:opacity-50">
                    <div className="text-[13px] font-medium">{i.t}</div>
                    <div className="text-[11.5px] text-dim line-clamp-1">{i.p}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : project.messages.map((m) => <AgentMessage key={m.id} m={m} onOpen={(n) => { setTab('code'); setOpenFile(n); }} onDiff={(file) => { setTab('changes'); setDiffSel({ msg: m.id, file }); }} elapsed={m.streaming ? elapsed : undefined} busy={!!busy} last={m.id === last?.id} />)}
          {imaging && (
            <div className="enter flex items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-[12px] text-muted" role="status">
              <ImageIcon className="size-4 text-accent-glow" />
              <span>Gerando imagens do projeto: {imaging.done} de {imaging.total}{imaging.failed ? ` · ${imaging.failed} falhou` : ''}</span>
              <div className="ml-auto h-1 w-20 rounded-full bg-white/[0.06] overflow-hidden"><div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${((imaging.done + imaging.failed) / imaging.total) * 100}%` }} /></div>
            </div>
          )}
          {canResume && (
            <button onClick={() => send('Continue de onde parou e termine o que faltou, sem refazer o que já está pronto.')} className="press flex items-center gap-2 rounded-lg border border-line px-3 h-9 text-[12.5px] text-muted hover:text-fg hover:border-accent/30"><RotateCcw className="size-3.5" />Retomar de onde parou</button>
          )}
          <div ref={endRef} />
        </div>

        <div className="p-3 border-t border-line">
          <div className="composer surface rounded-xl" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void attach(e.dataTransfer.files); }}>
            <textarea ref={taRef} value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Pedido à Lume Code"
              placeholder={project?.messages.length ? 'Peça uma alteração… (ex.: deixe o cabeçalho mais elegante e adicione um modo claro)' : 'Descreva o site ou app que você quer…'}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } if (e.key === 'Escape' && busy) stop(); }}
              className="w-full bg-transparent resize-none outline-none text-[13.5px] px-3.5 pt-3 placeholder:text-dim" />
            <div className="flex items-center gap-1.5 px-2 pb-2">
              <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
              <button onClick={() => fileRef.current?.click()} title="Enviar imagens para o projeto (logo, fotos reais)" aria-label="Enviar imagens" className="press grid place-items-center size-8 rounded-lg text-dim hover:text-fg hover:bg-white/[0.05]"><ImagePlus className="size-4" /></button>
              <ModeSelector value={mode} onChange={setStudioMode} compact />
              <span className="text-[11px] text-dim max-sm:hidden">{mode === 'fast' ? 'Rápido' : mode === 'deep' ? 'Profundo' : 'Equilibrado'}</span>
              {busy ? (
                <button aria-label="Interromper" title="Interromper (Esc)" onClick={stop} className="press ml-auto grid place-items-center size-8 rounded-lg bg-white/10 hover:bg-white/15"><Square className="size-3 fill-current" /></button>
              ) : (
                <button aria-label="Enviar" onClick={() => void send()} disabled={!text.trim() || !ready} className="press ml-auto grid place-items-center size-8 rounded-lg btn-accent"><ArrowUp className="size-4" /></button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ projeto */}
      <section className="flex flex-col min-h-0 min-w-0 bg-[#070808]">
        <header className="min-h-12 px-2.5 py-1.5 flex flex-wrap items-center gap-1.5 border-b border-line">
          <div className="flex items-center rounded-lg bg-white/[0.035] p-0.5 overflow-x-auto scroll-thin max-w-full" role="tablist">
            {tabs.map(([id, label, I, n]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cx('press flex items-center gap-1.5 px-2.5 h-7 rounded-md text-[12px] whitespace-nowrap transition-colors', tab === id ? 'bg-white/[0.09] text-fg' : 'text-dim hover:text-muted')}>
                <I className={cx('size-3.5', id === 'problems' && n ? 'text-warn' : '')} />{label}{n ? <span className={cx('rounded px-1 text-[10px] tabular-nums', id === 'problems' ? 'bg-warn/15 text-warn' : 'bg-white/[0.08] text-muted')}>{n}</span> : null}
              </button>
            ))}
          </div>
          {tab === 'preview' && (
            <div className="flex items-center gap-0.5">
              {([['desktop', Monitor, 'Desktop'], ['tablet', Tablet, 'Tablet'], ['mobile', Smartphone, 'Celular']] as const).map(([id, I, label]) => (
                <button key={id} aria-label={label} title={label} onClick={() => setDevice(id)} className={cx('press grid place-items-center size-7 rounded-md', device === id ? 'text-accent-glow bg-accent/10' : 'text-dim hover:text-muted')}><I className="size-3.5" /></button>
              ))}
              {fileNames.filter((n) => n.endsWith('.html')).length > 1 && (
                <select value={page} onChange={(e) => setPage(e.target.value)} aria-label="Página" className="ml-1 h-7 rounded-md bg-white/[0.04] border border-line text-[11.5px] px-1.5 outline-none">
                  {fileNames.filter((n) => n.endsWith('.html')).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              )}
            </div>
          )}
          <div className="ml-auto flex items-center gap-1">
            {!!fileNames.length && (
              <>
                <button onClick={() => { setReloadKey((k) => k + 1); setTab('preview'); }} title="Executar de novo" className="press flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[12px] text-muted hover:text-fg hover:bg-white/[0.05]"><Play className="size-3.5" /><span className="max-xl:hidden">Executar</span></button>
                <button onClick={() => { verify(); setTab('problems'); }} title="Executar no celular e no desktop e listar problemas" className="press flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[12px] text-muted hover:text-fg hover:bg-white/[0.05]">{verifying ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}<span className="max-xl:hidden">Verificar</span></button>
                <button onClick={openTab} title="Abrir em nova aba" className="press flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[12px] text-muted hover:text-fg hover:bg-white/[0.05]"><ExternalLink className="size-3.5" /><span className="max-xl:hidden">Abrir</span></button>
                {local && <button onClick={saveToPc} title="Salvar no PC" className="press flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[12px] text-muted hover:text-fg hover:bg-white/[0.05]"><HardDriveDownload className="size-3.5" /></button>}
                <button onClick={download} className="press flex items-center gap-1.5 px-3 h-8 rounded-lg text-[12px] font-medium btn-accent"><Download className="size-3.5" />.zip</button>
              </>
            )}
          </div>
        </header>

        <div className="flex-1 min-h-0 relative">
          {!fileNames.length && !live?.writing ? (
            <div className="h-full grid place-items-center p-8 text-center">
              <div className="enter max-w-sm">
                <div className="mx-auto size-14 rounded-xl border border-line grid place-items-center bg-white/[0.02]"><Monitor className="size-6 text-dim" /></div>
                <p className="mt-4 text-[13.5px] text-muted">{busy ? 'A Lume está definindo o plano de design…' : 'O projeto roda aqui, isolado, enquanto a Lume escreve. Você vê o resultado no desktop, tablet e celular.'}</p>
                {busy && <div className="mt-4 h-1 rounded-full overflow-hidden bg-white/[0.05]"><div className="h-full w-1/3 bg-gradient-to-r from-transparent via-accent to-transparent animate-scan" /></div>}
              </div>
            </div>
          ) : tab === 'preview' ? (
            <div className="h-full overflow-auto scroll-thin flex justify-center" style={{ padding: width ? 16 : 0 }}>
              <div className={cx('relative shrink-0 bg-white transition-[width] duration-300 ease-out', width ? 'rounded-xl overflow-hidden border border-line shadow-2xl' : '')} style={{ width: width ?? '100%', maxWidth: '100%', height: '100%' }}>
                <iframe ref={frameRef} key={reloadKey} title="Preview do projeto" {...frameProps(shownDoc)} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock" className="absolute inset-0 w-full h-full border-0 bg-white" />
                {busy && <div className="absolute top-2 right-2 flex items-center gap-1.5 rounded-full bg-black/75 backdrop-blur px-2.5 py-1 text-[11px] text-white enter"><Loader2 className="size-3 animate-spin text-accent" />atualizando ao vivo</div>}
              </div>
            </div>
          ) : tab === 'code' ? (
            <div className="h-full grid grid-cols-[190px_minmax(0,1fr)] max-sm:grid-cols-1">
              <aside className="border-r border-line overflow-y-auto scroll-thin py-1.5 max-sm:hidden" aria-label="Arquivos">
                <div className="label-tech px-3 py-1">Arquivos</div>
                {[...new Set([...fileNames, ...(live?.writing ? [live.writing.name] : [])])].map((n) => {
                  const isImg = files[n]?.startsWith('data:');
                  return (
                    <button key={n} onClick={() => !isImg && setOpenFile(n)} className={cx('w-full flex items-center gap-2 h-7 px-3 text-[12px] text-left', editing === n ? 'bg-accent/[0.09] text-fg' : 'text-muted hover:bg-white/[0.04]', isImg && 'cursor-default')}>
                      {isImg ? <ImageIcon className="size-3.5 shrink-0 text-dim" /> : <FileCode2 className="size-3.5 shrink-0 text-dim" />}<span className="truncate">{n}</span>
                      {live?.writing?.name === n && <Loader2 className="ml-auto size-3 animate-spin text-accent" />}
                    </button>
                  );
                })}
              </aside>
              <div className="min-h-0">
                {(() => {
                  const name = live?.writing && openFile === live.writing.name ? live.writing.name : editing;
                  if (!name) return null;
                  const writingNow = live?.writing?.name === name;
                  const value = writingNow ? live!.writing!.content : viewFiles[name] ?? '';
                  return (
                    <Editor key={name} theme="lume" path={`studio/${name}`} language={langOf(name)} value={value} beforeMount={defineTheme}
                      onChange={(v) => { if (!writingNow && project && !busy) updateProject(project.id, (x) => ({ ...x, files: { ...x.files, [name]: v ?? '' } })); }}
                      options={{ readOnly: writingNow || !!busy, fontSize: 13, fontFamily: 'JetBrains Mono Variable, monospace', minimap: { enabled: false }, smoothScrolling: true, cursorSmoothCaretAnimation: 'on', padding: { top: 12 }, scrollBeyondLastLine: false, automaticLayout: true, tabSize: 2, wordWrap: 'on' }} />
                  );
                })()}
              </div>
            </div>
          ) : tab === 'changes' ? (
            <div className="h-full grid grid-cols-[230px_minmax(0,1fr)] max-sm:grid-cols-1">
              <aside className="border-r border-line overflow-y-auto scroll-thin py-1.5 max-sm:hidden" aria-label="Alterações">
                {!changeSets.length && <p className="px-3 py-2 text-[12px] text-dim">Nenhuma alteração registrada ainda.</p>}
                {changeSets.map((m, i) => (
                  <div key={m.id} className="mb-2">
                    <div className="label-tech px-3 py-1">{i === 0 ? 'Última alteração' : `${i + 1}ª mais recente`}</div>
                    {m.changes!.map((c) => (
                      <button key={c.name} onClick={() => setDiffSel({ msg: m.id, file: c.name })} className={cx('w-full flex items-center gap-2 h-7 px-3 text-[12px] text-left', sel?.msg === m.id && sel.file === c.name ? 'bg-accent/[0.09] text-fg' : 'text-muted hover:bg-white/[0.04]')}>
                        {c.kind === 'create' ? <FilePlus2 className="size-3.5 text-ok shrink-0" /> : c.kind === 'delete' ? <FileX2 className="size-3.5 text-err shrink-0" /> : <FilePen className="size-3.5 text-warn shrink-0" />}
                        <span className="truncate">{c.name}</span><span className="ml-auto text-[10.5px] text-dim">{c.kind === 'create' ? 'novo' : c.kind === 'delete' ? 'removido' : 'editado'}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </aside>
              <div className="min-h-0 flex flex-col">
                {sel && selMsg ? (
                  <>
                    <div className="px-3 py-1.5 text-[11.5px] text-dim border-b border-line">{sel.file}: antes ← → agora{changeSets[0]?.id !== sel.msg ? ' (comparado com a versão atual)' : ''}</div>
                    <div className="flex-1 min-h-0"><DiffEditor key={`${sel.msg}:${sel.file}`} keepCurrentOriginalModel keepCurrentModifiedModel theme="lume" original={selMsg.before?.[sel.file] ?? ''} modified={files[sel.file] ?? ''} language={langOf(sel.file)} beforeMount={defineTheme} options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12.5, automaticLayout: true }} /></div>
                  </>
                ) : <div className="h-full grid place-items-center text-[13px] text-dim">Escolha um arquivo alterado.</div>}
              </div>
            </div>
          ) : tab === 'problems' ? (
            <div className="h-full overflow-y-auto scroll-thin p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
                {verifying ? <span className="flex items-center gap-2 text-muted"><Loader2 className="size-4 animate-spin text-accent" />Executando no celular (390px) e no desktop (1280px)…</span>
                  : check?.mobile ? <span className="flex items-center gap-2 text-muted">{problems.length ? <AlertTriangle className="size-4 text-warn" /> : <CheckCircle2 className="size-4 text-ok" />}Verificado agora: celular {check.mobile.overflow > 4 ? `estoura ${check.mobile.overflow}px` : 'sem estouro'}, {check.mobile.images} imagens, {check.desktop?.h1 ?? '?'} título(s) h1</span>
                  : <span className="text-dim">Clique em Verificar para executar o projeto e procurar problemas.</span>}
                {!!problems.length && ready && !busy && <button onClick={() => send(`Corrija estes problemas encontrados na verificação, preservando o visual e as funcionalidades:\n${problems.map((p) => `- ${p.text}`).join('\n')}`)} className="press ml-auto flex items-center gap-1.5 rounded-lg bg-accent/12 hover:bg-accent/20 border border-accent/25 px-3 h-8 text-[12px] text-fg"><Wand2 className="size-3.5" />Pedir para a Lume corrigir</button>}
              </div>
              {!problems.length && check?.mobile && !verifying && <p className="text-[13px] text-dim">Nenhum problema encontrado.</p>}
              <ul className="space-y-1.5">
                {problems.map((p, i) => (
                  <li key={i} className="flex gap-2.5 rounded-lg border border-line bg-white/[0.015] px-3 py-2 text-[12.5px]">
                    <span className={cx('mt-0.5 shrink-0 rounded px-1.5 text-[10px] uppercase tracking-wide h-fit', p.kind === 'erro' ? 'bg-err/15 text-err' : p.kind === 'layout' ? 'bg-warn/15 text-warn' : 'bg-white/[0.07] text-muted')}>{p.kind}</span>
                    <span className="font-mono text-[11.5px] text-fg/85 break-words">{p.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="h-full overflow-y-auto scroll-thin bg-[#050606] p-3 font-mono text-[11.5px] leading-relaxed">
              <div className="text-dim mb-1">Console do projeto em execução {logs.length ? '' : '(vazio)'}</div>
              {logs.map((l, i) => <div key={i} className={cx('whitespace-pre-wrap break-all', l.startsWith('[warn]') ? 'text-warn' : 'text-fg/85')}>{l}</div>)}
              {errors.map((e) => <div key={e} className="text-err whitespace-pre-wrap break-all">✖ {e}</div>)}
            </div>
          )}

          {/* verificação: o mesmo projeto rodando oculto em celular e desktop */}
          {check && verifying && (
            <div aria-hidden className="absolute -left-[9999px] top-0 pointer-events-none opacity-0">
              <iframe ref={mobileRef} title="verificação celular" {...frameProps(shownDoc)} sandbox="allow-scripts allow-forms" style={{ width: 390, height: 844 }} />
              <iframe ref={deskRef} title="verificação desktop" {...frameProps(shownDoc)} sandbox="allow-scripts allow-forms" style={{ width: 1280, height: 800 }} />
              {!local && fileNames.filter((n) => n.endsWith('.html') && n !== page).slice(0, 4).map((n) => (
                <iframe key={n} ref={(el) => { pageRefs.current[n] = el; }} title={`verificação ${n}`} srcDoc={buildPreview(files, n, images)} sandbox="allow-scripts allow-forms" style={{ width: 1280, height: 800 }} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/** Cartão do plano de design definido antes do código. */
function BriefCard({ brief }: { brief: Brief }) {
  const pal = Object.entries(brief.paleta ?? {}).filter(([, v]) => /^#[0-9a-f]{3,8}$/i.test(v));
  return (
    <div className="enter rounded-xl border border-line bg-white/[0.02] p-3.5">
      <div className="flex items-center gap-2 text-[12px] text-accent-glow font-medium"><Palette className="size-3.5" />Plano de design</div>
      {brief.negocio && <div className="mt-2 text-[13.5px] font-medium">{brief.negocio}</div>}
      {brief.direcao && <div className="mt-0.5 text-[12.5px] text-muted">{brief.direcao}</div>}
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        {brief.objetivo && <><dt className="text-dim">Objetivo</dt><dd>{brief.objetivo}</dd></>}
        {brief.publico && <><dt className="text-dim">Público</dt><dd>{brief.publico}</dd></>}
        {brief.tipografia && <><dt className="text-dim">Tipografia</dt><dd>{[brief.tipografia.titulos, brief.tipografia.texto].filter(Boolean).join(' + ')}</dd></>}
        {brief.imagens && <><dt className="text-dim">Imagens</dt><dd>{brief.imagens}</dd></>}
        {!!brief.paginas?.length && <><dt className="text-dim">Páginas</dt><dd>{brief.paginas.map((p) => p.split(/\s+[—–-]\s+/)[0]).join(', ')}</dd></>}
      </dl>
      {!!pal.length && (
        <div className="mt-3 flex gap-1.5" aria-label="Paleta">
          {pal.map(([k, v]) => <span key={k} title={`${k}: ${v}`} className="h-6 flex-1 rounded-md border border-white/10" style={{ background: v }} />)}
        </div>
      )}
      {!!brief.componentes?.length && <div className="mt-3 flex flex-wrap gap-1">{brief.componentes.slice(0, 8).map((c) => <span key={c} className="rounded-md bg-white/[0.05] px-1.5 py-0.5 text-[11px] text-muted">{c}</span>)}</div>}
    </div>
  );
}

/** Mensagem no estilo de um ambiente de programação: texto fluido, plano, cartões de cada arquivo e resumo. */
function AgentMessage({ m, onOpen, onDiff, elapsed, busy, last }: { m: Msg; onOpen: (name: string) => void; onDiff: (file: string) => void; elapsed?: number; busy: boolean; last: boolean }) {
  const segs = useMemo(() => (m.role === 'assistant' ? parseSegments(m.content) : []), [m.content, m.role]);
  if (m.role === 'user' && m.auto === 'fix') {
    const items = m.content.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
    return (
      <details className="enter rounded-lg border border-warn/25 bg-warn/[0.05] px-3 py-2 text-[12px] text-muted">
        <summary className="cursor-pointer list-none flex items-center gap-2 text-warn"><RefreshCw className="size-3" />A verificação encontrou {items.length} {items.length === 1 ? 'problema' : 'problemas'} — corrigindo sozinha</summary>
        <ul className="mt-2 space-y-1 pl-5 list-disc">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
      </details>
    );
  }
  if (m.role === 'user' && m.auto) return <div className="enter flex items-center gap-2 text-[11.5px] text-dim"><RefreshCw className="size-3" />Continuando o arquivo que foi cortado…</div>;
  if (m.role === 'user') return <div className="enter ml-6 rounded-xl rounded-br-sm bg-white/[0.06] border border-line px-3.5 py-2.5 text-[13.5px] whitespace-pre-wrap break-words">{m.content}</div>;
  const changed = new Map((m.changes ?? []).map((c) => [c.name, c]));
  return (
    <div className="enter space-y-2.5">
      {segs.map((s, i) => {
        if (s.kind === 'text') return <div key={i} className="text-[13.5px]"><Markdown text={s.text} streaming={m.streaming && i === segs.length - 1} /></div>;
        if (s.kind === 'brief') return s.brief ? <BriefCard key={i} brief={s.brief} /> : <div key={i} className="flex items-center gap-2 text-[12px] text-muted"><Loader2 className="size-3.5 animate-spin text-accent" />Definindo o plano de design…</div>;
        if (s.kind === 'delete') return <ToolCard key={i} icon={<FileX2 className="size-3.5 text-err" />} verb="Remover" name={s.name} detail="arquivo removido" done onClick={() => {}} />;
        const cont = s.name.endsWith('.continue');
        const name = cont ? s.name.slice(0, -'.continue'.length) : s.name;
        const c = changed.get(name);
        const lines = s.content.split('\n').length - (s.done ? 1 : 0);
        const writing = !s.done && !!m.streaming;
        return <ToolCard key={i} icon={c?.kind === 'update' || cont ? <FilePen className="size-3.5 text-warn" /> : <FilePlus2 className="size-3.5 text-ok" />} verb={cont ? 'Continuar' : c?.kind === 'update' ? 'Editar' : 'Criar'} name={name} detail={s.done ? `${lines} linhas` : writing ? `escrevendo… ${lines} linhas` : `${lines} linhas · continua abaixo`} done={!writing} onClick={() => onOpen(name)} />;
      })}
      {m.streaming && (
        <div className="flex items-center gap-2 text-[12px] text-muted" role="status">
          <span className="studio-star">✻</span>
          <span className="shimmer-text font-medium">{segs.some((s) => s.kind === 'file' && !s.done) ? 'Escrevendo código' : segs.some((s) => s.kind === 'brief') ? 'Preparando os arquivos' : m.content ? 'Pensando' : 'Planejando'}…</span>
          <span className="text-dim tabular-nums">({elapsed ?? 0}s · Esc interrompe)</span>
        </div>
      )}
      {!m.streaming && !!m.changes?.length && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-dim">
          <CheckCircle2 className="size-3.5 text-ok" />
          <span>{m.changes.filter((c) => c.kind === 'create').length} criado(s), {m.changes.filter((c) => c.kind === 'update').length} editado(s){m.ms ? ` em ${(m.ms / 1000).toFixed(1)} s` : ''}</span>
          {m.before && <button onClick={() => onDiff(m.changes![0]!.name)} className="text-accent-soft hover:underline">ver alterações</button>}
        </div>
      )}
      {m.cancelled && <div className="text-[11.5px] text-dim">Interrompido por você.</div>}
      {!!m.incomplete?.length && !busy && last && <div className="rounded-lg border border-warn/30 bg-warn/[0.06] px-3 py-2 text-[12px] text-warn">A resposta foi cortada antes de terminar {m.incomplete.join(', ')}. Use “Retomar de onde parou”.</div>}
      {m.error && <div className="rounded-lg border border-err/30 bg-err/[0.07] px-3 py-2 text-[12.5px] text-err flex items-start gap-2"><X className="size-3.5 mt-0.5 shrink-0" />{m.error}</div>}
    </div>
  );
}

function ToolCard({ icon, verb, name, detail, done, onClick }: { icon: React.ReactNode; verb: string; name: string; detail: string; done: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="enter w-full flex items-center gap-2.5 rounded-lg border border-line bg-white/[0.02] hover:bg-white/[0.045] hover:border-accent/25 px-3 py-2 text-left transition-colors">
      <span className={cx('size-1.5 rounded-full shrink-0', done ? 'bg-ok' : 'bg-accent animate-pulse')} />
      {icon}
      <span className="text-[12.5px]"><span className="font-medium">{verb}</span><span className="text-dim">(</span><span className="font-mono text-accent-soft">{name}</span><span className="text-dim">)</span></span>
      <span className="ml-auto text-[11px] text-dim tabular-nums flex items-center gap-1.5">{!done && <Loader2 className="size-3 animate-spin text-accent" />}{detail}</span>
    </button>
  );
}

function defineTheme(monaco: Parameters<NonNullable<React.ComponentProps<typeof Editor>['beforeMount']>>[0]) {
  monaco.editor.defineTheme('lume', {
    base: 'vs-dark', inherit: true,
    rules: [{ token: 'comment', foreground: '5d6764', fontStyle: 'italic' }, { token: 'keyword', foreground: '34d399' }, { token: 'string', foreground: 'a7f3d0' }, { token: 'number', foreground: '6ee7b7' }, { token: 'tag', foreground: '34d399' }, { token: 'attribute.name', foreground: 'cbd5e1' }],
    colors: { 'editor.background': '#070808', 'editor.lineHighlightBackground': '#101413', 'editorLineNumber.foreground': '#36403d', 'editorLineNumber.activeForeground': '#6ee7b7', 'editorCursor.foreground': '#34d399', 'editor.selectionBackground': '#10b98133', 'minimap.background': '#070808', 'diffEditor.insertedTextBackground': '#10b98126', 'diffEditor.removedTextBackground': '#f8717126' },
  });
}

