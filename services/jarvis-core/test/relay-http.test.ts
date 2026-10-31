import http from 'node:http';
import crypto from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testCore } from './helpers.js';
import type { Core } from '../src/core.js';
import { buildRoutes } from '../src/http/routes.js';
import { createServer } from '../src/http/server.js';

/** Simula as RPCs do Supabase (mesma semântica das funções SQL do relay). */
function fakeSupabase() {
  const state = { code: 'ABCD2345', secretHash: '', deviceId: crypto.randomUUID(), revoked: false, queue: [] as { id: string; payload: unknown; created_at: string; status: string }[], results: [] as unknown[], events: [] as unknown[], statuses: [] as unknown[] };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const send = (s: number, b: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url?.endsWith('/jarvis_claim_pairing')) {
      if (body.p_code !== state.code) return send(400, { message: 'código inválido ou expirado' });
      state.code = '';
      const secret = crypto.randomBytes(24).toString('base64url');
      state.secretHash = crypto.createHash('sha256').update(secret).digest('hex');
      return send(200, { device_id: state.deviceId, device_secret: secret });
    }
    if (req.url?.endsWith('/jarvis_device_sync')) {
      if (body.p_device_id !== state.deviceId || crypto.createHash('sha256').update(body.p_secret).digest('hex') !== state.secretHash) return send(401, { message: 'invalid device credentials' });
      if (state.revoked) return send(403, { message: 'device revoked' });
      state.statuses.push(body.p_status);
      state.events.push(...body.p_events);
      state.results.push(...body.p_results);
      const cmds = state.queue.filter((q) => q.status === 'pending');
      cmds.forEach((c) => (c.status = 'delivered'));
      return send(200, { revoked: false, commands: cmds, server_time: new Date().toISOString() });
    }
    send(404, { message: 'nope' });
  });
  return { server, state };
}

let core: Core;
const sb = fakeSupabase();
let sbUrl = '';
beforeAll(async () => {
  ({ core } = await testCore());
  await new Promise<void>((r) => sb.server.listen(0, '127.0.0.1', () => r()));
  sbUrl = `http://127.0.0.1:${(sb.server.address() as { port: number }).port}`;
});
afterAll(() => { core.relay.stop(); sb.server.close(); });

describe('relay remoto', () => {
  it('rejeita código de vinculação errado', async () => {
    await expect(core.relay.pair(sbUrl, 'anon-key-xxxxxxxxxxxxxxxx', 'ERRADO12')).rejects.toThrow(/inválido/);
  });
  it('vincula, envia status real e executa comando autorizado uma única vez', async () => {
    await core.relay.pair(sbUrl, 'anon-key-xxxxxxxxxxxxxxxx', 'abcd2345');
    core.relay.stop();
    expect(JSON.stringify(core.db.getSetting('relay.config', null))).not.toContain(sb.state.secretHash); // segredo protegido
    await core.relay.sync();
    expect((sb.state.statuses.at(-1) as { ramTotalGb: number }).ramTotalGb).toBeGreaterThan(0);
    const cmd = { id: crypto.randomUUID(), payload: { kind: 'status.get' }, created_at: new Date().toISOString(), status: 'pending' };
    sb.state.queue.push(cmd);
    await core.relay.sync(); // recebe e executa
    await core.relay.sync(); // envia resultado
    const res = sb.state.results.filter((r) => (r as { id: string }).id === cmd.id);
    expect(res).toHaveLength(1);
    expect((res[0] as { status: string }).status).toBe('done');
    cmd.status = 'pending'; // reentrega simulada (ex.: queda de conexão)
    await core.relay.sync();
    await core.relay.sync();
    expect(sb.state.results.filter((r) => (r as { id: string }).id === cmd.id)).toHaveLength(1);
  });
  it('rejeita comandos fora da lista, expirados e sem permissão remota', async () => {
    const bad = { id: crypto.randomUUID(), payload: { kind: 'shell', cmd: 'format c:' }, created_at: new Date().toISOString(), status: 'pending' };
    const old = { id: crypto.randomUUID(), payload: { kind: 'status.get' }, created_at: new Date(Date.now() - 10 * 60_000).toISOString(), status: 'pending' };
    sb.state.queue.push(bad, old);
    await core.relay.sync();
    await core.relay.sync();
    const get = (id: string) => sb.state.results.find((r) => (r as { id: string }).id === id) as { status: string; result: { error: string } };
    expect(get(bad.id).status).toBe('rejected');
    expect(get(old.id).result.error).toMatch(/expirado/);
  });
  it('após revogação o PC para de aceitar comandos e remove a credencial', async () => {
    sb.state.revoked = true;
    await core.relay.sync();
    expect(core.relay.config).toBeNull();
    expect(core.relay.enabled).toBe(false);
  });
});

describe('API local', () => {
  let base = '';
  let server: http.Server;
  const token = 'tok_' + crypto.randomBytes(16).toString('hex');
  beforeAll(async () => {
    core.config.port = 0;
    server = createServer(core, buildRoutes(core), token);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    core.config.port = port;
    server.close();
    server = createServer(core, buildRoutes(core), token);
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => server.close());
  it('bloqueia usuário não autenticado', async () => {
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    expect((await fetch(`${base}/api/status`, { headers: { authorization: 'Bearer errado' } })).status).toBe(401);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });
  it('bloqueia origem estranha e DNS rebinding', async () => {
    expect((await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}`, origin: 'https://site-malicioso.com' } })).status).toBe(403);
    const r = await new Promise<number>((resolve) => http.get(`${base}/api/health`, { headers: { host: 'evil.com' } }, (res) => resolve(res.statusCode!)));
    expect(r).toBe(421);
  });
  it('bootstrap do token só para a própria interface', async () => {
    expect((await fetch(`${base}/api/bootstrap`)).status).toBe(403);
  });
  it('responde com token válido e informa Ollama ausente com erro real', async () => {
    const s = await (await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(s.ollama.version).toBeNull();
    const c = await (await fetch(`${base}/api/chat`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'explique a teoria da relatividade de forma resumida para mim' }) })).json();
    expect(c.messageId).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    const conv = await (await fetch(`${base}/api/conversations/${c.conversationId}`, { headers: { authorization: `Bearer ${token}` } })).json();
    const last = conv.messages.at(-1);
    expect(last.role).toBe('assistant');
    expect(last.content).toMatch(/Ollama.*não está respondendo/); // falha real, sem resposta fingida
  });
});
