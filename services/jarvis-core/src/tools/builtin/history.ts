import fs from 'node:fs';
import type { Tool } from '../types.js';
import type { Conversations } from '../../brain/conversations.js';
import { newId, nowIso } from '../../util/ids.js';

export function historyTools(convs: Conversations): Tool[] {
  return [
    {
      manifest: {
        name: 'history.recent', version: '1.0.0', category: 'memory', permissions: ['memory.read'], risk: 'low', reversible: true, timeoutMs: 5_000, requires: [],
        description: 'Lista conversas de um período (ex.: ontem = daysAgo 1) com títulos e resumos. Use para "do que estávamos falando ontem?".',
        parameters: { type: 'object', properties: { daysAgo: { type: 'integer', default: 1, description: '0 = hoje, 1 = ontem…' }, spanDays: { type: 'integer', default: 1 } } },
        returns: 'Conversas do período',
      },
      async run(a) {
        const days = Number(a.daysAgo ?? 1);
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - days);
        const end = new Date(start.getTime() + Number(a.spanDays ?? 1) * 86400_000);
        const list = convs.since(start.toISOString(), end.toISOString()).map((c) => ({
          id: c.id, title: c.title, updatedAt: c.updated_at,
          summary: c.summary ?? convs.messages(c.id, 6).filter((m) => m.role !== 'tool').map((m) => `${m.role}: ${m.content.slice(0, 200)}`).join('\n'),
        }));
        return { ok: true, data: { from: start.toISOString(), to: end.toISOString(), conversations: list } };
      },
    },
    {
      manifest: {
        name: 'history.search', version: '1.0.0', category: 'memory', permissions: ['memory.read'], risk: 'low', reversible: true, timeoutMs: 5_000, requires: [],
        description: 'Pesquisa palavras em todo o histórico de conversas com o JARVIS.',
        parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', default: 15 } }, required: ['query'] },
        returns: 'Mensagens encontradas',
      },
      async run(a) {
        return { ok: true, data: convs.search(String(a.query), Number(a.limit ?? 15)).map((m) => ({ conversation: m.conversationTitle, role: m.role, at: m.createdAt, text: m.content.slice(0, 400) })) };
      },
    },
    {
      manifest: {
        name: 'projects.list', version: '1.0.0', category: 'productivity', permissions: ['memory.read'], risk: 'low', reversible: true, timeoutMs: 5_000, requires: [],
        description: 'Lista os projetos registrados do usuário com pasta, descrição e memórias de projeto associadas.',
        parameters: { type: 'object', properties: {} },
        returns: 'Projetos',
      },
      async run(_a, ctx) {
        const projects = ctx.db.all<{ id: string; name: string; path: string | null; description: string | null; updated_at: string }>('SELECT * FROM projects ORDER BY updated_at DESC');
        const mem = ctx.db.all<{ title: string; content: string; project_id: string | null }>("SELECT title, content, project_id FROM memories WHERE category = 'project' AND superseded_by IS NULL ORDER BY updated_at DESC LIMIT 30");
        return { ok: true, data: { projects: projects.map((p) => ({ ...p, notes: mem.filter((m) => m.project_id === p.id).map((m) => m.title) })), unlinkedProjectMemories: mem.filter((m) => !m.project_id) } };
      },
    },
    {
      manifest: {
        name: 'projects.register', version: '1.0.0', category: 'productivity', permissions: ['memory.write'], risk: 'low', reversible: true, timeoutMs: 5_000, requires: [],
        description: 'Registra um projeto do usuário (nome, pasta opcional dentro das autorizadas, descrição) quando ele pedir.',
        parameters: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' }, description: { type: 'string' } }, required: ['name'] },
        returns: 'Projeto registrado',
      },
      async run(a, ctx) {
        const p = a.path ? ctx.perms.resolvePath(String(a.path), 'read', ctx.origin) : null;
        if (p && !fs.existsSync(p)) return { ok: false, error: `Pasta não existe: ${p}` };
        const id = newId('proj');
        const now = nowIso();
        ctx.db.run('INSERT INTO projects (id, name, path, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, String(a.name).slice(0, 120), p, a.description ? String(a.description).slice(0, 1000) : null, now, now);
        return { ok: true, data: { id, name: a.name, path: p } };
      },
    },
  ];
}
