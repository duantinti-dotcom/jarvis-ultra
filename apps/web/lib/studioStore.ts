'use client';
import { useSyncExternalStore } from 'react';
import type { CoreEvent, JarvisApi } from './types';
import { parseSegments, applySegments, continuePrompt, LOCAL_CODE_PROMPT } from './studio';

/**
 * Estado do Jarvis Code fora da tela: a geração continua rodando se você trocar de
 * seção, de aba ou minimizar a janela, e tudo fica salvo neste navegador.
 */
export type Change = { name: string; kind: 'create' | 'update' | 'delete'; lines: number };
export type Msg = { id: string; role: 'user' | 'assistant'; content: string; auto?: boolean; changes?: Change[]; incomplete?: string[]; error?: string; ms?: number; streaming?: boolean };
export type Project = { id: string; name: string; files: Record<string, string>; partials?: Record<string, string>; messages: Msg[]; conversationId: string | null; updatedAt: number };
export type Busy = { id: string; started: number; msgId: string | null } | null;
type State = { projects: Project[]; current: string | null; busy: Busy };

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
    state = { projects, current: s.current ?? projects[0]?.id ?? null, busy: null };
  } catch { /* primeiro uso */ }
}

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify({ projects: state.projects, current: state.current })); } catch { onSaveError?.(); }
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
export async function studioSend(api: JarvisApi, text: string, auto = 0, pidArg?: string): Promise<void> {
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
  updateProject(pid, (x) => ({ ...x, messages: [...x.messages, { id: uid(), role: 'user', content: t, auto: auto > 0 }, { id: aid, role: 'assistant', content: '', streaming: true }] }));
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
      const r = applySegments(cur?.files ?? {}, parseSegments(full), cur?.partials);
      const first = r.incomplete[0];
      next = first && !err ? { name: first, partial: r.partials[first]! } : null;
      updateProject(pid, (x) => ({ ...x, files: r.files, partials: r.partials, messages: x.messages.map((m) => (m.id === aid ? { ...m, content: full, streaming: false, changes: r.changes, incomplete: r.incomplete, error: err, ms: Date.now() - started } : m)) }));
      resolveDone();
    }
  };
  const unsub = api.subscribe((e) => { if (realId) handle(e); else early.push(e); });
  try {
    const files = p.files;
    const r = api.cloud
      ? await api.chat(t, p.conversationId, { mode: 'balanced', code: { files } })
      : await api.chat(`${LOCAL_CODE_PROMPT}\n\n${Object.keys(files).length ? `Arquivos atuais:\n${Object.entries(files).map(([n, c]) => `\`\`\`${n.split('.').pop()} ${n}\n${c}\n\`\`\``).join('\n\n')}\n\n` : ''}Pedido: ${t}`, p.conversationId, { mode: 'balanced' });
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
  setStudio((s) => ({ ...s, busy: null }));
}

export function studioStop(api: JarvisApi) {
  const b = state.busy;
  if (b?.msgId) void api.cancelMessage(b.msgId);
}
