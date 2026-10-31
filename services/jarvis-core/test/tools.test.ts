import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { testCore } from './helpers.js';
import type { Core } from '../src/core.js';
import { validateArgs } from '../src/tools/validate.js';

let core: Core;
let work: string;
beforeAll(async () => ({ core, work } = await testCore()));

describe('arquivos', () => {
  it('cria, verifica por hash e não sobrescreve sem permissão', async () => {
    const f = path.join(work, 'notas', 'a.txt');
    const r = await core.tools.invoke({ tool: 'fs.write', args: { path: f, content: 'olá' }, origin: 'local' });
    expect(r.ok).toBe(true);
    expect(r.verification?.ok).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('olá');
    const again = await core.tools.invoke({ tool: 'fs.write', args: { path: f, content: 'x' }, origin: 'local' });
    expect(again.ok).toBe(false);
  });
  it('sobrescrever gera backup e permite reverter', async () => {
    const f = path.join(work, 'b.txt');
    fs.writeFileSync(f, 'original');
    const r = await core.tools.invoke({ tool: 'fs.write', args: { path: f, content: 'novo', overwrite: true }, origin: 'local' });
    expect(r.ok).toBe(true);
    expect(r.undo?.tool).toBe('fs.restore');
    const undo = await core.tools.invoke({ tool: r.undo!.tool, args: r.undo!.args, origin: 'local' });
    expect(undo.ok).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('original');
  });
  it('move, lista, pesquisa e arquivos recentes', async () => {
    fs.writeFileSync(path.join(work, 'relatorio-final.md'), 'conteúdo com palavra-chave zebra');
    expect((await core.tools.invoke({ tool: 'fs.move', args: { from: path.join(work, 'relatorio-final.md'), to: path.join(work, 'docs', 'relatorio.md') }, origin: 'local' })).verification?.ok).toBe(true);
    const list = await core.tools.invoke({ tool: 'fs.list', args: { path: work, recursive: true }, origin: 'local' });
    expect(JSON.stringify(list.data)).toContain('relatorio.md');
    const s = await core.tools.invoke({ tool: 'fs.search', args: { query: 'zebra', content: true }, origin: 'local' });
    expect((s.data as { count: number }).count).toBe(1);
    const recent = await core.tools.invoke({ tool: 'fs.recent', args: { hours: 1 }, origin: 'local' });
    expect((recent.data as { count: number }).count).toBeGreaterThan(0);
  });
  it('exclusão aprovada vai para backup e pode ser restaurada', async () => {
    const f = path.join(work, 'temp.txt');
    fs.writeFileSync(f, 'conteúdo');
    const off = core.bus.onEvent((e) => e.type === 'approval.request' && core.perms.decide(e.approvalId, true, 'local'));
    const r = await core.tools.invoke({ tool: 'fs.delete', args: { path: f }, origin: 'local' });
    off();
    expect(r.ok).toBe(true);
    expect(fs.existsSync(f)).toBe(false);
    await core.tools.invoke({ tool: 'fs.restore', args: r.undo!.args, origin: 'local' });
    expect(fs.readFileSync(f, 'utf8')).toBe('conteúdo');
  });
});

describe('documentos', () => {
  it('cria planilha Excel, altera células preservando o arquivo e reabre', async () => {
    const f = path.join(work, 'tarefas.xlsx');
    const c = await core.tools.invoke({ tool: 'documents.create_spreadsheet', args: { path: f, headers: ['Tarefa', 'Prazo', 'Status'], rows: [['Estudar', '2026-11-01', 'aberta'], ['Treinar', '2026-11-02', 'aberta']] }, origin: 'local' });
    expect(c.ok).toBe(true);
    expect(c.verification?.detail).toMatch(/3 linhas/);
    const u = await core.tools.invoke({ tool: 'documents.update_spreadsheet', args: { path: f, set: { C2: 'concluída' }, appendRows: [['Ler', '2026-11-03', 'aberta']] }, origin: 'local' });
    expect(u.ok).toBe(true);
    expect(u.verification?.ok).toBe(true);
    const r = await core.tools.invoke({ tool: 'documents.read', args: { path: f }, origin: 'local' });
    const rows = (r.data as { sheets: { rows: unknown[][] }[] }).sheets[0]!.rows;
    expect(rows[1]![2]).toBe('concluída');
    expect(rows).toHaveLength(4);
  });
  it('cria e lê Word e CSV', async () => {
    const d = path.join(work, 'resumo.docx');
    const w = await core.tools.invoke({ tool: 'documents.create_word', args: { path: d, markdown: '# Relatório semanal\n- **Projeto** concluído\nTexto final importante' }, origin: 'local' });
    expect(w.verification?.ok).toBe(true);
    const r = await core.tools.invoke({ tool: 'documents.read', args: { path: d }, origin: 'local' });
    expect((r.data as { text: string }).text).toContain('Relatório semanal');
    const csv = path.join(work, 'lista.csv');
    expect((await core.tools.invoke({ tool: 'documents.create_spreadsheet', args: { path: csv, headers: ['nome', 'obs'], rows: [['Ana', 'tem, vírgula'], ['Bia', 'aspas "x"']] }, origin: 'local' })).verification?.ok).toBe(true);
    const rc = await core.tools.invoke({ tool: 'documents.read', args: { path: csv }, origin: 'local' });
    expect((rc.data as { rows: string[][] }).rows[1]![1]).toBe('tem, vírgula');
  });
});

describe('sistema e validação', () => {
  it('lê o estado real do sistema', async () => {
    const r = await core.tools.invoke({ tool: 'system.status', args: {}, origin: 'local' });
    expect(r.ok).toBe(true);
    expect((r.data as { ramTotalGb: number }).ramTotalGb).toBeGreaterThan(0);
  });
  it('valida e converte tipos de argumentos', () => {
    const schema = { type: 'object' as const, properties: { n: { type: 'integer' }, b: { type: 'boolean' }, e: { type: 'string', enum: ['a', 'b'] } }, required: ['n'] };
    expect(validateArgs(schema, { n: '5', b: 'true' })).toEqual({ ok: true, value: { n: 5, b: true } });
    expect(validateArgs(schema, { n: 'x' }).ok).toBe(false);
    expect(validateArgs(schema, { n: 1, e: 'c' }).ok).toBe(false);
  });
  it('aplicativo fora da lista não abre', async () => {
    const r = await core.tools.invoke({ tool: 'apps.launch', args: { name: 'regedit' }, origin: 'local' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/não está na lista/);
  });
  it('abre aplicativo autorizado e verifica o processo', async () => {
    core.perms.addApp('Dormir', process.platform === 'win32' ? 'timeout.exe' : '/bin/sleep', { args: process.platform === 'win32' ? ['/t', '5'] : ['5'], canClose: true });
    const r = await core.tools.invoke({ tool: 'apps.launch', args: { name: 'Dormir' }, origin: 'local' });
    expect(r.ok).toBe(true);
    expect(r.verification?.ok).toBe(true);
  });
  it('cancela operação em andamento', async () => {
    const ac = new AbortController();
    const p = core.tools.invoke({ tool: 'system.status', args: {}, origin: 'local', signal: ac.signal });
    ac.abort(new Error('cancelado pelo teste'));
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cancelado/);
  });
  it('registra toda chamada de ferramenta no histórico', () => {
    const n = core.db.get<{ n: number }>('SELECT count(*) AS n FROM tool_calls')!.n;
    expect(n).toBeGreaterThan(5);
  });
});
