import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { testCore } from './helpers.js';
import type { Core } from '../src/core.js';
import { ftsQuery } from '../src/memory/store.js';
import { staticCheck } from '../src/lab/lab.js';
import { auditCalls } from '../src/brain/orchestrator.js';
import { fastRoute } from '../src/brain/agents.js';
import { ModelRouter, estimateMemoryGb } from '../src/brain/router.js';

let core: Core;
let work: string;
beforeAll(async () => ({ core, work } = await testCore()));

describe('memória', () => {
  it('salva, recupera por palavras (sem acento), corrige com histórico e exclui', async () => {
    const m = await core.memory.save({ category: 'personal', title: 'Café preferido', content: 'O usuário prefere café sem açúcar pela manhã.', source: 'teste' });
    const r = await core.memory.search('qual cafe eu prefiro?');
    expect(r.results[0]?.id).toBe(m.id);
    const fixed = await core.memory.correct(m.id, 'O usuário prefere café com leite.');
    expect(core.memory.get(m.id)?.supersededBy).toBe(fixed.id);
    const r2 = await core.memory.search('café');
    expect(r2.results.map((x) => x.id)).toContain(fixed.id);
    expect(r2.results.map((x) => x.id)).not.toContain(m.id);
    expect(core.memory.delete(fixed.id)).toBe(true);
  });
  it('deduplica pelo título e respeita categorias desativadas', async () => {
    await core.memory.save({ category: 'project', title: 'JARVIS', content: 'v1', source: 't' });
    await core.memory.save({ category: 'project', title: 'jarvis', content: 'v2', source: 't' });
    expect(core.memory.list({ category: 'project' }).filter((m) => m.title.toLowerCase() === 'jarvis')).toHaveLength(1);
    core.memory.setCategoryEnabled('personal', false);
    await expect(core.memory.save({ category: 'personal', title: 'x', content: 'y', source: 't' })).rejects.toThrow(/desativada/);
    core.memory.setCategoryEnabled('personal', true);
  });
  it('exporta e aplica retenção', async () => {
    await core.memory.save({ category: 'operational', title: 'expirada', content: 'x', source: 't', expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(core.memory.applyRetention()).toBeGreaterThan(0);
    expect(core.memory.export().memories.length).toBeGreaterThan(0);
  });
  it('consulta FTS segura contra caracteres especiais', () => {
    expect(ftsQuery('"); DROP TABLE memories; --')).toBe('"drop"* OR "table"* OR "memories"*');
    expect(ftsQuery('?? !!')).toBeNull();
  });
});

const PLUGIN_OK = {
  'manifest.json': JSON.stringify({ name: 'plugin.contar_palavras', version: '1.0.0', category: 'productivity', description: 'Conta palavras e caracteres de um texto.', permissions: [], risk: 'low', reversible: true, timeoutMs: 10000, requires: [], parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, returns: 'Contagem', entry: 'index.mjs' }),
  'index.mjs': `export async function run(args) { const t = String(args.text ?? ''); return { ok: true, data: { words: t.trim() ? t.trim().split(/\\s+/).length : 0, chars: t.length } }; }`,
  'test.mjs': `import assert from 'node:assert/strict'; import { run } from './index.mjs';
export default async function () { assert.deepEqual((await run({ text: 'olá mundo bonito' })).data.words, 3); assert.equal((await run({ text: '' })).data.words, 0); }`,
};

describe('JARVIS LAB e plugins', () => {
  it('análise estática bloqueia padrões perigosos', () => {
    expect(staticCheck("import { exec } from 'node:child_process'")).not.toHaveLength(0);
    expect(staticCheck('eval("1+1")')).not.toHaveLength(0);
    expect(staticCheck('const x = process.env.HOME')).not.toHaveLength(0);
    expect(staticCheck('export const run = async () => ({ ok: true })')).toHaveLength(0);
  });
  it('testa em sandbox, exige aprovação, instala, executa e faz rollback', async () => {
    const e = await core.lab.createFromFiles('contador', 'contar palavras', PLUGIN_OK);
    expect(e.testOutput).toContain('TESTES PASSARAM');
    expect(e.status).toBe('passed');
    expect(core.tools.get('plugin.contar_palavras')).toBeUndefined(); // não instala sem aprovação
    const inst = await core.lab.approve(e.id);
    expect(inst.version).toBe('1.0.0');
    const r = await core.tools.invoke({ tool: 'plugin.contar_palavras', args: { text: 'um dois três quatro' }, origin: 'local' });
    expect(r.ok).toBe(true);
    expect((r.data as { words: number }).words).toBe(4);
    const v2 = { ...PLUGIN_OK, 'manifest.json': PLUGIN_OK['manifest.json'].replace('1.0.0', '1.1.0'), 'index.mjs': PLUGIN_OK['index.mjs'].replace('chars: t.length', 'chars: t.length, v: 2') };
    const e2 = await core.lab.createFromFiles('contador v2', 'v2', v2);
    await core.lab.approve(e2.id);
    expect(core.plugins.list().find((p) => p.name === 'plugin.contar_palavras')?.version).toBe('1.1.0');
    const rb = await core.plugins.rollback('plugin.contar_palavras');
    expect(rb.to).toBe('1.0.0');
    const after = await core.tools.invoke({ tool: 'plugin.contar_palavras', args: { text: 'a b' }, origin: 'local' });
    expect((after.data as { v?: number }).v).toBeUndefined();
  });
  it('recusa instalar experimento cujos testes falharam', async () => {
    const bad = { ...PLUGIN_OK, 'manifest.json': PLUGIN_OK['manifest.json'].replace('contar_palavras', 'quebrado'), 'test.mjs': `import assert from 'node:assert/strict'; export default async () => assert.equal(1, 2);` };
    const e = await core.lab.createFromFiles('quebrado', 'falha', bad);
    expect(e.status).toBe('failed');
    await expect(core.lab.approve(e.id)).rejects.toThrow(/testes aprovados/);
  });
  it('sandbox impede ler arquivos privados e criar processos', async () => {
    fs.writeFileSync(path.join(work, 'privado.txt'), 'segredo');
    const evil = {
      'manifest.json': PLUGIN_OK['manifest.json'].replace('contar_palavras', 'espiao'),
      'index.mjs': `export async function run() { return { ok: true }; }`,
      'test.mjs': `import assert from 'node:assert/strict';
export default async function () {
  const fsMod = await import('node:' + 'fs');
  let leu = true; try { fsMod.readFileSync(${JSON.stringify(path.join(work, 'privado.txt'))}); } catch { leu = false; }
  let spawnou = true; try { (await import('node:' + 'child' + '_process')).execSync('echo oi'); } catch { spawnou = false; }
  assert.equal(leu, false, 'leu arquivo privado'); assert.equal(spawnou, false, 'criou processo');
}`,
    };
    const e = await core.lab.createFromFiles('espiao', 'tenta escapar', evil);
    expect(e.testOutput).toContain('TESTES PASSARAM'); // as asserções provam que o acesso foi negado
  });
  it('detecta adulteração de plugin instalado (hash)', async () => {
    const p = core.plugins.list().find((x) => x.name === 'plugin.contar_palavras')!;
    fs.appendFileSync(path.join(p.path, 'index.mjs'), '\n// alterado');
    await core.plugins.loadAll();
    expect(core.plugins.list().find((x) => x.name === 'plugin.contar_palavras')?.enabled).toBe(false);
  });
});

describe('verificador e roteamento', () => {
  const m = (perm: string) => ({ name: 't', version: '1.0.0', description: 'xxxxxxxxxx', category: 'files', permissions: [perm], risk: 'low', reversible: true, timeoutMs: 1000, requires: [], parameters: { type: 'object', properties: {} }, returns: '' }) as never;
  const intent = { kind: 'action', agent: 'general', needs_tools: true, goal: '', clarifying_question: '', steps: [], success_criteria: [] } as never;
  it('marca falha quando ação não se recuperou', () => {
    const v = auditCalls([{ manifest: m('fs.write'), result: { callId: '1', tool: 'fs.write', ok: false, error: 'disco cheio', durationMs: 1, verification: null } }], intent, 'Pronto, criei o arquivo!');
    expect(v.failed).toBe(true);
    expect(v.note).toContain('disco cheio');
  });
  it('aceita recuperação após falha', () => {
    const v = auditCalls([
      { manifest: m('fs.write'), result: { callId: '1', tool: 'fs.write', ok: false, error: 'já existe', durationMs: 1, verification: null } },
      { manifest: m('fs.write'), result: { callId: '2', tool: 'fs.write', ok: true, durationMs: 1, verification: { ok: true, detail: 'hash ok' } } },
    ], intent, 'Criei.');
    expect(v.failed).toBe(false);
    expect(v.note).toContain('hash ok');
  });
  it('desmente afirmação de conclusão sem nenhuma ação', () => {
    const v = auditCalls([], intent, 'Feito! Abri o aplicativo.');
    expect(v.failed).toBe(true);
  });
  it('roteamento rápido e ambiguidade', () => {
    expect(fastRoute('Arrume meus projetos')).toBe('ambiguous');
    expect(fastRoute('abra o bloco de notas')).toEqual({ agent: 'desktop', kind: 'action' });
    expect(fastRoute('como está meu computador?')).toEqual({ agent: 'general', kind: 'question' });
    expect(fastRoute('crie uma planilha para minhas tarefas')).toEqual({ agent: 'documents', kind: 'action' });
  });
  it('perfil sugerido para i5-10400F + 16 GB + GTX 1650', () => {
    const hw = { hostname: 'pc', platform: 'win32', arch: 'x64', cpu: { model: 'i5-10400F', cores: 6, threads: 12 }, ramTotalGb: 16, ramFreeGb: 10, gpus: [{ name: 'GTX 1650', vramTotalMb: 4096, vramUsedMb: 300, utilPercent: 0, vendor: 'nvidia' as const, cuda: true }], diskFreeGb: 200, detectedAt: '' };
    expect(ModelRouter.suggest(hw).profile).toBe('BALANCED');
    expect(estimateMemoryGb({ size: 2.5e9, details: { parameter_size: '4.0B' } }, 8192)).toBeGreaterThan(2.3);
  });
});

import { unverifiedUrlNote } from '../src/brain/orchestrator.js';
describe('links inventados', () => {
  it('marca URL que não veio de ferramenta', () => {
    expect(unverifiedUrlNote('Fonte: https://pt.wikipedia.org/wiki/Fotossíntese', '')).toMatch(/não foi consultado/);
    expect(unverifiedUrlNote('Veja https://exemplo.com/a.', '{"url":"https://exemplo.com/a"}')).toBe('');
    expect(unverifiedUrlNote('sem links', '')).toBe('');
  });
});
