import type { CoreEvent } from '@jarvis/contracts';
import { supabase, SUPABASE_URL, SUPABASE_ANON } from './remote';
import type { ChatMessage, ConversationSummary, ReasoningMode } from './types';

/**
 * Jarvis na nuvem: o site conversa sem depender do PC.
 * A IA roda na Edge Function `jarvis-ai` (a chave do provedor nunca vem ao navegador).
 */
const controllers = new Map<string, AbortController>();

export async function cloudChat(text: string, conversationId: string | null, mode: ReasoningMode | undefined, emit: (e: CoreEvent) => void, code?: { files: Record<string, string> }, voice?: boolean): Promise<{ conversationId: string; messageId: string }> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Sessão expirada. Entre novamente.');
  const ac = new AbortController();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/jarvis-ai`, {
    method: 'POST', signal: ac.signal,
    headers: { authorization: `Bearer ${token}`, apikey: SUPABASE_ANON, 'content-type': 'application/json' },
    body: JSON.stringify({ text, conversationId, mode, code, voice }),
  });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({}));
    throw new Error((j as { error?: string }).error ?? `Falha na IA (HTTP ${res.status}).`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  // Lê só até o "meta" para devolver os ids; o restante continua em segundo plano.
  const readEvent = async (): Promise<Record<string, unknown> | null> => {
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) return JSON.parse(line.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
    }
  };
  const meta = await readEvent();
  if (!meta || meta.type !== 'meta') throw new Error('Resposta inesperada da IA.');
  const cid = String(meta.conversationId);
  const mid = String(meta.messageId);
  controllers.set(mid, ac);
  // Começa a repassar os trechos só depois de quem chamou receber os ids (senão o 1º trecho se perde).
  setTimeout(() => void (async () => {
    try {
      for (;;) {
        const ev = await readEvent();
        if (!ev) break;
        if (ev.type === 'status') emit({ type: 'tool.start', conversationId: cid, taskId: null, callId: `${mid}-img`, tool: 'imagem', args: { etapa: String(ev.text) } });
        if (ev.type === 'delta') emit({ type: 'chat.delta', conversationId: cid, messageId: mid, text: String(ev.text) });
        if (ev.type === 'done') emit({ type: 'chat.done', conversationId: cid, messageId: mid, metrics: ev.metrics as never });
        if (ev.type === 'error') emit({ type: 'chat.error', conversationId: cid, messageId: mid, error: String(ev.error) });
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') emit({ type: 'chat.done', conversationId: cid, messageId: mid, metrics: { model: 'interrompido', timeToFirstTokenMs: null, totalMs: 0, promptTokens: null, completionTokens: null, tokensPerSecond: null, toolCalls: 0 } });
      else emit({ type: 'chat.error', conversationId: cid, messageId: mid, error: (e as Error).message });
    } finally {
      controllers.delete(mid);
    }
  })(), 0);
  return { conversationId: cid, messageId: mid };
}

export function cloudCancel(messageId: string) {
  controllers.get(messageId)?.abort();
}

export async function cloudConversations(): Promise<ConversationSummary[]> {
  const { data, error } = await supabase().from('jarvis_cloud_conversations').select('id,title,pinned,updated_at').order('pinned', { ascending: false }).order('updated_at', { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []).map((c) => ({ id: c.id, title: c.title, pinned: c.pinned, updatedAt: c.updated_at, origin: 'cloud' }));
}

export async function cloudConversation(id: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase().from('jarvis_cloud_messages').select('id,seq,role,content,metrics,created_at').eq('conversation_id', id).order('seq');
  if (error) throw new Error(error.message);
  return (data ?? []).map((m) => ({ id: m.id, seq: m.seq, role: m.role, content: m.content, metrics: m.metrics, createdAt: m.created_at }));
}

export async function cloudTruncate(id: string, fromSeq: number) {
  const { error } = await supabase().from('jarvis_cloud_messages').delete().eq('conversation_id', id).gte('seq', fromSeq);
  if (error) throw new Error(error.message);
}

export async function cloudDelete(id: string) {
  const { error } = await supabase().from('jarvis_cloud_conversations').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function cloudPin(id: string, pinned: boolean) {
  const { error } = await supabase().from('jarvis_cloud_conversations').update({ pinned }).eq('id', id);
  if (error) throw new Error(error.message);
}

let aiStatus: Promise<{ configured: boolean }> | null = null;
/** A conta tem chave própria (modo turbo)? Consultado uma vez por sessão. */
export function cloudAiStatus(refresh = false) {
  if (!aiStatus || refresh) aiStatus = Promise.resolve(supabase().rpc('jarvis_ai_key_status')).then(({ data }) => (data as { configured: boolean }) ?? { configured: false }, () => ({ configured: false }));
  return aiStatus;
}
