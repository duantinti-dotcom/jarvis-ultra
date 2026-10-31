'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GenerationMetrics } from '@jarvis/contracts';
import type { ChatMessage, ReasoningMode } from './types';
import { useJarvis } from './store';
import { cloudBridge, hasCloudSession, PC_RE } from './cloudBridge';
import { supabase, remoteConfigured } from './remote';
import type { JarvisApi } from './types';

export type ToolActivity = { callId: string; tool: string; args?: unknown; ok?: boolean; summary?: string; durationMs?: number; running: boolean };
export type LiveMessage = ChatMessage & {
  streaming?: boolean; tools?: ToolActivity[]; metrics?: GenerationMetrics | null; error?: string; images?: string[];
  /** Medido no navegador: envio → primeiro trecho de texto (inclui rede + core + modelo). */
  clientFirstMs?: number;
};
export type Stage = { kind: 'idle' } | { kind: 'thinking' } | { kind: 'tool'; tool: string } | { kind: 'writing' };

type ChatCtx = {
  /** App do PC: conta conectada à nuvem (respostas rápidas). */
  cloudOk: boolean;
  conversationId: string | null;
  messages: LiveMessage[];
  busy: boolean;
  stage: Stage;
  mode: ReasoningMode;
  setMode: (m: ReasoningMode) => void;
  send: (text: string, images?: string[], modeOverride?: ReasoningMode, extra?: { voice?: boolean; local?: boolean }) => Promise<string | null>;
  open: (id: string | null) => Promise<void>;
  cancel: () => void;
  edit: (seq: number, text: string) => Promise<void>;
  regenerate: () => Promise<void>;
};

const C = createContext<ChatCtx | null>(null);
const LAST = 'jarvis.lastConversation';
export const useChat = () => {
  const c = useContext(C);
  if (!c) throw new Error('ChatProvider ausente');
  return c;
};

const readMode = (): ReasoningMode => {
  try {
    const m = localStorage.getItem('jarvis.mode');
    return m === 'balanced' || m === 'deep' ? m : 'fast';
  } catch {
    return 'fast';
  }
};

export function ChatProvider({ children }: { children: ReactNode }) {
  const { api, setVisual, bump } = useJarvis();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [mode, setModeState] = useState<ReasoningMode>('fast');
  const convRef = useRef<string | null>(null);
  const activeMsg = useRef<string | null>(null);
  const sentAt = useRef<number>(0);
  convRef.current = conversationId;
  // App do PC com conta conectada: conversa pela nuvem (rápida) e usa o PC só para ações no computador.
  const [cloudOk, setCloudOk] = useState(false);
  const brainRef = useRef<'local' | 'cloud'>(api.cloud ? 'cloud' : 'local');
  useEffect(() => {
    if (api.cloud || !remoteConfigured()) return;
    void hasCloudSession().then(setCloudOk);
    const { data } = supabase().auth.onAuthStateChange((_e, sess) => setCloudOk(!!sess));
    return () => data.subscription.unsubscribe();
  }, [api]);
  const be = useCallback((k: 'local' | 'cloud'): JarvisApi => (k === 'cloud' && !api.cloud ? cloudBridge() : api), [api]);

  useEffect(() => setModeState(readMode()), []);
  const setMode = useCallback((m: ReasoningMode) => {
    setModeState(m);
    try { localStorage.setItem('jarvis.mode', m); } catch {}
  }, []);

  const patch = (id: string, fn: (m: LiveMessage) => LiveMessage) => setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  useEffect(() => {
  const handler = (e: Parameters<Parameters<JarvisApi['subscribe']>[0]>[0]) => {
    switch (e.type) {
      case 'chat.delta':
        if (e.conversationId !== convRef.current) return;
        setStage({ kind: 'writing' });
        setMessages((ms) => ms.some((m) => m.id === e.messageId)
          ? ms.map((m) => (m.id === e.messageId ? { ...m, content: m.content + e.text } : m))
          : [...ms, { id: e.messageId, role: 'assistant', content: e.text, createdAt: new Date().toISOString(), streaming: true, tools: [], clientFirstMs: sentAt.current ? Math.round(performance.now() - sentAt.current) : undefined }]);
        break;
      case 'chat.done':
      case 'chat.error':
        if (e.conversationId === convRef.current) {
          if (e.type === 'chat.done') patch(e.messageId, (m) => ({ ...m, streaming: false, metrics: e.metrics }));
          else setMessages((ms) => ms.some((m) => m.id === e.messageId) ? ms.map((m) => (m.id === e.messageId ? { ...m, streaming: false, error: e.error } : m)) : [...ms, { id: e.messageId, role: 'assistant', content: '', error: e.error, createdAt: new Date().toISOString() }]);
          // recarrega para obter as posições (seq) usadas por editar/regenerar
          const id = convRef.current;
          if (id) setTimeout(() => be(brainRef.current).conversation(id).then((list) => setMessages((ms) => mergeSeq(ms, list))).catch(() => {}), 200);
        }
        if (activeMsg.current === e.messageId) {
          activeMsg.current = null;
          setStage({ kind: 'idle' });
        }
        bump();
        break;
      case 'tool.start':
        if (e.conversationId !== convRef.current || !activeMsg.current) return;
        setStage({ kind: 'tool', tool: e.tool });
        {
          const mid = activeMsg.current;
          setMessages((ms) => (ms.some((m) => m.id === mid) ? ms : [...ms, { id: mid, role: 'assistant', content: '', createdAt: new Date().toISOString(), streaming: true, tools: [] }]));
          patch(mid, (m) => ({ ...m, tools: [...(m.tools ?? []), { callId: e.callId, tool: e.tool, args: e.args, running: true }] }));
        }
        break;
      case 'tool.end':
        if (e.conversationId !== convRef.current) return;
        setStage({ kind: 'thinking' });
        setMessages((ms) => ms.map((m) => (m.tools?.some((t) => t.callId === e.callId) ? { ...m, tools: m.tools.map((t) => (t.callId === e.callId ? { ...t, ok: e.ok, summary: e.summary, durationMs: e.durationMs, running: false } : t)) } : m)));
        break;
      case 'conversation.updated':
        break;
    }
  };
  const offs = [api.subscribe(handler)];
  if (cloudOk && !api.cloud) offs.push(cloudBridge().subscribe(handler));
  return () => offs.forEach((f) => f());
  }, [api, bump, be, cloudOk]);

  const open = useCallback(async (id: string | null, quiet = false) => {
    const kind: 'local' | 'cloud' = id?.startsWith('c:') ? 'cloud' : api.cloud ? 'cloud' : 'local';
    if (id?.startsWith('c:')) id = id.slice(2);
    brainRef.current = kind;
    try { if (id) localStorage.setItem(LAST, kind === 'cloud' && !api.cloud ? `c:${id}` : id); else localStorage.removeItem(LAST); } catch {}
    setConversationId(id);
    convRef.current = id;
    setStage({ kind: 'idle' });
    if (!id) return setMessages([]);
    try {
      setMessages((await be(kind).conversation(id)).map((m) => ({ ...m, metrics: (m.metrics as GenerationMetrics) ?? null })));
    } catch (e) {
      if (quiet) { setConversationId(null); convRef.current = null; setMessages([]); return; }
      setMessages([{ id: 'err', role: 'assistant', content: '', error: (e as Error).message, createdAt: new Date().toISOString() }]);
    }
  }, [api, be]);

  const send = useCallback(async (text: string, images?: string[], modeOverride?: ReasoningMode, extra?: { voice?: boolean; local?: boolean }) => {
    const t = text.trim();
    if (!t && !images?.length) return null;
    setMessages((ms) => [...ms, { id: `tmp_${Date.now()}`, role: 'user', content: t, images, createdAt: new Date().toISOString() }]);
    setVisual('thinking');
    setStage({ kind: 'thinking' });
    sentAt.current = performance.now();
    try {
      const kind: 'local' | 'cloud' = api.cloud ? 'cloud' : !cloudOk || extra?.local || images?.length || PC_RE.test(t) ? 'local' : 'cloud';
      // trocou de cérebro no meio da conversa: começa uma conversa nova naquele lado (a tela continua igual)
      const cid = kind === brainRef.current ? convRef.current : null;
      brainRef.current = kind;
      const r = await be(kind).chat(t, cid, { mode: modeOverride ?? mode, images, voice: extra?.voice });
      activeMsg.current = r.messageId;
      if (convRef.current !== r.conversationId) {
        convRef.current = r.conversationId;
        setConversationId(r.conversationId);
      }
      try { localStorage.setItem(LAST, kind === 'cloud' && !api.cloud ? `c:${r.conversationId}` : r.conversationId); } catch {}
      bump();
      return r.messageId;
    } catch (e) {
      setMessages((ms) => [...ms, { id: `err_${Date.now()}`, role: 'assistant', content: '', error: (e as Error).message, createdAt: new Date().toISOString() }]);
      setVisual('error');
      setStage({ kind: 'idle' });
      return null;
    }
  }, [api, be, cloudOk, mode, setVisual, bump]);

  const cancel = useCallback(() => {
    if (activeMsg.current) void be(brainRef.current).cancelMessage(activeMsg.current);
    setStage({ kind: 'idle' });
  }, [api]);

  /** Editar: apaga a mensagem editada e as seguintes, e reenvia o novo texto. */
  const edit = useCallback(async (seq: number, text: string) => {
    const id = convRef.current;
    const b = be(brainRef.current);
    if (!id || !b.truncate) return;
    await b.truncate(id, seq);
    setMessages((ms) => ms.filter((m) => m.seq === undefined || m.seq < seq));
    await send(text);
  }, [api, send]);

  /** Regenerar: refaz a última pergunta do usuário. */
  const regenerate = useCallback(async () => {
    const id = convRef.current;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user' && m.seq !== undefined);
    const b = be(brainRef.current);
    if (!id || !lastUser || !b.truncate) return;
    await b.truncate(id, lastUser.seq!);
    setMessages((ms) => ms.filter((m) => m.seq === undefined || m.seq < lastUser.seq!));
    await send(lastUser.content);
  }, [api, messages, send]);

  // Continua de onde parou: a última conversa reabre ao voltar ao site/app (não some ao fechar a janela).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    let last: string | null = null;
    try { last = localStorage.getItem(LAST); } catch {}
    if (last && !convRef.current && !location.hash.includes('new=1')) void open(last, true).then(() => {}, () => {});
  }, [open]);

  const busy = stage.kind !== 'idle' || messages.some((m) => m.streaming);
  const value = useMemo(() => ({ cloudOk, conversationId, messages, busy, stage, mode, setMode, send, open, cancel, edit, regenerate }), [cloudOk, conversationId, messages, busy, stage, mode, setMode, send, open, cancel, edit, regenerate]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

/** Acrescenta seq às mensagens já exibidas sem perder dados ao vivo (ferramentas, tempos). */
function mergeSeq(live: LiveMessage[], stored: ChatMessage[]): LiveMessage[] {
  const users = stored.filter((m) => m.role === 'user');
  let ui = 0;
  return live.map((m) => {
    const exact = stored.find((s) => s.id === m.id);
    if (exact) return { ...m, seq: exact.seq };
    if (m.role === 'user' && m.id.startsWith('tmp_')) {
      const match = users.slice(ui).find((u) => u.content === m.content);
      if (match) {
        ui = users.indexOf(match) + 1;
        return { ...m, seq: match.seq, id: match.id };
      }
    }
    return m;
  });
}
