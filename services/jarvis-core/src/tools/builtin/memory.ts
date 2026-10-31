import type { Tool } from '../types.js';
import type { MemoryStore } from '../../memory/store.js';
import { MemoryCategory } from '@jarvis/contracts';

export function memoryTools(store: MemoryStore): Tool[] {
  return [
    {
      manifest: {
        name: 'memory.search', version: '1.0.0', category: 'memory', permissions: ['memory.read'], risk: 'low', reversible: true, timeoutMs: 20_000, requires: [],
        description: 'Busca nas memórias salvas (preferências, projetos, soluções, procedimentos e resumos de conversas) por significado e palavras-chave.',
        parameters: { type: 'object', properties: { query: { type: 'string' }, category: { type: 'string', enum: MemoryCategory.options }, limit: { type: 'integer', default: 6 } }, required: ['query'] },
        returns: 'Memórias relevantes com origem, data e confiança',
      },
      async run(a) {
        const r = await store.search(String(a.query), { limit: Number(a.limit ?? 6), category: a.category as never });
        return { ok: true, data: { semantic: r.semantic, results: r.results.map((m) => ({ id: m.id, category: m.category, title: m.title, content: m.content, source: m.source, confidence: m.confidence, updatedAt: m.updatedAt, score: m.score })) } };
      },
    },
    {
      manifest: {
        name: 'memory.save', version: '1.0.0', category: 'memory', permissions: ['memory.write'], risk: 'low', reversible: true, timeoutMs: 20_000, requires: [],
        description: 'Salva uma memória SOMENTE quando o usuário pedir explicitamente para lembrar algo ("lembre que...", "anote que..."). Recusa dados sensíveis.',
        parameters: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: ['personal', 'project', 'operational', 'procedural'] },
            title: { type: 'string', description: 'Título curto' }, content: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['category', 'title', 'content'],
        },
        returns: 'Memória salva com id',
      },
      async run(a, ctx) {
        const m = await store.save({ category: a.category as never, title: String(a.title), content: String(a.content), tags: (a.tags as string[]) ?? [], source: `conversa:${ctx.conversationId ?? 'n/d'}`, confidence: 0.9 });
        return { ok: true, data: { id: m.id, title: m.title, category: m.category }, undo: { tool: 'memory.forget', args: { id: m.id } } };
      },
      async verify(_a, out) {
        const id = (out.data as { id: string }).id;
        return store.get(id) ? { ok: true, detail: 'memória persistida no banco local' } : { ok: false, detail: 'memória não encontrada após salvar' };
      },
    },
    {
      manifest: {
        name: 'memory.forget', version: '1.0.0', category: 'memory', permissions: ['memory.write'], risk: 'medium', reversible: false, timeoutMs: 10_000, requires: [],
        description: 'Exclui uma memória pelo id quando o usuário pedir para esquecer algo.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        returns: 'Confirmação da exclusão',
      },
      async run(a) {
        return store.delete(String(a.id)) ? { ok: true, data: { deleted: a.id } } : { ok: false, error: 'Memória não encontrada.' };
      },
    },
  ];
}
