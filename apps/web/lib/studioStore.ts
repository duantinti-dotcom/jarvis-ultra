'use client';
import { useSyncExternalStore } from 'react';
import type { CoreEvent, JarvisApi } from './types';
import { parseSegments, applySegments, continuePrompt, finishPartial, findImageRefs, filesForAi, LOCAL_CODE_PROMPT, type Brief } from './studio';
import type { ReasoningMode } from './types';
import { supabase, SUPABASE_URL, SUPABASE_ANON } from './remote';

/**
 * Estado da Lume Code fora da tela: a geração continua rodando se você trocar de
 * seção, de aba ou minimizar a janela, e tudo fica salvo neste navegador.
 */
export type Change = { name: string; kind: 'create' | 'update' | 'delete'; lines: number };
export type Msg = { id: string; role: 'user' | 'assistant'; content: string; auto?: boolean | 'fix' | 'cont'; changes?: Change[]; incomplete?: string[]; error?: string; ms?: number; streaming?: boolean; cancelled?: boolean; mode?: ReasoningMode;
  /** Conteúdo anterior dos arquivos alterados (para ver as diferenças). null = arquivo novo. */
  before?: Record<string, string | null> };
export type Project = { id: string; name: string; files: Record<string, string>; partials?: Record<string, string>; messages: Msg[]; conversationId: string | null; updatedAt: number;
  brief?: Brief; images?: Record<string, string> };
export type Busy = { id: string; started: number; msgId: string | null } | null;
export type Imaging = { pid: string; done: number; total: number; failed: number } | null;
type State = { projects: Project[]; current: string | null; busy: Busy; pending?: string | null; imaging?: Imaging; mode?: ReasoningMode };

const KEY = 'jarvis.studio.v1';
const MAX_CONT = 8; // o provedor grátis corta em ~1500 tokens: continua sozinho até 8 vezes
export const uid = () => (crypto.randomUUID?.() ?? String(Date.now() + Math.random()));

let state: State = { projects: [], current: null, busy: null };
let loaded = false;
const subs = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let onSaveError: (() => void) | null = null;

function load() {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '') as { projects: Project[]; current: string | null };
    // mensagem que estava sendo escrita quando a página foi fechada
    const projects = (s.projects ?? []).map((p) => ({ ...p, messages: p.messages.map((m) => (m.streaming ? { ...m, streaming: false, error: m.content ? undefined : 'Interrompido ao fechar a página.' } : m)) }));
    state = { projects, current: s.current ?? projects[0]?.id ?? null, busy: null, mode: (s as { mode?: ReasoningMode }).mode ?? 'balanced' };
  } catch { /* primeiro uso */ }
}

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const trim = state.projects.map((p) => { let k = 0; return { ...p, messages: [...p.messages].reverse().map((m) => (m.before && ++k > 4 ? { ...m, before: undefined } : m)).reverse() }; });
    try { localStorage.setItem(KEY, JSON.stringify({ projects: trim, current: state.current, mode: state.mode })); } catch { onSaveError?.(); }
  }, 400);
}

export function setStudio(fn: (s: State) => State) {
  state = fn(state);
  save();
  subs.forEach((f) => f());
}
export const getStudio = () => { load(); return state; };
export const updateProject = (id: string, fn: (p: Project) => Project) => setStudio((s) => ({ ...s, projects: s.projects.map((p) => (p.id === id ? { ...fn(p), updatedAt: Date.now() } : p)) }));
export const onStudioSaveError = (f: () => void) => { onSaveError = f; };

const EMPTY: State = { projects: [], current: null, busy: null };
export function useStudio(): State {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, getStudio, () => EMPTY);
}

/** Envia um pedido ao agente. Não depende da tela estar aberta. */
export const setStudioMode = (mode: ReasoningMode) => setStudio((s) => ({ ...s, mode }));

export async function studioSend(api: JarvisApi, text: string, auto = 0, pidArg?: string, kind?: 'fix', focus?: string[]): Promise<void> {
  const mode: ReasoningMode = state.mode ?? 'balanced';
  load();
  const t = text.trim();
  if (!t || (state.busy && !auto)) return;
  let p = (pidArg ?? state.current) ? state.projects.find((x) => x.id === (pidArg ?? state.current)) ?? null : null;
  if (!p) {
    const np: Project = { id: uid(), name: t.replace(/\s+/g, ' ').slice(0, 40), files: {}, messages: [], conversationId: null, updatedAt: Date.now() };
    setStudio((s) => ({ ...s, projects: [np, ...s.projects], current: np.id }));
    p = np;
  } else if (!p.messages.length) {
    const name = t.replace(/\s+/g, ' ').slice(0, 40);
    updateProject(p.id, (x) => ({ ...x, name }));
  }
  const pid = p.id;
  const aid = uid();
  updateProject(pid, (x) => ({ ...x, messages: [...x.messages, { id: uid(), role: 'user', content: t, auto: kind ?? (auto > 0 ? 'cont' : undefined), mode }, { id: aid, role: 'assistant', content: '', streaming: true, mode }] }));
  const started = Date.now();
  setStudio((s) => ({ ...s, busy: { id: pid, started, msgId: null } }));

  let realId: string | null = null;
  let full = '';
  const early: CoreEvent[] = [];
  let finished = false;
  let cancelled = false;
  let next: { name: string; partial: string } | null = null;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });
  // atualizações de texto agrupadas (~10 por segundo) para não pesar
  let flushT: ReturnType<typeof setTimeout> | null = null;
  const flushText = () => { flushT = null; updateProject(pid, (x) => ({ ...x, messages: x.messages.map((m) => (m.id === aid ? { ...m, content: full } : m)) })); };
  const handle = (e: CoreEvent) => {
    if (!('messageId' in e) || e.messageId !== realId) return;
    if (e.type === 'chat.delta') {
      full += e.text;
      flushT ??= setTimeout(flushText, 90);
    } else if (e.type === 'chat.done' || e.type === 'chat.error') {
      if (flushT) { clearTimeout(flushT); flushT = null; }
      finished = true;
      const err = e.type === 'chat.error' ? e.error : undefined;
      cancelled = e.type === 'chat.done' && e.metrics?.model === 'interrompido';
      const cur = state.projects.find((x) => x.id === pid);
      const segs = parseSegments(full);
      const r = applySegments(cur?.files ?? {}, segs, cur?.partials);
      const first = r.incomplete[0];
      next = first && !err ? { name: first, partial: r.partials[first]! } : null;
      const before: Record<string, string | null> = {};
      for (const c of r.changes) before[c.name] = cur?.files[c.name] ?? null;
      const brief = [...segs].reverse().find((x) => x.kind === 'brief' && x.brief);
      updateProject(pid, (x) => ({ ...x, files: r.files, partials: r.partials, brief: brief && brief.kind === 'brief' && brief.brief ? brief.brief : x.brief, messages: x.messages.map((m) => (m.id === aid ? { ...m, content: full, streaming: false, cancelled, changes: r.changes, before: r.changes.length ? before : undefined, incomplete: r.incomplete, error: err, ms: Date.now() - started } : m)) }));
      resolveDone();
    }
  };
  const unsub = api.subscribe((e) => { if (realId) handle(e); else early.push(e); });
  try {
    const files = filesForAi(p.files, focus);
    const r = api.cloud
      ? await api.chat(t, p.conversationId, { mode, code: { files } })
      : await api.chat(`${LOCAL_CODE_PROMPT}\n\n${Object.keys(files).length ? `Arquivos atuais:\n${Object.entries(files).map(([n, c]) => `\`\`\`${n.split('.').pop()} ${n}\n${c}\n\`\`\``).join('\n\n')}\n\n` : ''}Pedido: ${t}`, p.conversationId, { mode });
    realId = r.messageId;
    setStudio((s) => ({ ...s, busy: { id: pid, started, msgId: r.messageId } }));
    updateProject(pid, (x) => ({ ...x, conversationId: r.conversationId }));
    for (const e of early.splice(0)) handle(e);
    if (!finished) await done;
  } catch (e) {
    updateProject(pid, (x) => ({ ...x, messages: x.messages.map((m) => (m.id === aid ? { ...m, streaming: false, error: (e as Error).message } : m)) }));
  } finally {
    unsub();
  }
  const cont = next as { name: string; partial: string } | null;
  if (cont && !cancelled && auto < MAX_CONT) return studioSend(api, continuePrompt(cont.name, cont.partial), auto + 1, pid);
  // acabaram as tentativas (ou foi interrompido): aproveita o que veio dos arquivos cortados
  const cur = state.projects.find((x) => x.id === pid);
  if (cur?.partials && Object.keys(cur.partials).length) {
    const files = { ...cur.files };
    const saved: string[] = [];
    for (const [n, c] of Object.entries(cur.partials)) { const f = finishPartial(n, c); if (f) { files[n] = f; saved.push(n); } }
    updateProject(pid, (x) => ({ ...x, files, partials: {}, messages: x.messages.map((m, i) => (i === x.messages.length - 1 && saved.length ? { ...m, incomplete: [], error: undefined, content: m.content + `\n\n_Aproveitei o que veio de ${saved.join(', ')} e fechei o arquivo. Se faltar algo, peça "complete ${saved[0]}"._` } : m)) }));
  }
  setStudio((s) => ({ ...s, busy: null }));
  if (api.cloud && !cancelled) void resolveImages(pid);
}

/** Pedido vindo do chat ("crie um site…"): a tela do Code envia assim que abrir. */
export function queueStudioPrompt(text: string) {
  load();
  setStudio((s) => ({ ...s, current: null, pending: text }));
}

export function studioStop(api: JarvisApi) {
  const b = state.busy;
  if (b?.msgId) void api.cancelMessage(b.msgId);
}

// ---------------------------------------------------------------- imagens por IA
const inflight = new Map<string, Promise<string | null>>();
/** Gera (ou reaproveita) a imagem de uma referência lume-image e guarda a URL no projeto. */
export function generateImage(pid: string, ref: string, prompt: string, w: number, h: number): Promise<string | null> {
  const key = `${pid}|${ref}`;
  const done = state.projects.find((x) => x.id === pid)?.images?.[ref];
  if (done) return Promise.resolve(done);
  if (inflight.has(key)) return inflight.get(key)!;
  const job = (async () => {
    try {
      const { data } = await supabase().auth.getSession();
      const r = await fetch(`${SUPABASE_URL}/functions/v1/lume-image`, { method: 'POST', headers: { authorization: `Bearer ${data.session?.access_token ?? ''}`, apikey: SUPABASE_ANON, 'content-type': 'application/json' }, body: JSON.stringify({ prompt, w, h }) });
      const j = (await r.json().catch(() => ({}))) as { url?: string };
      if (!r.ok || !j.url) return null;
      updateProject(pid, (x) => ({ ...x, images: { ...(x.images ?? {}), [ref]: j.url! } }));
      return j.url;
    } catch { return null; } finally { inflight.delete(key); }
  })();
  inflight.set(key, job);
  return job;
}

/** Gera todas as imagens que o projeto usa e ainda não existem (3 por vez). */
export async function resolveImages(pid: string) {
  const p = state.projects.find((x) => x.id === pid);
  if (!p) return;
  const todo = findImageRefs(p.files).filter((r) => !p.images?.[r.ref]);
  if (!todo.length) return;
  let done = 0, failed = 0;
  setStudio((s) => ({ ...s, imaging: { pid, done, total: todo.length, failed } }));
  const queue = [...todo];
  await Promise.all([0, 1, 2].map(async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const url = await generateImage(pid, r.ref, r.prompt, r.w, r.h);
      if (url) done++; else failed++;
      setStudio((s) => ({ ...s, imaging: { pid, done, total: todo.length, failed } }));
    }
  }));
  setStudio((s) => ({ ...s, imaging: null }));
}
