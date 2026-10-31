import type { ChatMessage } from './ollama.js';
import type { Conversations } from './conversations.js';

/** Estimativa de tokens sem tokenizer (pt-BR ≈ 3,6 caracteres por token). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.6);

/**
 * Monta o histórico respeitando o orçamento de contexto: resumo incremental das
 * mensagens antigas + as mais recentes que couberem.
 */
export function buildHistory(convs: Conversations, conversationId: string, budgetTokens: number): { messages: ChatMessage[]; needsSummary: boolean; oldestIncludedSeq: number } {
  const conv = convs.get(conversationId);
  const all = convs.messages(conversationId, 200).filter((m) => m.role === 'user' || m.role === 'assistant');
  const out: ChatMessage[] = [];
  let used = 0;
  let oldest = Number.MAX_SAFE_INTEGER;
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]!;
    if (conv && m.seq <= conv.summarized_upto) break;
    const t = estimateTokens(m.content);
    if (used + t > budgetTokens && out.length >= 2) break;
    out.unshift({ role: m.role as 'user' | 'assistant', content: m.content.length > 6000 ? m.content.slice(0, 6000) + '…' : m.content });
    used += t;
    oldest = m.seq;
  }
  if (conv?.summary) out.unshift({ role: 'system', content: `Resumo da conversa até aqui:\n${conv.summary}` });
  const unsummarized = all.filter((m) => !conv || m.seq > conv.summarized_upto);
  const needsSummary = unsummarized.reduce((s, m) => s + estimateTokens(m.content), 0) > budgetTokens * 1.2 && unsummarized.length > 8;
  return { messages: out, needsSummary, oldestIncludedSeq: oldest };
}
