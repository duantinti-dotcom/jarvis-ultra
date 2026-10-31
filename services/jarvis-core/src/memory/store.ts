import type { Memory, MemoryCategory } from '@jarvis/contracts';
import { MemoryCategory as CatEnum } from '@jarvis/contracts';
import type { Db } from '../db/index.js';
import { json, parse } from '../db/index.js';
import { newId, nowIso } from '../util/ids.js';
import { detectSensitive } from './sensitive.js';
import { logger } from '../log.js';

const log = logger('memory');

export type Embedder = { model: () => Promise<string | null>; embed: (texts: string[], kind: 'document' | 'query') => Promise<number[][]> };

type Row = {
  id: string; category: MemoryCategory; title: string; content: string; source: string; confidence: number; tags: string;
  syncable: number; project_id: string | null; superseded_by: string | null; created_at: string; updated_at: string;
  expires_at: string | null; last_accessed_at: string | null; access_count: number;
};

const toMemory = (r: Row): Memory & { projectId: string | null; supersededBy: string | null; accessCount: number } => ({
  id: r.id, category: r.category, title: r.title, content: r.content, source: r.source, confidence: r.confidence,
  tags: parse<string[]>(r.tags, []), syncable: !!r.syncable, createdAt: r.created_at, updatedAt: r.updated_at,
  expiresAt: r.expires_at, lastAccessedAt: r.last_accessed_at, projectId: r.project_id, supersededBy: r.superseded_by, accessCount: r.access_count,
});

export type SaveInput = {
  category: MemoryCategory; title: string; content: string; source: string; confidence?: number; tags?: string[];
  syncable?: boolean; projectId?: string | null; expiresAt?: string | null; allowSensitive?: boolean;
};

export class MemoryStore {
  constructor(private db: Db, private embedder: Embedder | null = null) {}

  setEmbedder(e: Embedder) {
    this.embedder = e;
  }

  disabledCategories(): MemoryCategory[] {
    return this.db.getSetting<MemoryCategory[]>('memory.disabled', []);
  }
  setCategoryEnabled(cat: MemoryCategory, enabled: boolean) {
    const cur = new Set(this.disabledCategories());
    if (enabled) cur.delete(cat);
    else cur.add(cat);
    this.db.setSetting('memory.disabled', [...cur]);
  }

  async save(input: SaveInput) {
    CatEnum.parse(input.category);
    if (this.disabledCategories().includes(input.category)) throw new Error(`A categoria de memória "${input.category}" está desativada.`);
    const sensitive = detectSensitive(`${input.title}\n${input.content}`);
    if (sensitive.length && !input.allowSensitive) throw new Error(`Não salvei: o conteúdo parece conter dados sensíveis (${sensitive.join(', ')}).`);
    const title = input.title.trim().slice(0, 200);
    const content = input.content.trim().slice(0, 8000);
    if (!title || !content) throw new Error('Memória vazia.');
    // Deduplicação: mesmo título e categoria atualiza a memória existente.
    const dup = this.db.get<Row>('SELECT * FROM memories WHERE category = ? AND lower(title) = lower(?) AND superseded_by IS NULL', input.category, title);
    const now = nowIso();
    let id: string;
    if (dup) {
      id = dup.id;
      this.db.run('UPDATE memories SET content = ?, source = ?, confidence = ?, tags = ?, updated_at = ? WHERE id = ?', content, input.source, input.confidence ?? 1, json(input.tags ?? []), now, id);
    } else {
      id = newId('mem');
      this.db.run(
        'INSERT INTO memories (id, category, title, content, source, confidence, tags, syncable, project_id, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, input.category, title, content, input.source, input.confidence ?? 1, json(input.tags ?? []), input.syncable ? 1 : 0, input.projectId ?? null, now, now, input.expiresAt ?? null,
      );
    }
    await this.indexEmbedding(id, `${title}\n${content}`).catch((e) => log.warn(`embedding indisponível: ${(e as Error).message}`));
    return this.get(id)!;
  }

  private async indexEmbedding(id: string, text: string) {
    if (!this.embedder) return;
    const model = await this.embedder.model();
    if (!model) return;
    const [vec] = await this.embedder.embed([text], 'document');
    if (!vec) return;
    const buf = new Uint8Array(new Float32Array(vec).buffer);
    this.db.run('INSERT INTO memory_embeddings (memory_id, model, dim, vector) VALUES (?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vector = excluded.vector', id, model, vec.length, buf);
  }

  /** Reindexa memórias sem embedding (ex.: após instalar o modelo de embeddings). */
  async reindex() {
    const rows = this.db.all<Row>('SELECT m.* FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id = m.id WHERE e.memory_id IS NULL');
    for (const r of rows) await this.indexEmbedding(r.id, `${r.title}\n${r.content}`);
    return rows.length;
  }

  get(id: string) {
    const r = this.db.get<Row>('SELECT * FROM memories WHERE id = ?', id);
    return r ? toMemory(r) : null;
  }

  list(opts: { category?: MemoryCategory; limit?: number; includeSuperseded?: boolean; syncableOnly?: boolean } = {}) {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.category) { where.push('category = ?'); params.push(opts.category); }
    if (!opts.includeSuperseded) where.push('superseded_by IS NULL');
    if (opts.syncableOnly) where.push('syncable = 1');
    const sql = `SELECT * FROM memories ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`;
    return this.db.all<Row>(sql, ...params, opts.limit ?? 200).map(toMemory);
  }

  /** Busca híbrida: FTS5 (BM25) + similaridade de cosseno quando há embeddings. */
  async search(query: string, opts: { limit?: number; category?: MemoryCategory; minScore?: number; semantic?: boolean; semanticBudgetMs?: number } = {}) {
    const limit = opts.limit ?? 6;
    const scores = new Map<string, { lex: number; sem: number }>();
    const fts = ftsQuery(query);
    if (fts) {
      const rows = this.db.all<{ id: string; rank: number }>(
        `SELECT m.id, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.superseded_by IS NULL ${opts.category ? 'AND m.category = ?' : ''} ORDER BY rank LIMIT 30`,
        ...(opts.category ? [fts, opts.category] : [fts]),
      );
      const best = rows.length ? Math.min(...rows.map((r) => r.rank)) : 0;
      for (const r of rows) scores.set(r.id, { lex: best ? r.rank / best : 1, sem: 0 });
    }
    let semantic = false;
    if (this.embedder && opts.semantic !== false) {
      try {
        const model = await this.embedder.model();
        if (model) {
          // Nunca segura a resposta esperando o modelo de embeddings carregar:
          // passado o limite, segue só com a busca por palavras (FTS).
          const budget = opts.semanticBudgetMs ?? 1500;
          const [q] = await Promise.race([
            this.embedder.embed([query], 'query'),
            new Promise<number[][]>((_, rej) => setTimeout(() => rej(new Error(`embeddings excederam ${budget} ms`)), budget)),
          ]);
          if (q) {
            semantic = true;
            const rows = this.db.all<{ memory_id: string; vector: Uint8Array; dim: number }>(
              `SELECT e.memory_id, e.vector, e.dim FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id WHERE e.model = ? AND m.superseded_by IS NULL ${opts.category ? 'AND m.category = ?' : ''}`,
              ...(opts.category ? [model, opts.category] : [model]),
            );
            for (const r of rows) {
              const v = new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.dim * 4));
              const sim = cosine(q, v);
              const cur = scores.get(r.memory_id) ?? { lex: 0, sem: 0 };
              cur.sem = sim;
              scores.set(r.memory_id, cur);
            }
          }
        }
      } catch (e) {
        log.warn(`busca semântica indisponível: ${(e as Error).message}`);
      }
    }
    const minScore = opts.minScore ?? (semantic ? 0.45 : 0.01);
    const ranked = [...scores.entries()]
      .map(([id, s]) => ({ id, score: semantic ? 0.65 * s.sem + 0.35 * s.lex : s.lex, ...s }))
      .filter((r) => (semantic ? r.sem >= minScore || r.lex > 0.5 : r.score >= minScore))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    const now = nowIso();
    const out = ranked.map((r) => {
      this.db.run('UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?', now, r.id);
      return { ...this.get(r.id)!, score: Math.round(r.score * 1000) / 1000 };
    }).filter((m) => !m.expiresAt || m.expiresAt > now);
    return { semantic, results: out };
  }

  /** Corrige uma memória mantendo histórico: a antiga fica marcada como substituída. */
  async correct(id: string, content: string, source = 'usuario') {
    const old = this.get(id);
    if (!old) throw new Error('Memória não encontrada.');
    const nid = newId('mem');
    const now = nowIso();
    this.db.tx(() => {
      // Renomeia o título antigo para liberar a chave de deduplicação.
      this.db.run('INSERT INTO memories (id, category, title, content, source, confidence, tags, syncable, project_id, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        nid, old.category, old.title, content, source, 1, json(old.tags), old.syncable ? 1 : 0, old.projectId, now, now, old.expiresAt);
      this.db.run('UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?', nid, now, id);
    });
    await this.indexEmbedding(nid, `${old.title}\n${content}`).catch(() => {});
    return this.get(nid)!;
  }

  update(id: string, patch: Partial<Pick<Memory, 'title' | 'content' | 'tags' | 'syncable' | 'confidence' | 'expiresAt' | 'category'>>) {
    const cur = this.get(id);
    if (!cur) throw new Error('Memória não encontrada.');
    const n = { ...cur, ...patch };
    this.db.run('UPDATE memories SET title = ?, content = ?, tags = ?, syncable = ?, confidence = ?, expires_at = ?, category = ?, updated_at = ? WHERE id = ?',
      n.title, n.content, json(n.tags), n.syncable ? 1 : 0, n.confidence, n.expiresAt, n.category, nowIso(), id);
    void this.indexEmbedding(id, `${n.title}\n${n.content}`).catch(() => {});
    return this.get(id)!;
  }

  delete(id: string) {
    return this.db.run('DELETE FROM memories WHERE id = ?', id).changes > 0;
  }

  /** Remove memórias expiradas e episódicas mais antigas que a retenção configurada. */
  applyRetention() {
    const days = this.db.getSetting<number>('memory.episodicRetentionDays', 180);
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    const a = this.db.run("DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?", nowIso()).changes;
    const b = this.db.run("DELETE FROM memories WHERE category = 'episodic' AND updated_at < ?", cutoff).changes;
    return Number(a) + Number(b);
  }

  /** Memórias não acessadas há muito tempo e com baixa confiança são candidatas a revisão. */
  stale(days = 90) {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    return this.db.all<Row>("SELECT * FROM memories WHERE superseded_by IS NULL AND (confidence < 0.6 OR coalesce(last_accessed_at, updated_at) < ?) ORDER BY updated_at LIMIT 50", cutoff).map(toMemory);
  }

  export() {
    return { exportedAt: nowIso(), version: 1, memories: this.list({ limit: 100_000, includeSuperseded: true }) };
  }
}

/** Converte texto livre em consulta FTS5 segura (OR entre termos relevantes, com prefixo). */
export function ftsQuery(q: string): string | null {
  const stop = new Set(['de', 'da', 'do', 'das', 'dos', 'que', 'e', 'o', 'a', 'os', 'as', 'um', 'uma', 'para', 'com', 'em', 'no', 'na', 'meu', 'minha', 'qual', 'quais', 'sobre', 'the', 'is', 'of', 'eu', 'voce', 'você', 'estava', 'estavamos', 'estávamos', 'falando']);
  const terms = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]{2,}/gu)?.filter((t) => !stop.has(t)) ?? [];
  if (!terms.length) return null;
  return [...new Set(terms)].slice(0, 12).map((t) => `"${t}"*`).join(' OR ');
}

export function cosine(a: number[], b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
