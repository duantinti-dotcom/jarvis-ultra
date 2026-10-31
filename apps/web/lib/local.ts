import type { JarvisApi, Conn, StatusView, ChatMessage, ConversationSummary } from './types';
import type { CoreEvent, Task, Approval, Memory } from '@jarvis/contracts';
import { Emitter } from './events';

declare global {
  interface Window { __JARVIS__?: { coreUrl: string; token: string } }
}

/** Descobre o core local: injetado pelo Tauri, servido pelo próprio core ou parâmetros de desenvolvimento. */
export async function discoverLocal(): Promise<{ coreUrl: string; token: string } | null> {
  if (typeof window === 'undefined') return null;
  if (window.__JARVIS__?.token) return window.__JARVIS__;
  const params = new URLSearchParams(location.search);
  const qCore = params.get('core');
  const qToken = params.get('token');
  if (qCore && qToken) {
    sessionStorage.setItem('jarvis.local', JSON.stringify({ coreUrl: qCore, token: qToken }));
    history.replaceState(null, '', location.pathname + location.hash);
  }
  const saved = sessionStorage.getItem('jarvis.local');
  if (saved) return JSON.parse(saved);
  // Interface servida pelo próprio core em 127.0.0.1:7821
  if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) && location.port !== '3000') {
    try {
      const r = await fetch('/api/bootstrap');
      if (r.ok) return { coreUrl: location.origin, token: (await r.json()).token };
    } catch {}
  }
  return null;
}

export function createLocalApi(coreUrl: string, token: string): JarvisApi {
  const events = new Emitter<[CoreEvent]>();
  const conn = new Emitter<[Conn, string?]>();
  let es: EventSource | null = null;
  let last: Conn = 'connecting';
  const setConn = (c: Conn, d?: string) => { last = c; conn.emit(c, d); };

  const connect = () => {
    es?.close();
    es = new EventSource(`${coreUrl}/api/events?token=${encodeURIComponent(token)}`);
    es.addEventListener('hello', () => setConn('online'));
    es.addEventListener('core', (m) => events.emit(JSON.parse((m as MessageEvent).data)));
    es.onerror = () => setConn('offline', 'Sem conexão com o JARVIS Core local');
  };
  connect();

  async function req<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const { json, ...rest } = init;
    const r = await fetch(coreUrl + path, {
      ...rest,
      headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(rest.headers ?? {}) },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    const type = r.headers.get('content-type') ?? '';
    const body = type.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error((body as { error?: string })?.error ?? `HTTP ${r.status}`);
    return body as T;
  }

  return {
    mode: 'local', coreUrl, token, req,
    subscribe: (fn) => events.on(fn),
    onConn: (fn) => { fn(last); return conn.on(fn); },
    async status() {
      const s = await req<StatusView & { device: StatusView['device'] }>('/api/status');
      return { ...s, online: true, lastSeen: new Date().toISOString() };
    },
    chat: (text, conversationId, opts) => req('/api/chat', { method: 'POST', json: { text, conversationId, mode: opts?.mode, images: opts?.images } }),
    truncate: async (id, fromSeq) => { await req(`/api/conversations/${id}/truncate`, { method: 'POST', json: { fromSeq } }); },
    cancelMessage: async (id) => { await req(`/api/chat/${id}/cancel`, { method: 'POST' }); },
    conversations: () => req<ConversationSummary[]>('/api/conversations'),
    conversation: async (id) => (await req<{ messages: ChatMessage[] }>(`/api/conversations/${id}`)).messages,
    tasks: (limit = 50) => req<Task[]>(`/api/tasks?limit=${limit}`),
    cancelTask: async (id) => { await req(`/api/tasks/${id}/cancel`, { method: 'POST' }); },
    approvals: () => req<Approval[]>('/api/approvals?state=pending'),
    decide: async (id, approve) => (await req<{ state: string }>(`/api/approvals/${id}`, { method: 'POST', json: { approve } })).state,
    memories: (q) => req<Memory[]>(`/api/memory${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    emergencyStop: async () => { await req('/api/emergency/stop', { method: 'POST' }); },
    live: () => req('/api/system/live'),
  };
}
