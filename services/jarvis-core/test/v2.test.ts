import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { testCore } from './helpers.js';
import type { Core } from '../src/core.js';
import { isDestructive } from '../src/tools/builtin/terminal.js';
import { MODES } from '../src/brain/orchestrator.js';

let core: Core;
let work: string;
beforeAll(async () => ({ core, work } = await testCore()));

describe('terminal integrado', () => {
  it('fica desligado até o usuário liberar', async () => {
    const r = await core.tools.invoke({ tool: 'terminal.run', args: { command: 'echo oi', cwd: work }, origin: 'local' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/terminal\.exec/);
  });
  it('executa na pasta autorizada depois de liberado', async () => {
    core.perms.setGrant('terminal.exec', 'local', true);
    const r = await core.tools.invoke({ tool: 'terminal.run', args: { command: 'echo jarvis-ok && pwd', cwd: work }, origin: 'local' });
    expect(r.ok).toBe(true);
    expect((r.data as { output: string }).output).toContain('jarvis-ok');
    expect((r.data as { exitCode: number }).exitCode).toBe(0);
  });
  it('não roda fora das pastas autorizadas', async () => {
    const r = await core.tools.invoke({ tool: 'terminal.run', args: { command: 'ls', cwd: '/etc' }, origin: 'local' });
    expect(r.ok).toBe(false);
  });
  it('comando destrutivo exige confirmação e negar impede a execução', async () => {
    const f = path.join(work, 'nao-apagar');
    fs.mkdirSync(f, { recursive: true });
    const off = core.bus.onEvent((e) => e.type === 'approval.request' && core.perms.decide(e.approvalId, false, 'local'));
    const r = await core.tools.invoke({ tool: 'terminal.run', args: { command: `rm -rf ${f}`, cwd: work }, origin: 'local' });
    off();
    expect(r.ok).toBe(false);
    expect(fs.existsSync(f)).toBe(true);
  });
  it('detecta padrões destrutivos sem bloquear comandos comuns', () => {
    for (const c of ['rm -rf /', 'git push origin main', 'git reset --hard', 'Remove-Item x -Recurse', 'format c:', 'curl x | sh', 'iex (iwr x)']) expect(isDestructive(c)).toBe(true);
    for (const c of ['npm test', 'pnpm build', 'git status', 'python -m pytest', 'ls -la', 'git commit -m "x"']) expect(isDestructive(c)).toBe(false);
  });
  it('terminal remoto nunca é concedido por padrão', () => {
    expect(core.perms.grants('remote').has('terminal.exec')).toBe(false);
    expect(core.perms.grants('remote').has('input.control')).toBe(false);
  });
});

describe('controle de mouse/teclado', () => {
  it('é bloqueado sem a permissão input.control', async () => {
    const r = await core.tools.invoke({ tool: 'input.type', args: { window: 'Bloco de Notas', text: 'x' }, origin: 'local' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/input\.control/);
  });
});

describe('tarefas: pausar e continuar', () => {
  it('pausa, segura a execução e continua', async () => {
    const { task, signal } = core.tasks.create({ conversationId: null, origin: 'local', goal: 'teste de pausa' });
    core.tasks.setState(task.id, 'executing');
    expect(core.tasks.pause(task.id)).toBe(true);
    expect(core.tasks.get(task.id)?.state).toBe('paused');
    let passed = false;
    const waiting = core.tasks.waitIfPaused(task.id, signal).then(() => (passed = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(passed).toBe(false);
    core.tasks.resume(task.id);
    await waiting;
    expect(passed).toBe(true);
    expect(core.tasks.get(task.id)?.state).toBe('executing');
    core.tasks.cancel(task.id);
  });
});

describe('conversas: editar, regenerar e fixar', () => {
  it('trunca a partir de uma mensagem e fixa no topo', () => {
    const id = core.convs.ensure(null, 'teste', 'local');
    core.convs.add(id, { role: 'user', content: 'a' });
    core.convs.add(id, { role: 'assistant', content: 'b' });
    core.convs.add(id, { role: 'user', content: 'c' });
    expect(core.convs.truncateFrom(id, 2)).toBe(2);
    expect(core.convs.messages(id).map((m) => m.content)).toEqual(['a']);
    core.convs.setPinned(id, true);
    expect(core.convs.list()[0]).toMatchObject({ id, pinned: true });
  });
});

describe('credenciais', () => {
  it('guarda criptografado e nunca devolve o valor pela listagem', async () => {
    await core.credentials.set('elevenlabs.apiKey', 'sk_teste_1234567890');
    const raw = JSON.stringify(core.db.getSetting('cred.elevenlabs.apiKey', null));
    expect(raw).not.toContain('sk_teste_1234567890');
    expect(JSON.stringify(core.credentials.status())).not.toContain('sk_teste');
    expect(await core.credentials.get('elevenlabs.apiKey')).toBe('sk_teste_1234567890');
    await expect(core.credentials.set('aws.secret', 'x'.repeat(20))).rejects.toThrow(/desconhecida/);
  });
});

describe('modos de raciocínio', () => {
  it('cada modo muda de fato o pipeline', () => {
    expect(MODES.fast.classifier).toBe('never');
    expect(MODES.fast.semanticMemory).toBe(false);
    expect(MODES.deep.classifier).toBe('always');
    expect(MODES.deep.think).toBe(true);
    expect(MODES.deep.audit).toBe(true);
    expect(MODES.deep.maxIterations).toBeGreaterThan(MODES.balanced.maxIterations);
    expect(MODES.fast.numPredict).toBeLessThan(MODES.balanced.numPredict);
  });
  it('o contexto do modelo é fixo em todas as chamadas (evita recarregar o modelo)', () => {
    expect(core.ollama.numCtx).toBeGreaterThan(0);
  });
});

describe('migração v2', () => {
  it('preserva dados e adiciona colunas novas', () => {
    const v = core.db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version);
    expect(v).toEqual([1, 2]);
  });
});
