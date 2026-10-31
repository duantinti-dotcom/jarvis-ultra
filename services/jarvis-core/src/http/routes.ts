import { z } from 'zod';
import { PermissionScope, RequestOrigin, MemoryCategory } from '@jarvis/contracts';
import type { Core } from '../core.js';
import { Router, HttpError } from './router.js';
import { CATALOG, PROFILES, ModelRouter, type Profile } from '../brain/router.js';
import { detectHardware, liveStats } from '../hardware/detect.js';
import { analyze } from '../metrics/improve.js';
import { runBenchmark } from '../bench/run.js';
import { recentLogs } from '../log.js';
import { AGENTS } from '../brain/agents.js';

const SETTINGS_WHITELIST = new Set(['approvalMode', 'brain.maxIterations', 'model.preload', 'memory.episodicRetentionDays', 'relay.shareLocalConversations', 'allowRemoteHighRiskApproval', 'voice.voice', 'voice.speed', 'voice.mode']);

export function buildRoutes(core: Core) {
  const r = new Router();
  const parse = <T>(schema: z.ZodType<T>, v: unknown) => {
    const p = schema.safeParse(v);
    if (!p.success) throw new HttpError(400, p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return p.data;
  };

  // ---------- status ----------
  r.get('/api/status', async () => {
    const [ollamaVersion, device, pick] = await Promise.all([core.ollama.version(), core.deviceStatus(), core.router.pick('tools').catch(() => null)]);
    return {
      version: core.version, ollama: { url: core.config.ollamaUrl, version: ollamaVersion }, device, selectedModel: pick,
      emergencyStop: core.perms.emergencyStopped, relay: { enabled: core.relay.enabled, connected: core.relay.connected, lastError: core.relay.lastError, lastSyncAt: core.relay.lastSyncAt, config: core.relay.config },
      dataDir: core.config.dataDir, llmQueue: core.brain.queue.pending,
    };
  });

  // ---------- chat ----------
  r.post('/api/chat', async (c) => {
    const b = parse(z.object({ conversationId: z.string().max(64).nullable().optional(), text: z.string().min(1).max(16000), projectId: z.string().max(64).nullable().optional() }), await c.body());
    const { conversationId, messageId } = core.brain.start({ ...b, origin: 'local' });
    return { conversationId, messageId };
  });
  r.post('/api/chat/:id/cancel', (c) => {
    core.brain.cancelMessage(c.params.id!);
    return { ok: true };
  });
  r.get('/api/conversations', () => core.convs.list(200));
  r.get('/api/conversations/search', (c) => core.convs.search(c.query.get('q') ?? '', 50));
  r.get('/api/conversations/:id', (c) => {
    const conv = core.convs.get(c.params.id!);
    if (!conv) throw new HttpError(404, 'Conversa não encontrada.');
    return { ...conv, messages: core.convs.messages(c.params.id!, 500).filter((m) => m.role !== 'tool') };
  });
  r.patch('/api/conversations/:id', async (c) => {
    core.convs.rename(c.params.id!, parse(z.object({ title: z.string().min(1).max(120) }), await c.body()).title);
    return { ok: true };
  });
  r.del('/api/conversations/:id', (c) => {
    core.convs.delete(c.params.id!);
    return { ok: true };
  });

  r.post('/api/files/upload', async (c) => {
    const name = (c.query.get('name') ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120);
    if (!name || name.startsWith('.')) throw new HttpError(400, 'Nome de arquivo inválido.');
    const root = core.perms.roots().find((x) => x.access === 'readwrite');
    if (!root) throw new HttpError(400, 'Nenhuma pasta com escrita autorizada para receber arquivos.');
    const data = await c.raw(50_000_000);
    const fsm = await import('node:fs/promises');
    const pathm = await import('node:path');
    const dir = pathm.join(root.path, 'Uploads');
    await fsm.mkdir(dir, { recursive: true });
    let dest = pathm.join(dir, name);
    for (let i = 1; await fsm.stat(dest).then(() => true, () => false); i++) dest = pathm.join(dir, `${pathm.parse(name).name} (${i})${pathm.extname(name)}`);
    await fsm.writeFile(dest, data);
    core.perms.audit('file.upload', 'local', { dest, bytes: data.length });
    return { path: dest, bytes: data.length };
  });

  // ---------- tarefas e aprovações ----------
  r.get('/api/tasks', (c) => core.tasks.list(Number(c.query.get('limit') ?? 50)));
  r.get('/api/tasks/:id', (c) => {
    const t = core.tasks.get(c.params.id!, true);
    if (!t) throw new HttpError(404, 'Tarefa não encontrada.');
    const calls = core.db.all('SELECT id, tool, args, ok, error, verification, duration_ms, created_at FROM tool_calls WHERE task_id = ? ORDER BY created_at', c.params.id!);
    return { ...t, calls };
  });
  r.post('/api/tasks/:id/cancel', (c) => ({ ok: core.tasks.cancel(c.params.id!) }));
  r.post('/api/tasks/:id/retry', (c) => {
    const t = core.tasks.get(c.params.id!);
    if (!t) throw new HttpError(404, 'Tarefa não encontrada.');
    return core.brain.start({ conversationId: t.conversationId, text: `Tente novamente esta tarefa que ${t.state === 'failed' ? 'falhou' : 'foi interrompida'}: ${t.goal}${t.error ? `\nErro anterior: ${t.error}` : ''}`, origin: 'local' });
  });
  r.get('/api/approvals', (c) => core.perms.listApprovals(c.query.get('state') ?? undefined));
  r.post('/api/approvals/:id', async (c) => ({ state: core.perms.decide(c.params.id!, parse(z.object({ approve: z.boolean() }), await c.body()).approve, 'local') }));

  // ---------- ferramentas ----------
  r.get('/api/tools', async () => {
    const avail = await core.tools.availability();
    return core.tools.list().map((m) => ({ ...m, availability: avail[m.name] }));
  });
  r.post('/api/tools/invoke', async (c) => {
    const b = parse(z.object({ tool: z.string(), args: z.record(z.unknown()).default({}) }), await c.body());
    return core.tools.invoke({ tool: b.tool, args: b.args, origin: 'local' });
  });

  r.get('/api/agents', async () => {
    const tools = core.tools.list();
    const tm = await core.router.pick('tools').catch(() => null);
    const cm = await core.router.pick('code').catch(() => null);
    const runs = core.db.all<{ agent: string; n: number; ok: number; last: string }>("SELECT agent, count(*) AS n, sum(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS ok, max(started_at) AS last FROM task_steps GROUP BY agent");
    return Object.values(AGENTS).map((a) => ({
      ...a, model: a.modelClass === 'code' ? cm?.model ?? tm?.model ?? null : tm?.model ?? null,
      tools: a.tools.map((n) => tools.find((t) => t.name === n)).filter(Boolean).map((t) => ({ name: t!.name, risk: t!.risk, permissions: t!.permissions })),
      runs: runs.find((r) => r.agent === a.name) ?? null,
    }));
  });

  // ---------- segurança ----------
  r.get('/api/permissions', () => ({
    roots: core.perms.roots(), apps: core.perms.apps(), emergencyStop: core.perms.emergencyStopped,
    approvalMode: core.db.getSetting('approvalMode', 'balanced'),
    grants: Object.fromEntries(RequestOrigin.options.map((o) => [o, [...core.perms.grants(o)]])), scopes: PermissionScope.options,
  }));
  r.post('/api/permissions/roots', async (c) => {
    const b = parse(z.object({ path: z.string().min(1), access: z.enum(['read', 'readwrite']), remote: z.boolean().default(false) }), await c.body());
    return core.perms.addRoot(b.path, b.access, b.remote);
  });
  r.del('/api/permissions/roots/:id', (c) => core.perms.removeRoot(c.params.id!));
  r.post('/api/permissions/apps', async (c) => {
    const b = parse(z.object({ name: z.string(), execPath: z.string(), args: z.array(z.string()).default([]), canClose: z.boolean().default(false), remote: z.boolean().default(false) }), await c.body());
    return core.perms.addApp(b.name, b.execPath, b);
  });
  r.del('/api/permissions/apps/:id', (c) => core.perms.removeApp(c.params.id!));
  r.post('/api/permissions/scopes', async (c) => {
    const b = parse(z.object({ scope: PermissionScope, origin: RequestOrigin, enabled: z.boolean() }), await c.body());
    core.perms.setGrant(b.scope, b.origin, b.enabled);
    return { ok: true };
  });
  r.post('/api/emergency/stop', () => {
    core.perms.emergencyStop('local');
    return { stopped: true };
  });
  r.post('/api/emergency/resume', () => {
    core.perms.resume();
    return { stopped: false };
  });
  r.get('/api/audit', (c) => core.db.all('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?', Number(c.query.get('limit') ?? 200)));
  r.get('/api/tool-calls', (c) => core.db.all('SELECT id, task_id, tool, args, origin, ok, error, verification, duration_ms, created_at FROM tool_calls ORDER BY created_at DESC LIMIT ?', Number(c.query.get('limit') ?? 100)));

  // ---------- memória ----------
  r.get('/api/memory', async (c) => {
    const q = c.query.get('q');
    const category = c.query.get('category') as never;
    if (q) return (await core.memory.search(q, { limit: 50, category: category || undefined, minScore: 0.0001 })).results;
    return core.memory.list({ category: category || undefined, limit: 500, includeSuperseded: c.query.get('history') === '1' });
  });
  r.post('/api/memory', async (c) => {
    const b = parse(z.object({ category: MemoryCategory, title: z.string().min(1).max(200), content: z.string().min(1).max(8000), tags: z.array(z.string()).default([]), syncable: z.boolean().default(false), allowSensitive: z.boolean().default(false), expiresAt: z.string().nullable().optional() }), await c.body());
    return core.memory.save({ ...b, source: 'usuario:interface' });
  });
  r.patch('/api/memory/:id', async (c) => core.memory.update(c.params.id!, parse(z.object({ title: z.string().optional(), content: z.string().optional(), tags: z.array(z.string()).optional(), syncable: z.boolean().optional(), confidence: z.number().min(0).max(1).optional(), expiresAt: z.string().nullable().optional(), category: MemoryCategory.optional() }), await c.body())));
  r.post('/api/memory/:id/correct', async (c) => core.memory.correct(c.params.id!, parse(z.object({ content: z.string().min(1) }), await c.body()).content));
  r.post('/api/memory/:id/approve', (c) => core.memory.update(c.params.id!, { confidence: 1, tags: ['aprovado'] }));
  r.del('/api/memory/:id', (c) => ({ deleted: core.memory.delete(c.params.id!) }));
  r.get('/api/memory-export', () => core.memory.export());
  r.get('/api/memory-stale', () => core.memory.stale());
  r.post('/api/memory-reindex', async () => ({ reindexed: await core.memory.reindex() }));
  r.get('/api/memory-categories', () => ({ disabled: core.memory.disabledCategories(), all: MemoryCategory.options }));
  r.post('/api/memory-categories', async (c) => {
    const b = parse(z.object({ category: MemoryCategory, enabled: z.boolean() }), await c.body());
    core.memory.setCategoryEnabled(b.category, b.enabled);
    return { disabled: core.memory.disabledCategories() };
  });
  r.get('/api/projects', () => core.db.all('SELECT * FROM projects ORDER BY updated_at DESC'));

  // ---------- modelos ----------
  r.get('/api/models', async () => {
    const [installed, loaded] = await Promise.all([core.router.models().catch((e) => { throw new HttpError(503, e.message); }), core.ollama.ps().catch(() => [])]);
    return {
      installed: installed.map((m) => ({ ...m, loaded: loaded.find((l) => l.name === m.name) ?? null })), catalog: CATALOG, profiles: PROFILES,
      profile: core.router.profile, override: core.router.override, suggestion: core.hardware ? ModelRouter.suggest(core.hardware) : null, budgetGb: core.router.budgetGb(),
      benchmarks: core.db.all("SELECT model, value, created_at FROM metrics WHERE kind = 'benchmark' ORDER BY created_at DESC LIMIT 20"),
    };
  });
  r.post('/api/models/profile', async (c) => {
    core.router.profile = parse(z.object({ profile: z.enum(['ECO', 'BALANCED', 'MAXIMUM']) }), await c.body()).profile as Profile;
    return { profile: core.router.profile };
  });
  r.post('/api/models/override', async (c) => {
    core.router.override = parse(z.object({ model: z.string().nullable() }), await c.body()).model;
    return { override: core.router.override };
  });
  r.post('/api/models/load', async (c) => {
    const { model } = parse(z.object({ model: z.string() }), await c.body());
    const t = performance.now();
    await core.ollama.load(model);
    return { model, loadMs: Math.round(performance.now() - t) };
  });
  r.post('/api/models/unload', async (c) => {
    await core.ollama.unload(parse(z.object({ model: z.string() }), await c.body()).model);
    return { ok: true };
  });
  r.post('/api/models/pull', async (c) => {
    const { model } = parse(z.object({ model: z.string().regex(/^[a-zA-Z0-9._:/-]{2,120}$/) }), await c.body());
    c.res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    try {
      await core.ollama.pull(model, (p) => c.res.write(JSON.stringify(p) + '\n'));
      c.res.end(JSON.stringify({ status: 'success' }) + '\n');
    } catch (e) {
      c.res.end(JSON.stringify({ error: (e as Error).message }) + '\n');
    }
  });
  r.del('/api/models/:name', async (c) => {
    await core.ollama.remove(c.params.name!);
    return { ok: true };
  });
  r.post('/api/models/benchmark', async (c) => {
    const { model, runs } = parse(z.object({ model: z.string(), runs: z.number().int().min(1).max(5).default(2) }), await c.body());
    const embed = (await core.router.pick('embed'))?.model ?? null;
    const result = await core.brain.queue.run('background', () => runBenchmark(core.ollama, model, runs, embed));
    core.brain.recordMetrics('benchmark', result);
    return result;
  });

  // ---------- sistema ----------
  r.get('/api/hardware', async () => (core.hardware = await detectHardware(core.config.dataDir)));
  r.get('/api/system/live', async () => ({ ...(await liveStats()), ollamaLoaded: await core.ollama.ps().catch(() => []), activeTasks: core.tasks.active().length }));
  r.get('/api/metrics', (c) => core.db.all('SELECT kind, model, value, created_at FROM metrics WHERE kind = ? ORDER BY created_at DESC LIMIT ?', c.query.get('kind') ?? 'generation', Number(c.query.get('limit') ?? 100)));
  r.get('/api/improve', () => analyze(core.db, Number(14)));
  r.get('/api/logs', (c) => recentLogs(Number(c.query.get('limit') ?? 200)));
  r.get('/api/settings', () => Object.fromEntries([...SETTINGS_WHITELIST].map((k) => [k, core.db.getSetting(k, null)])));
  r.post('/api/settings', async (c) => {
    const b = parse(z.record(z.unknown()), await c.body());
    for (const [k, v] of Object.entries(b)) {
      if (!SETTINGS_WHITELIST.has(k)) throw new HttpError(400, `Configuração não permitida: ${k}`);
      core.db.setSetting(k, v);
    }
    return { ok: true };
  });

  // ---------- voz ----------
  r.get('/api/voice/status', () => core.voice.status());
  r.post('/api/voice/transcribe', async (c) => {
    const wav = await c.raw(25_000_000);
    const out = await core.voice.transcribe(wav, c.query.get('lang') ?? 'pt');
    core.brain.recordMetrics('stt', out);
    return out;
  });
  r.post('/api/voice/speak', async (c) => {
    const b = parse(z.object({ text: z.string().min(1).max(4000), voice: z.string().optional(), speed: z.number().min(0.5).max(2).default(1) }), await c.body());
    const out = await core.voice.speak(b.text, b.voice, b.speed);
    core.brain.recordMetrics('tts', { ms: out.ms, chars: b.text.length, voice: out.voice });
    c.res.writeHead(200, { 'content-type': 'audio/wav', 'x-tts-ms': String(out.ms) });
    c.res.end(out.wav);
  });
  r.post('/api/voice/metrics', async (c) => {
    core.brain.recordMetrics('voice', parse(z.record(z.number().nullable()), await c.body()));
    return { ok: true };
  });

  // ---------- laboratório e plugins ----------
  r.get('/api/lab', () => core.lab.list());
  r.get('/api/lab/:id', (c) => core.lab.get(c.params.id!) ?? (() => { throw new HttpError(404, 'não encontrado'); })());
  r.post('/api/lab/generate', async (c) => core.lab.generate(parse(z.object({ problem: z.string().min(10).max(4000) }), await c.body()).problem));
  r.post('/api/lab/create', async (c) => {
    const b = parse(z.object({ title: z.string().max(120), problem: z.string().max(4000), files: z.record(z.string().max(200_000)) }), await c.body());
    return core.lab.createFromFiles(b.title, b.problem, b.files);
  });
  r.put('/api/lab/:id/files', async (c) => core.lab.updateFiles(c.params.id!, parse(z.object({ files: z.record(z.string().max(200_000)) }), await c.body()).files));
  r.post('/api/lab/:id/test', (c) => core.lab.test(c.params.id!));
  r.post('/api/lab/:id/approve', (c) => core.lab.approve(c.params.id!));
  r.post('/api/lab/:id/reject', (c) => core.lab.reject(c.params.id!));
  r.get('/api/plugins', () => core.plugins.list());
  r.post('/api/plugins/:name/enable', (c) => core.plugins.setEnabled(c.params.name!, true));
  r.post('/api/plugins/:name/disable', (c) => core.plugins.setEnabled(c.params.name!, false));
  r.post('/api/plugins/:name/rollback', (c) => core.plugins.rollback(c.params.name!));
  r.del('/api/plugins/:name', (c) => core.plugins.uninstall(c.params.name!));
  r.get('/api/updates', () => core.db.all('SELECT * FROM updates ORDER BY created_at DESC LIMIT 100'));

  // ---------- relay ----------
  r.get('/api/relay', () => ({ enabled: core.relay.enabled, connected: core.relay.connected, lastError: core.relay.lastError, lastSyncAt: core.relay.lastSyncAt, config: core.relay.config }));
  r.post('/api/relay/pair', async (c) => {
    const b = parse(z.object({ url: z.string().url().refine((u) => u.startsWith('https://'), 'precisa ser https'), anonKey: z.string().min(20), code: z.string().min(6).max(12), deviceName: z.string().max(60).optional() }), await c.body());
    return core.relay.pair(b.url, b.anonKey, b.code, b.deviceName);
  });
  r.post('/api/relay/enable', async (c) => {
    core.relay.setEnabled(parse(z.object({ on: z.boolean() }), await c.body()).on);
    return { enabled: core.relay.enabled };
  });
  r.post('/api/relay/unpair', () => {
    core.relay.unpair();
    return { ok: true };
  });

  return r;
}
