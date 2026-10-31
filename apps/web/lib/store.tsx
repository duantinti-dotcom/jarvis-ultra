'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CoreEvent, CoreVisualState, Approval } from '@jarvis/contracts';
import type { JarvisApi, Conn, StatusView } from './types';

export type Notice = { id: number; tone: 'ok' | 'err' | 'warn' | 'orange'; text: string };
export type StepView = { index: number; tool: string; app?: string; description: string; state: string; at: number };
export type ActiveTask = { taskId: string; conversationId: string | null; state: string; goal?: string; steps: StepView[]; startedAt: number; updatedAt: number };

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
  /** Tarefas acompanhadas ao vivo (Desktop Control / Histórico). */
  tasks: Record<string, ActiveTask>;
  refreshTick: number;
  bump: () => void;
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
  const [tasks, setTasks] = useState<Record<string, ActiveTask>>({});
  const [refreshTick, setRefreshTick] = useState(0);
  const bump = useCallback(() => setRefreshTick((n) => n + 1), []);
  const visualTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

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

  useEffect(() => api.subscribe((e) => {
    switch (e.type) {
      case 'task.update':
        setTasks((t) => {
          const cur = t[e.taskId] ?? { taskId: e.taskId, conversationId: null, state: e.state, steps: [], startedAt: Date.now(), updatedAt: Date.now() };
          const next = { ...t, [e.taskId]: { ...cur, state: e.state, goal: cur.goal ?? e.detail, updatedAt: Date.now() } };
          // mantém só as 12 mais recentes
          return Object.fromEntries(Object.entries(next).sort((x, y) => y[1].updatedAt - x[1].updatedAt).slice(0, 12));
        });
        if (['completed', 'failed', 'cancelled'].includes(e.state)) setRefreshTick((n) => n + 1);
        break;
      case 'task.step':
        setTasks((t) => {
          const cur = t[e.taskId] ?? { taskId: e.taskId, conversationId: e.conversationId, state: 'executing', steps: [], startedAt: Date.now(), updatedAt: Date.now() };
          const steps = cur.steps.filter((s) => s.index !== e.index).concat({ index: e.index, tool: e.tool, app: e.app, description: e.description, state: e.state, at: Date.now() }).sort((a, b) => a.index - b.index);
          return { ...t, [e.taskId]: { ...cur, conversationId: e.conversationId, steps, updatedAt: Date.now() } };
        });
        break;
      case 'conversation.updated':
        setRefreshTick((n) => n + 1);
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

  const decide = useCallback(async (id: string, approve: boolean) => {
    try {
      await api.decide(id, approve);
      setApprovals((a) => a.filter((x) => x.id !== id));
    } catch (e) {
      notify('err', (e as Error).message);
    }
  }, [api, notify]);

  const value = useMemo<Ctx>(() => ({
    api, conn, connDetail, status, refreshStatus, visual, setVisual, approvals, decide, notices, notify, capture, tasks, refreshTick, bump, onEvent: api.subscribe,
  }), [api, conn, connDetail, status, refreshStatus, visual, setVisual, approvals, decide, notices, notify, capture, tasks, refreshTick, bump]);

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
