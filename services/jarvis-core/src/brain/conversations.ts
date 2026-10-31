import type { Db } from '../db/index.js';
import { json, parse } from '../db/index.js';
import { newId, nowIso } from '../util/ids.js';

export type StoredMessage = { id: string; conversationId: string; seq: number; role: 'user' | 'assistant' | 'tool' | 'system'; content: string; toolCalls: unknown; toolName: string | null; metrics: unknown; origin: string; createdAt: string };
type Row = { id: string; conversation_id: string; seq: number; role: StoredMessage['role']; content: string; tool_calls: string | null; tool_name: string | null; metrics: string | null; origin: string; created_at: string };
const toMsg = (r: Row): StoredMessage => ({ id: r.id, conversationId: r.conversation_id, seq: r.seq, role: r.role, content: r.content, toolCalls: parse(r.tool_calls, null), toolName: r.tool_name, metrics: parse(r.metrics, null), origin: r.origin, createdAt: r.created_at });

export class Conversations {
  constructor(private db: Db) {}

  ensure(id: string | null, firstText: string, origin: string, projectId: string | null = null): string {
    if (id && this.db.get('SELECT 1 FROM conversations WHERE id = ?', id)) return id;
    const nid = id && /^[A-Za-z0-9_-]{6,64}$/.test(id) ? id : newId('conv');
    const title = firstText.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Nova conversa';
    const now = nowIso();
    this.db.run('INSERT INTO conversations (id, title, project_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', nid, title, projectId, origin, now, now);
    return nid;
  }

  add(conversationId: string, m: { role: StoredMessage['role']; content: string; toolCalls?: unknown; toolName?: string | null; metrics?: unknown; origin?: string; id?: string }) {
    const seq = (this.db.get<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM messages WHERE conversation_id = ?', conversationId)?.n ?? 1);
    const id = m.id ?? newId('msg');
    const now = nowIso();
    this.db.run('INSERT INTO messages (id, conversation_id, seq, role, content, tool_calls, tool_name, metrics, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, conversationId, seq, m.role, m.content, m.toolCalls ? json(m.toolCalls) : null, m.toolName ?? null, m.metrics ? json(m.metrics) : null, m.origin ?? 'local', now);
    this.db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', now, conversationId);
    return id;
  }

  messages(conversationId: string, limit = 500): StoredMessage[] {
    return this.db.all<Row>('SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq', conversationId, limit).map(toMsg);
  }

  list(limit = 100) {
    return this.db.all<{ id: string; title: string; project_id: string | null; origin: string; created_at: string; updated_at: string; count: number }>(
      'SELECT c.*, (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS count FROM conversations c ORDER BY updated_at DESC LIMIT ?', limit,
    ).map((c) => ({ id: c.id, title: c.title, projectId: c.project_id, origin: c.origin, createdAt: c.created_at, updatedAt: c.updated_at, messageCount: c.count }));
  }

  get(id: string) {
    return this.db.get<{ id: string; title: string; summary: string | null; summarized_upto: number; project_id: string | null }>('SELECT * FROM conversations WHERE id = ?', id);
  }

  rename(id: string, title: string) {
    this.db.run('UPDATE conversations SET title = ? WHERE id = ?', title.slice(0, 120), id);
  }

  delete(id: string) {
    this.db.run('DELETE FROM conversations WHERE id = ?', id);
  }

  setSummary(id: string, summary: string, upto: number) {
    this.db.run('UPDATE conversations SET summary = ?, summarized_upto = ? WHERE id = ?', summary, upto, id);
  }

  /** Busca em todo o histórico de conversas (FTS5). */
  search(q: string, limit = 30) {
    const terms = q.normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]{2,}/gu);
    if (!terms) return [];
    const fts = terms.map((t) => `"${t}"*`).join(' AND ');
    return this.db.all<Row & { title: string }>(
      `SELECT m.*, c.title FROM messages_fts f JOIN messages m ON m.rowid = f.rowid JOIN conversations c ON c.id = m.conversation_id WHERE messages_fts MATCH ? AND m.role IN ('user','assistant') ORDER BY m.created_at DESC LIMIT ?`, fts, limit,
    ).map((r) => ({ ...toMsg(r), conversationTitle: r.title }));
  }

  /** Conversas recentes para "do que estávamos falando ontem?". */
  since(isoFrom: string, isoTo: string) {
    return this.db.all<{ id: string; title: string; summary: string | null; updated_at: string }>('SELECT id, title, summary, updated_at FROM conversations WHERE updated_at BETWEEN ? AND ? ORDER BY updated_at DESC LIMIT 20', isoFrom, isoTo);
  }
}
