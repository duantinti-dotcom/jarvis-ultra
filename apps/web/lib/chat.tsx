'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GenerationMetrics } from '@jarvis/contracts';
import type { ChatMessage, ReasoningMode } from './types';
import { useJarvis } from './store';

export type ToolActivity = { callId: string; tool: string; args?: unknown; ok?: boolean; summary?: string; durationMs?: number; running: boolean };
export type LiveMessage = ChatMessage & {
  streaming?: boolean; tools?: ToolActivity[]; metrics?: GenerationMetrics | null; error?: string; images?: string[];
  /** Medido no navegador: envio → primeiro trecho de texto (inclui rede + core + modelo). */
  clientFirstMs?: number;
};
export type Stage = { kind: 'idle' } | { kind: 'thinking' } | { kind: 'tool'; tool: string } | { kind: 'writing' };

type ChatCtx = {
  conversationId: string | null;
  messages: LiveMessage[];
  busy: boolean;
  stage: Stage;
  mode: ReasoningMode;
  setMode: (m: ReasoningMode) => void;
  send: (text: string, images?: string[], modeOverride?: ReasoningMode) => Promise<string | null>;
  open: (id: string | null) => Promise<void>;
  cancel: () => void;
  edit: (seq: number, text: string) => Promise<void>;
  regenerate: () => Promise<void>;
};

const C = createContext<ChatCtx | null>(null);
export const useChat = () => {
  const c = useContext(C);
  if (!c) throw new Error('ChatProvider ausente');
  return c;
};

const readMode = (): ReasoningMode => {
  try {
    const m = localStorage.getItem('jarvis.mode');
    return m === 'fast' || m === 'deep' ? m : 'balanced';
  } catch {
    return 'balanced';
  }
};

export function ChatProvider({ children }: { children: ReactNode }) {
  const { api, setVisual, bump } = useJarvis();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [mode, setModeState] = useState<ReasoningMode>('balanced');
  const convRef = useRef<string | null>(null);
  const activeMsg = useRef<string | null>(null);
  const sentAt = useRef<number>(0);
  convRef.current = conversationId;

  useEffect(() => setModeState(readMode()), []);
  const setMode = useCallback((m: ReasoningMode) => {
    setModeState(m);
    try { localStorage.setItem('jarvis.mode', m); } catch {}
  }, []);

  const patch = (id: string, fn: (m: LiveMessage) => LiveMessage) => setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  useEffect(() => api.subscribe((e) => {
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
          if (id) setTimeout(() => api.conversation(id).then((list) => setMessages((ms) => mergeSeq(ms, list))).catch(() => {}), 200);
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
  }), [api, bump]);

  const open = useCallback(async (id: string | null) => {
    setConversationId(id);
    convRef.current = id;
    setStage({ kind: 'idle' });
    if (!id) return setMessages([]);
    try {
      setMessages((await api.conversation(id)).map((m) => ({ ...m, metrics: (m.metrics as GenerationMetrics) ?? null })));
    } catch (e) {
      setMessages([{ id: 'err', role: 'assistant', content: '', error: (e as Error).message, createdAt: new Date().toISOString() }]);
    }
  }, [api]);

  const send = useCallback(async (text: string, images?: string[], modeOverride?: ReasoningMode) => {
    const t = text.trim();
    if (!t && !images?.length) return null;
    setMessages((ms) => [...ms, { id: `tmp_${Date.now()}`, role: 'user', content: t, images, createdAt: new Date().toISOString() }]);
    setVisual('thinking');
    setStage({ kind: 'thinking' });
    sentAt.current = performance.now();
    try {
      const r = await api.chat(t, convRef.current, { mode: modeOverride ?? mode, images });
      activeMsg.current = r.messageId;
      if (convRef.current !== r.conversationId) {
        convRef.current = r.conversationId;
        setConversationId(r.conversationId);
      }
      bump();
      return r.messageId;
    } catch (e) {
      setMessages((ms) => [...ms, { id: `err_${Date.now()}`, role: 'assistant', content: '', error: (e as Error).message, createdAt: new Date().toISOString() }]);
      setVisual('error');
      setStage({ kind: 'idle' });
      return null;
    }
  }, [api, mode, setVisual, bump]);

  const cancel = useCallback(() => {
    if (activeMsg.current) void api.cancelMessage(activeMsg.current);
    setStage({ kind: 'idle' });
  }, [api]);

  /** Editar: apaga a mensagem editada e as seguintes, e reenvia o novo texto. */
  const edit = useCallback(async (seq: number, text: string) => {
    const id = convRef.current;
    if (!id || !api.truncate) return;
    await api.truncate(id, seq);
    setMessages((ms) => ms.filter((m) => m.seq === undefined || m.seq < seq));
    await send(text);
  }, [api, send]);

  /** Regenerar: refaz a última pergunta do usuário. */
  const regenerate = useCallback(async () => {
    const id = convRef.current;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user' && m.seq !== undefined);
    if (!id || !lastUser || !api.truncate) return;
    await api.truncate(id, lastUser.seq!);
    setMessages((ms) => ms.filter((m) => m.seq === undefined || m.seq < lastUser.seq!));
    await send(lastUser.content);
  }, [api, messages, send]);

  const busy = stage.kind !== 'idle' || messages.some((m) => m.streaming);
  const value = useMemo(() => ({ conversationId, messages, busy, stage, mode, setMode, send, open, cancel, edit, regenerate }), [conversationId, messages, busy, stage, mode, setMode, send, open, cancel, edit, regenerate]);
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
