import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { json, parse } from '../db/index.js';
import type { Bus } from '../bus.js';
import type { OllamaClient } from '../brain/ollama.js';
import type { ModelRouter } from '../brain/router.js';
import type { LlmQueue } from '../brain/llmqueue.js';
import type { PluginManager, PluginManifest } from '../plugins/manager.js';
import { validatePluginManifest } from '../plugins/manager.js';
import { runSandboxed } from '../plugins/sandbox.js';
import type { CoreConfig } from '../config.js';
import type { Tool } from '../tools/types.js';
import { lineDiff } from './diff.js';
import { newId, nowIso } from '../util/ids.js';
import { logger } from '../log.js';

const log = logger('lab');

export type ExperimentStatus = 'generating' | 'testing' | 'passed' | 'failed' | 'installed' | 'rejected';
export type Experiment = {
  id: string; title: string; problem: string; proposal: string | null; kind: string; status: ExperimentStatus; workspace: string;
  files: Record<string, string>; testOutput: string | null; testPassed: boolean | null; report: string | null; diff: string | null; createdAt: string; updatedAt: string;
};

type Row = { id: string; title: string; problem: string; proposal: string | null; kind: string; status: ExperimentStatus; workspace: string; files: string; test_output: string | null; test_passed: number | null; report: string | null; diff: string | null; created_at: string; updated_at: string };
const toExp = (r: Row): Experiment => ({ id: r.id, title: r.title, problem: r.problem, proposal: r.proposal, kind: r.kind, status: r.status, workspace: r.workspace, files: parse(r.files, {}), testOutput: r.test_output, testPassed: r.test_passed == null ? null : !!r.test_passed, report: r.report, diff: r.diff, createdAt: r.created_at, updatedAt: r.updated_at });

const GEN_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'plugin.nome_em_snake_case' },
    description: { type: 'string' },
    parameters: { type: 'object' },
    required: { type: 'array', items: { type: 'string' } },
    permissions: { type: 'array', items: { type: 'string', enum: ['fs.read', 'fs.write', 'net.fetch', 'memory.read', 'system.read'] } },
    code: { type: 'string', description: 'Conteúdo de index.mjs' },
    test: { type: 'string', description: 'Conteúdo de test.mjs' },
  },
  required: ['name', 'description', 'parameters', 'required', 'permissions', 'code', 'test'],
};

const GEN_RULES = `Você escreve plugins para o JARVIS ULTRA. Regras obrigatórias:
- index.mjs é um módulo ES que exporta: export async function run(args, api) { ... return { ok: true, data } } ou { ok: false, error }.
- Use apenas JavaScript puro e módulos nativos seguros (node:crypto, node:util, node:path). PROIBIDO: node:child_process, node:fs direto, eval, Function, require, process.env, import dinâmico de URLs.
- Para acessar arquivos ou rede use api.call('fs.read' | 'fs.list' | 'web.fetch', args), que retorna { ok, data, error } e passa pelo sistema de permissões.
- test.mjs exporta default async function que importa { run } de './index.mjs' e usa node:assert/strict para testar casos normais e de erro (sem api, ou com um api falso). Os testes devem ser determinísticos e não acessar rede.
- parameters: objeto JSON Schema "properties" (nome → {type, description}).`;

/** Padrões de código recusados antes mesmo de executar no sandbox. */
const FORBIDDEN = [/child_process/, /\beval\s*\(/, /new\s+Function\s*\(/, /\brequire\s*\(/, /process\.env/, /node:fs/, /\bfrom\s+['"]fs['"]/, /node:worker_threads/, /node:net\b/, /node:vm\b/, /process\.binding/, /import\s*\(\s*['"]https?:/];

export function staticCheck(code: string): string[] {
  return FORBIDDEN.filter((r) => r.test(code)).map((r) => `padrão proibido: ${r.source}`);
}

export class Lab {
  constructor(private db: Db, private bus: Bus, private ollama: OllamaClient, private router: ModelRouter, private queue: LlmQueue, private plugins: PluginManager, private config: CoreConfig) {}

  list(): Experiment[] {
    return this.db.all<Row>('SELECT * FROM lab_experiments ORDER BY updated_at DESC LIMIT 100').map(toExp);
  }
  get(id: string): Experiment | null {
    const r = this.db.get<Row>('SELECT * FROM lab_experiments WHERE id = ?', id);
    return r ? toExp(r) : null;
  }

  private save(e: Experiment) {
    this.db.run(
      `INSERT INTO lab_experiments (id, title, problem, proposal, kind, status, workspace, files, test_output, test_passed, report, diff, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, proposal = excluded.proposal, status = excluded.status,
       files = excluded.files, test_output = excluded.test_output, test_passed = excluded.test_passed, report = excluded.report, diff = excluded.diff, updated_at = excluded.updated_at`,
      e.id, e.title, e.problem, e.proposal, e.kind, e.status, e.workspace, json(e.files), e.testOutput, e.testPassed == null ? null : e.testPassed ? 1 : 0, e.report, e.diff, e.createdAt, nowIso(),
    );
    this.bus.emitEvent({ type: 'log', level: 'info', message: `lab:${e.id}:${e.status}` });
  }

  /** Cria um experimento a partir de arquivos fornecidos (editor do LAB) ou gerados. */
  async createFromFiles(title: string, problem: string, files: Record<string, string>): Promise<Experiment> {
    const id = newId('lab');
    const workspace = path.join(this.config.labDir, id);
    await fsp.mkdir(workspace, { recursive: true });
    const e: Experiment = { id, title, problem, proposal: null, kind: 'tool', status: 'testing', workspace, files, testOutput: null, testPassed: null, report: null, diff: null, createdAt: nowIso(), updatedAt: nowIso() };
    this.save(e);
    return this.test(id);
  }

  /** Gera um plugin com o modelo local, testa no sandbox e tenta corrigir até 2 vezes. */
  async generate(problem: string, signal?: AbortSignal): Promise<Experiment> {
    const id = newId('lab');
    const workspace = path.join(this.config.labDir, id);
    await fsp.mkdir(workspace, { recursive: true });
    let e: Experiment = { id, title: problem.slice(0, 80), problem, proposal: null, kind: 'tool', status: 'generating', workspace, files: {}, testOutput: null, testPassed: null, report: null, diff: null, createdAt: nowIso(), updatedAt: nowIso() };
    this.save(e);
    const pick = (await this.router.pick('code')) ?? (await this.router.pick('tools'));
    if (!pick) {
      e.status = 'failed';
      e.report = 'Nenhum modelo local disponível para gerar código.';
      this.save(e);
      return e;
    }
    let feedback = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await this.queue.run('background', () => this.ollama.chat({
        model: pick.model, format: GEN_SCHEMA, signal, options: { temperature: 0.2, num_ctx: 8192, num_predict: 2500 },
        messages: [{ role: 'system', content: GEN_RULES }, { role: 'user', content: `Crie um plugin para: ${problem}${feedback}` }],
      }), signal);
      let gen: { name: string; description: string; parameters: Record<string, unknown>; required: string[]; permissions: string[]; code: string; test: string };
      try {
        gen = JSON.parse(r.message.content);
      } catch {
        feedback = '\n\nA resposta anterior não era JSON válido. Responda somente com o JSON pedido.';
        continue;
      }
      const name = gen.name.startsWith('plugin.') ? gen.name : `plugin.${gen.name}`;
      const manifest: PluginManifest = {
        name: name.toLowerCase().replace(/[^a-z0-9_.]/g, '_').slice(0, 60), version: '1.0.0', category: 'productivity',
        description: (gen.description || problem).slice(0, 590).padEnd(10, '.'), permissions: (gen.permissions ?? []) as PluginManifest['permissions'],
        risk: (gen.permissions ?? []).some((p) => p.endsWith('.write')) ? 'medium' : 'low', reversible: true, timeoutMs: 20_000, requires: [],
        parameters: { type: 'object', properties: normalizeProps(gen.parameters), required: gen.required ?? [] },
        returns: 'Resultado do plugin', entry: 'index.mjs', author: `jarvis-lab:${pick.model}`,
      };
      e.files = { 'manifest.json': JSON.stringify(manifest, null, 2), 'index.mjs': gen.code, 'test.mjs': gen.test };
      e.title = manifest.name;
      e.proposal = `Modelo ${pick.model}, tentativa ${attempt}`;
      this.save(e);
      e = await this.test(e.id);
      if (e.testPassed) break;
      feedback = `\n\nA tentativa anterior falhou nos testes/validação:\n${(e.testOutput ?? '').slice(-2500)}\nCorrija o código e os testes.`;
    }
    return e;
  }

  async updateFiles(id: string, files: Record<string, string>) {
    const e = this.get(id);
    if (!e) throw new Error('Experimento não encontrado.');
    if (e.status === 'installed') throw new Error('Experimento já instalado: crie um novo para outra versão.');
    const before = Object.entries(e.files).map(([k, v]) => `### ${k}\n${v}`).join('\n');
    e.files = { ...e.files, ...files };
    e.diff = lineDiff(before, Object.entries(e.files).map(([k, v]) => `### ${k}\n${v}`).join('\n'));
    e.status = 'testing';
    this.save(e);
    return this.test(id);
  }

  /** Validação estática + execução dos testes no sandbox, sem acesso a dados privados. */
  async test(id: string): Promise<Experiment> {
    const e = this.get(id)!;
    e.status = 'testing';
    this.save(e);
    const out: string[] = [];
    let passed = false;
    try {
      for (const [f, c] of Object.entries(e.files)) {
        if (!/^[a-z0-9_.-]+\.(mjs|json|md)$/i.test(f)) throw new Error(`Nome de arquivo não permitido: ${f}`);
        await fsp.writeFile(path.join(e.workspace, f), c);
      }
      const manifest = JSON.parse(e.files['manifest.json'] ?? '{}') as PluginManifest;
      validatePluginManifest(manifest);
      out.push(`✓ manifesto válido (${manifest.name}@${manifest.version}, permissões: ${manifest.permissions.join(', ') || 'nenhuma'})`);
      const problems = [...staticCheck(e.files['index.mjs'] ?? ''), ...staticCheck(e.files['test.mjs'] ?? '')];
      if (problems.length) throw new Error(`Análise estática reprovou: ${problems.join('; ')}`);
      out.push('✓ análise estática sem padrões proibidos');
      if (!e.files['test.mjs']) throw new Error('test.mjs ausente: plugins precisam de testes.');
      const tmp = path.join(e.workspace, '.tmp');
      await fsp.mkdir(tmp, { recursive: true });
      const r = await runSandboxed({ runner: this.plugins.runner, entry: path.join(e.workspace, 'test.mjs'), readDirs: [e.workspace], writeDirs: [tmp], mode: 'test', timeoutMs: 30_000, memoryMb: 128 });
      out.push(`sandbox: exit=${r.exitCode} tempo=${r.durationMs}ms${r.timedOut ? ' (TEMPO ESGOTADO)' : ''}`);
      if (r.logs.length) out.push('logs:\n' + r.logs.join('\n'));
      if (r.result?.error) out.push('erro:\n' + r.result.error);
      if (r.stderr.trim()) out.push('stderr:\n' + r.stderr.trim());
      passed = r.ok;
      out.push(passed ? '✓ TESTES PASSARAM' : '✗ TESTES FALHARAM');
    } catch (err) {
      out.push(`✗ ${(err as Error).message}`);
    }
    e.testOutput = out.join('\n');
    e.testPassed = passed;
    e.status = passed ? 'passed' : 'failed';
    e.report = passed
      ? `Ferramenta candidata pronta. Testes isolados passaram. A instalação só ocorre após sua aprovação na interface do LAB.`
      : 'Os testes não passaram. Revise o código no editor do LAB ou peça nova geração.';
    this.save(e);
    log.info(`experimento ${id}: ${e.status}`);
    return e;
  }

  /** Aprovação humana obrigatória: este método só é exposto pela API local autenticada. */
  async approve(id: string) {
    const e = this.get(id);
    if (!e) throw new Error('Experimento não encontrado.');
    if (e.status !== 'passed') throw new Error('Somente experimentos com testes aprovados podem ser instalados.');
    const re = await this.test(id);
    if (!re.testPassed) throw new Error('Os testes falharam na verificação final; instalação cancelada.');
    const installed = await this.plugins.install(e.workspace, { experimentId: id });
    re.status = 'installed';
    re.report = `${re.report}\nInstalado como ${installed.name}@${installed.version} (sha256 ${installed.sha256.slice(0, 12)}…).`;
    this.save(re);
    return installed;
  }

  reject(id: string) {
    const e = this.get(id);
    if (!e) throw new Error('Experimento não encontrado.');
    e.status = 'rejected';
    this.save(e);
    return e;
  }
}

function normalizeProps(p: Record<string, unknown>): Record<string, { type: string; description?: string }> {
  const src = (p && typeof p === 'object' && 'properties' in p ? (p as { properties: Record<string, unknown> }).properties : p) ?? {};
  const out: Record<string, { type: string; description?: string }> = {};
  for (const [k, v] of Object.entries(src)) {
    const o = (v ?? {}) as { type?: string; description?: string };
    out[k] = { type: ['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(o.type ?? '') ? o.type! : 'string', ...(o.description ? { description: String(o.description) } : {}) };
  }
  return out;
}

/** Ferramenta para o modelo: propõe uma ferramenta nova. Nunca instala. */
export function labTools(lab: Lab): Tool[] {
  return [{
    manifest: {
      name: 'lab.propose_tool', version: '1.0.0', category: 'programming', permissions: ['lab.execute'], risk: 'medium', reversible: true, timeoutMs: 600_000, requires: [],
      description: 'Pede ao JARVIS LAB para gerar uma nova ferramenta (plugin), testá-la em sandbox isolado e deixá-la aguardando aprovação do usuário. Não instala nada.',
      parameters: { type: 'object', properties: { problem: { type: 'string', description: 'O que a ferramenta deve fazer, com exemplos de entrada/saída' } }, required: ['problem'] },
      returns: 'Experimento com resultado dos testes',
    },
    async run(a, ctx) {
      const e = await lab.generate(String(a.problem), ctx.signal);
      return { ok: e.status === 'passed', data: { experimentId: e.id, name: e.title, status: e.status, testsPassed: e.testPassed, testOutput: e.testOutput?.slice(-1500), next: 'Aprovação necessária no JARVIS LAB para instalar.' }, error: e.status === 'passed' ? undefined : `Testes não passaram: ${e.testOutput?.slice(-600)}` };
    },
  }];
}

export { fs };
