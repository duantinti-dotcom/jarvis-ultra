import os from 'node:os';
import type { CoreEvent, DeviceStatus } from '@jarvis/contracts';
import { RelayCommand } from '@jarvis/contracts';
import type { Db } from '../db/index.js';
import type { Bus } from '../bus.js';
import { protect, unprotect } from './secret.js';
import { nowIso } from '../util/ids.js';
import { logger } from '../log.js';

const log = logger('relay');

type RelayConfig = { url: string; anonKey: string; deviceId: string; secret: string; deviceName: string; pairedAt: string };
type PendingCommand = { id: string; payload: unknown; created_at: string };
type SyncResponse = { revoked: boolean; commands: PendingCommand[]; server_time: string };

export type CommandHandler = (cmd: RelayCommand, commandId: string) => Promise<unknown>;
export type StatusProvider = () => Promise<DeviceStatus>;

/** Tipos de evento espelhados para o site (somente de conversas/tarefas remotas). */
const MIRRORED = new Set(['chat.delta', 'chat.done', 'chat.error', 'tool.start', 'tool.end', 'task.update', 'approval.request', 'approval.resolved', 'emergency.stop', 'agent.state', 'intent']);
const COMMAND_TTL_MS = 120_000;

export class RelayClient {
  private timer: NodeJS.Timeout | null = null;
  private outbox: CoreEvent[] = [];
  private results: { id: string; status: 'done' | 'failed' | 'rejected'; result: unknown }[] = [];
  private remoteConversations = new Set<string>();
  private remoteTasks = new Set<string>();
  private failures = 0;
  private running = false;
  connected = false;
  lastError: string | null = null;
  lastSyncAt: string | null = null;

  constructor(private db: Db, private bus: Bus, private dataDir: string, private handle: CommandHandler, private status: StatusProvider) {
    bus.onEvent((e) => this.capture(e));
  }

  get config(): Omit<RelayConfig, 'secret'> | null {
    const c = this.db.getSetting<RelayConfig | null>('relay.config', null);
    if (!c) return null;
    const { secret: _s, ...rest } = c;
    return rest;
  }

  get enabled() {
    return this.db.getSetting('relay.enabled', false) && !!this.config;
  }

  trackRemote(conversationId: string) {
    this.remoteConversations.add(conversationId);
  }

  private capture(e: CoreEvent) {
    if (!this.enabled || !MIRRORED.has(e.type)) return;
    const ev = e as CoreEvent & { conversationId?: string | null; taskId?: string | null; origin?: string };
    if (e.type === 'task.update' && !this.remoteTasks.has(e.taskId)) return;
    if ((e.type === 'tool.start' || e.type === 'tool.end') && ev.taskId) this.remoteTasks.add(ev.taskId);
    const isRemote = ev.conversationId ? this.remoteConversations.has(ev.conversationId) : e.type === 'approval.request' ? ev.origin === 'remote' : ['approval.resolved', 'emergency.stop', 'agent.state', 'task.update'].includes(e.type);
    if (!isRemote) return;
    // Agrupa deltas consecutivos da mesma mensagem para reduzir tráfego.
    const last = this.outbox[this.outbox.length - 1];
    if (e.type === 'chat.delta' && last?.type === 'chat.delta' && last.messageId === e.messageId) last.text += e.text;
    else this.outbox.push(structuredClone(e));
    if (this.outbox.length > 500) this.outbox.splice(0, this.outbox.length - 500);
  }

  /** Vincula este PC usando o código exibido no site (válido por 10 minutos). */
  async pair(url: string, anonKey: string, code: string, deviceName = os.hostname()) {
    const base = normalizeUrl(url);
    const r = await fetch(`${base}/rest/v1/rpc/jarvis_claim_pairing`, {
      method: 'POST', headers: headers(anonKey), body: JSON.stringify({ p_code: code.trim().toUpperCase(), p_device_name: deviceName.slice(0, 60), p_platform: `${process.platform}-${process.arch}` }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Vinculação recusada: ${(body as { message?: string }).message ?? r.status}`);
    const { device_id, device_secret } = body as { device_id: string; device_secret: string };
    if (!device_id || !device_secret) throw new Error('Resposta de vinculação inválida.');
    const cfg: RelayConfig = { url: base, anonKey, deviceId: device_id, secret: await protect(device_secret, this.dataDir), deviceName, pairedAt: nowIso() };
    this.db.setSetting('relay.config', cfg);
    this.db.setSetting('relay.enabled', true);
    this.db.run('INSERT INTO audit_events (id, kind, origin, detail, created_at) VALUES (?, ?, ?, ?, ?)', `aud_${Date.now()}`, 'relay.paired', 'local', JSON.stringify({ deviceId: device_id }), nowIso());
    log.info(`dispositivo vinculado: ${device_id}`);
    this.start();
    return { deviceId: device_id };
  }

  unpair(reason = 'desvinculado localmente') {
    this.stop();
    this.db.setSetting('relay.config', null);
    this.db.setSetting('relay.enabled', false);
    this.connected = false;
    this.bus.emitEvent({ type: 'relay.status', connected: false, detail: reason });
  }

  setEnabled(on: boolean) {
    this.db.setSetting('relay.enabled', on);
    if (on) this.start();
    else {
      this.stop();
      this.connected = false;
      this.bus.emitEvent({ type: 'relay.status', connected: false, detail: 'acesso remoto desligado' });
    }
  }

  start() {
    if (this.timer || !this.enabled) return;
    this.schedule(0);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick() {
    this.timer = null;
    if (!this.enabled || this.running) return;
    this.running = true;
    let next = 3000;
    try {
      const busy = await this.sync();
      this.failures = 0;
      // Mais frequente enquanto há conversa/tarefa remota em andamento.
      next = busy || this.outbox.length ? 700 : 2500;
    } catch (e) {
      this.failures++;
      this.lastError = (e as Error).message;
      if (this.connected) this.bus.emitEvent({ type: 'relay.status', connected: false, detail: this.lastError });
      this.connected = false;
      next = Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 6));
      log.warn(`relay indisponível (${this.failures}): ${this.lastError}`);
    } finally {
      this.running = false;
      if (this.enabled) this.schedule(next);
    }
  }

  /** Uma ida e volta: envia status/eventos/resultados e recebe comandos pendentes. */
  async sync(): Promise<boolean> {
    const c = this.db.getSetting<RelayConfig | null>('relay.config', null);
    if (!c) throw new Error('não vinculado');
    const secret = await unprotect(c.secret, this.dataDir);
    const events = this.outbox.splice(0, 200);
    const results = this.results.splice(0, 50);
    let res: Response;
    try {
      res = await fetch(`${c.url}/rest/v1/rpc/jarvis_device_sync`, {
        method: 'POST', headers: headers(c.anonKey), signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ p_device_id: c.deviceId, p_secret: secret, p_status: await this.status(), p_events: events, p_results: results }),
      });
    } catch (e) {
      this.outbox.unshift(...events);
      this.results.unshift(...results);
      throw e;
    }
    const body = (await res.json().catch(() => null)) as SyncResponse | { message?: string } | null;
    if (!res.ok) {
      const msg = (body as { message?: string })?.message ?? `HTTP ${res.status}`;
      if (/revog|revoked|invalid device/i.test(msg)) {
        log.warn('dispositivo revogado pelo proprietário; credenciais removidas');
        this.unpair('dispositivo revogado no site');
        return false;
      }
      this.outbox.unshift(...events);
      this.results.unshift(...results);
      throw new Error(msg);
    }
    const data = body as SyncResponse;
    if (data.revoked) {
      this.unpair('dispositivo revogado no site');
      return false;
    }
    if (!this.connected) this.bus.emitEvent({ type: 'relay.status', connected: true });
    this.connected = true;
    this.lastError = null;
    this.lastSyncAt = nowIso();
    for (const cmd of data.commands ?? []) await this.process(cmd, data.server_time);
    return (data.commands?.length ?? 0) > 0 || this.remoteTasks.size > 0;
  }

  private async process(cmd: PendingCommand, serverTime: string) {
    // Idempotência: um comando nunca é executado duas vezes, mesmo após reconexão.
    if (this.db.get('SELECT 1 FROM relay_processed WHERE command_id = ?', cmd.id)) return;
    this.db.run('INSERT INTO relay_processed (command_id, received_at, status) VALUES (?, ?, ?)', cmd.id, nowIso(), 'received');
    const age = new Date(serverTime).getTime() - new Date(cmd.created_at).getTime();
    if (age > COMMAND_TTL_MS) return this.reply(cmd.id, 'rejected', { error: 'Comando expirado (enviado há mais de 2 minutos). Envie novamente.' });
    const parsed = RelayCommand.safeParse(cmd.payload);
    if (!parsed.success) return this.reply(cmd.id, 'rejected', { error: 'Comando inválido ou não suportado.' });
    try {
      const result = await this.handle(parsed.data, cmd.id);
      this.reply(cmd.id, 'done', result);
    } catch (e) {
      this.reply(cmd.id, 'failed', { error: (e as Error).message });
    }
  }

  private reply(id: string, status: 'done' | 'failed' | 'rejected', result: unknown) {
    this.db.run('UPDATE relay_processed SET status = ? WHERE command_id = ?', status, id);
    this.results.push({ id, status, result });
    this.schedule(50);
  }
}

const normalizeUrl = (u: string) => u.trim().replace(/\/+$/, '');
const headers = (anon: string) => ({ apikey: anon, authorization: `Bearer ${anon}`, 'content-type': 'application/json' });
