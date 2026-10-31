'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CoreEvent, CoreVisualState, Approval, GenerationMetrics } from '@jarvis/contracts';
import type { JarvisApi, Conn, StatusView, ChatMessage } from './types';

export type ToolActivity = { callId: string; tool: string; args?: unknown; ok?: boolean; summary?: string; durationMs?: number; running: boolean };
export type LiveMessage = ChatMessage & { streaming?: boolean; tools?: ToolActivity[]; metrics?: GenerationMetrics | null; error?: string };
export type Notice = { id: number; tone: 'ok' | 'err' | 'warn' | 'orange'; text: string };

type Ctx = {
  api: JarvisApi;
  conn: Conn;
  connDetail?: string;
  status: StatusView | null;
  refreshStatus: () => Promise<void>;
  visual: CoreVisualState;
  setVisual: (s: CoreVisualState) => void;
  approvals: Approval[];
  decide: (id: string, approve: boolean) => Promise<void>;
  notices: Notice[];
  notify: (tone: Notice['tone'], text: string) => void;
  capture: { at: number; scope: string } | null;
  chat: {
    conversationId: string | null;
    messages: LiveMessage[];
    busy: boolean;
    send: (text: string) => Promise<string | null>;
    open: (id: string | null) => Promise<void>;
    cancel: () => void;
    reloadList: number;
  };
  onEvent: (fn: (e: CoreEvent) => void) => () => void;
};

const C = createContext<Ctx | null>(null);
export const useJarvis = () => {
  const c = useContext(C);
  if (!c) throw new Error('JarvisProvider ausente');
  return c;
};

export function JarvisProvider({ api, children }: { api: JarvisApi; children: ReactNode }) {
  const [conn, setConn] = useState<Conn>('connecting');
  const [connDetail, setConnDetail] = useState<string>();
  const [status, setStatus] = useState<StatusView | null>(null);
  const [visual, setVisualState] = useState<CoreVisualState>('idle');
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [capture, setCapture] = useState<Ctx['capture']>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [reloadList, setReloadList] = useState(0);
  const activeMsg = useRef<string | null>(null);
  const convRef = useRef<string | null>(null);
  const visualTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  convRef.current = conversationId;

  const notify = useCallback((tone: Notice['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setNotices((n) => [...n.slice(-3), { id, tone, text }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 6000);
  }, []);

  const setVisual = useCallback((s: CoreVisualState) => {
    clearTimeout(visualTimer.current);
    setVisualState(s);
    if (s === 'success' || s === 'error') visualTimer.current = setTimeout(() => setVisualState('idle'), 2200);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
    } catch (e) {
      setStatus((s) => (s ? { ...s, online: false } : null));
    }
  }, [api]);

  useEffect(() => api.onConn((c, d) => { setConn(c); setConnDetail(d); }), [api]);
  useEffect(() => {
    void refreshStatus();
    const t = setInterval(refreshStatus, 8000);
    return () => clearInterval(t);
  }, [refreshStatus]);
  useEffect(() => {
    if (conn === 'offline' || conn === 'no-device') setVisualState('offline');
    else if (conn === 'online') setVisualState((v) => (v === 'offline' ? 'idle' : v));
  }, [conn]);
  useEffect(() => {
    api.approvals().then(setApprovals).catch(() => {});
  }, [api, conn]);

  const patchMsg = (id: string, fn: (m: LiveMessage) => LiveMessage) => setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  useEffect(() => api.subscribe((e) => {
    switch (e.type) {
      case 'chat.delta':
        if (e.conversationId !== convRef.current) return;
        setMessages((ms) => ms.some((m) => m.id === e.messageId)
          ? ms.map((m) => (m.id === e.messageId ? { ...m, content: m.content + e.text } : m))
          : [...ms, { id: e.messageId, role: 'assistant', content: e.text, createdAt: new Date().toISOString(), streaming: true, tools: [] }]);
        break;
      case 'chat.done':
        if (e.conversationId === convRef.current) patchMsg(e.messageId, (m) => ({ ...m, streaming: false, metrics: e.metrics }));
        if (activeMsg.current === e.messageId) activeMsg.current = null;
        setReloadList((n) => n + 1);
        break;
      case 'chat.error':
        if (e.conversationId === convRef.current) {
          setMessages((ms) => ms.some((m) => m.id === e.messageId) ? ms.map((m) => (m.id === e.messageId ? { ...m, streaming: false, error: e.error } : m)) : [...ms, { id: e.messageId, role: 'assistant', content: '', error: e.error, createdAt: new Date().toISOString() }]);
        }
        if (activeMsg.current === e.messageId) activeMsg.current = null;
        break;
      case 'tool.start':
        if (e.conversationId !== convRef.current || !activeMsg.current) return;
        {
          const mid = activeMsg.current;
          setMessages((ms) => (ms.some((m) => m.id === mid) ? ms : [...ms, { id: mid, role: 'assistant', content: '', createdAt: new Date().toISOString(), streaming: true, tools: [] }]));
          patchMsg(mid, (m) => ({ ...m, tools: [...(m.tools ?? []), { callId: e.callId, tool: e.tool, args: e.args, running: true }] }));
        }
        break;
      case 'tool.end':
        if (e.conversationId !== convRef.current) return;
        setMessages((ms) => ms.map((m) => (m.tools?.some((t) => t.callId === e.callId) ? { ...m, tools: m.tools.map((t) => (t.callId === e.callId ? { ...t, ok: e.ok, summary: e.summary, durationMs: e.durationMs, running: false } : t)) } : m)));
        break;
      case 'approval.request':
        setApprovals((a) => [{ id: e.approvalId, taskId: null, stepId: null, tool: e.tool, args: e.args as Record<string, unknown>, risk: e.risk, reason: e.reason, origin: e.origin, state: 'pending', createdAt: new Date().toISOString(), decidedAt: null }, ...a]);
        notify('warn', `Aprovação necessária: ${e.tool}`);
        break;
      case 'approval.resolved':
        setApprovals((a) => a.filter((x) => x.id !== e.approvalId));
        break;
      case 'agent.state':
        setVisual(e.state);
        break;
      case 'screen.capture':
        setCapture({ at: Date.now(), scope: e.scope });
        setTimeout(() => setCapture(null), 4000);
        break;
      case 'emergency.stop':
        notify('err', 'Parada de emergência acionada. Todas as ações foram interrompidas.');
        void refreshStatus();
        break;
      case 'ui.action':
        if (e.action === 'voice.start' && !location.hash.startsWith('#/voice')) location.hash = '#/voice?auto=1';
        break;
      case 'relay.status':
        void refreshStatus();
        break;
    }
  }), [api, notify, setVisual, refreshStatus]);

  const open = useCallback(async (id: string | null) => {
    setConversationId(id);
    convRef.current = id;
    if (!id) return setMessages([]);
    try {
      setMessages((await api.conversation(id)).map((m) => ({ ...m, metrics: (m.metrics as GenerationMetrics) ?? null })));
    } catch (e) {
      notify('err', (e as Error).message);
    }
  }, [api, notify]);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) return null;
    const tempId = `tmp_${Date.now()}`;
    setMessages((ms) => [...ms, { id: tempId, role: 'user', content: t, createdAt: new Date().toISOString() }]);
    setVisual('thinking');
    try {
      const r = await api.chat(t, convRef.current);
      activeMsg.current = r.messageId;
      if (convRef.current !== r.conversationId) {
        convRef.current = r.conversationId;
        setConversationId(r.conversationId);
      }
      setReloadList((n) => n + 1);
      return r.messageId;
    } catch (e) {
      setMessages((ms) => [...ms, { id: `err_${Date.now()}`, role: 'assistant', content: '', error: (e as Error).message, createdAt: new Date().toISOString() }]);
      setVisual('error');
      return null;
    }
  }, [api, setVisual]);

  const cancel = useCallback(() => {
    if (activeMsg.current) void api.cancelMessage(activeMsg.current);
  }, [api]);

  const decide = useCallback(async (id: string, approve: boolean) => {
    try {
      await api.decide(id, approve);
      setApprovals((a) => a.filter((x) => x.id !== id));
    } catch (e) {
      notify('err', (e as Error).message);
    }
  }, [api, notify]);

  const busy = messages.some((m) => m.streaming) || messages.at(-1)?.role === 'user';
  const value = useMemo<Ctx>(() => ({
    api, conn, connDetail, status, refreshStatus, visual, setVisual, approvals, decide, notices, notify, capture,
    chat: { conversationId, messages, busy, send, open, cancel, reloadList }, onEvent: api.subscribe,
  }), [api, conn, connDetail, status, refreshStatus, visual, setVisual, approvals, decide, notices, notify, capture, conversationId, messages, busy, send, open, cancel, reloadList]);

  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const run = useCallback(async () => {
    try {
      setData(await fn());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void run();
    if (!intervalMs) return;
    const t = setInterval(run, intervalMs);
    return () => clearInterval(t);
  }, [run, intervalMs]);
  return { data, error, loading, reload: run, setData };
}
