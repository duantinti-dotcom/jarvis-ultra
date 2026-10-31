import type { ToolManifest, ToolResult, RequestOrigin } from '@jarvis/contracts';
import { ToolManifestSchema } from '@jarvis/contracts';
import type { Tool, ToolContext, Verification } from './types.js';
import { validateArgs } from './validate.js';
import { PermissionError, type PermissionEngine } from '../permissions/engine.js';
import type { Db } from '../db/index.js';
import { json } from '../db/index.js';
import type { Bus } from '../bus.js';
import type { CoreConfig } from '../config.js';
import { newId, nowIso } from '../util/ids.js';
import { logger } from '../log.js';

const log = logger('tools');

export type InvokeRequest = {
  tool: string;
  args: unknown;
  origin: RequestOrigin;
  taskId?: string | null;
  stepId?: string | null;
  conversationId?: string | null;
  signal?: AbortSignal;
  /** Aprovação já concedida explicitamente pelo usuário para esta chamada exata. */
  preApproved?: boolean;
};

export type InvokeResult = ToolResult & { callId: string; tool: string; verification: Verification | null; denied?: boolean };

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  services: Record<string, unknown> = {};

  constructor(private db: Db, private perms: PermissionEngine, private bus: Bus, private config: CoreConfig) {}

  register(tool: Tool) {
    const parsed = ToolManifestSchema.safeParse(tool.manifest);
    if (!parsed.success) throw new Error(`Manifesto inválido para ${tool.manifest?.name}: ${parsed.error.message}`);
    if (this.tools.has(tool.manifest.name)) throw new Error(`Ferramenta duplicada: ${tool.manifest.name}`);
    this.tools.set(tool.manifest.name, tool);
  }

  unregister(name: string) {
    this.tools.delete(name);
  }

  get(name: string) {
    return this.tools.get(name);
  }

  list(): ToolManifest[] {
    return [...this.tools.values()].map((t) => t.manifest);
  }

  /** Ferramentas utilizáveis por uma origem (escopos concedidos). */
  usable(origin: RequestOrigin, filter?: (m: ToolManifest) => boolean): ToolManifest[] {
    const grants = this.perms.grants(origin);
    return this.list().filter((m) => m.permissions.every((p) => grants.has(p)) && (!filter || filter(m)));
  }

  async availability() {
    const out: Record<string, { ok: boolean; reason?: string }> = {};
    for (const [name, t] of this.tools) out[name] = t.available ? await t.available().catch((e) => ({ ok: false, reason: String(e) })) : { ok: true };
    return out;
  }

  /**
   * Único caminho de execução de ferramentas: valida, checa permissões,
   * pede aprovação quando necessário, aplica timeout, registra e verifica.
   */
  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const callId = newId('call');
    const started = Date.now();
    const tool = this.tools.get(req.tool);
    const base = { callId, tool: req.tool, verification: null as Verification | null };
    const fail = (error: string, denied = false): InvokeResult => {
      const r = { ...base, ok: false, error, durationMs: Date.now() - started, denied };
      this.record(req, callId, r);
      this.bus.emitEvent({ type: 'tool.end', conversationId: req.conversationId ?? null, taskId: req.taskId ?? null, callId, tool: req.tool, ok: false, summary: error, durationMs: r.durationMs });
      return r;
    };
    if (!tool) return fail(`Ferramenta inexistente: ${req.tool}`);
    const valid = validateArgs(tool.manifest.parameters, req.args ?? {});
    if (!valid.ok) return fail(valid.error);
    const args = valid.value;

    const decision = this.perms.evaluate(tool.manifest, req.origin);
    if (!decision.allowed) {
      this.perms.audit('tool.denied', req.origin, { tool: req.tool, reason: decision.reason });
      return fail(decision.reason, true);
    }
    if (decision.needsApproval && !req.preApproved) {
      const ok = await this.perms.requestApproval({
        tool: req.tool, args, risk: tool.manifest.risk, reason: tool.manifest.description, origin: req.origin,
        taskId: req.taskId ?? null, stepId: req.stepId ?? null, signal: req.signal,
      });
      if (!ok) return fail('Ação não aprovada pelo usuário.', true);
      if (this.perms.emergencyStopped) return fail('Parada de emergência ativa.', true);
    }

    this.bus.emitEvent({ type: 'tool.start', conversationId: req.conversationId ?? null, taskId: req.taskId ?? null, callId, tool: req.tool, args });
    const ac = new AbortController();
    const onAbort = () => ac.abort(req.signal?.reason);
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const offStop = this.perms.onEmergencyStop(() => ac.abort(new Error('Parada de emergência')));
    const timer = setTimeout(() => ac.abort(new Error(`Tempo limite de ${tool.manifest.timeoutMs} ms excedido`)), tool.manifest.timeoutMs);
    const ctx: ToolContext = {
      origin: req.origin, taskId: req.taskId ?? null, stepId: req.stepId ?? null, conversationId: req.conversationId ?? null,
      signal: ac.signal, perms: this.perms, db: this.db, config: this.config, services: this.services,
    };
    let result: InvokeResult;
    try {
      const out = await Promise.race([
        tool.run(args, ctx),
        new Promise<never>((_, rej) => ac.signal.addEventListener('abort', () => rej(ac.signal.reason ?? new Error('Cancelado')), { once: true })),
      ]);
      let verification: Verification | null = null;
      if (out.ok && tool.verify) {
        verification = await tool.verify(args, out, ctx).catch((e) => ({ ok: false, detail: `Falha ao verificar: ${errMsg(e)}` }));
      }
      const ok = out.ok && (verification ? verification.ok : true);
      result = {
        ...base, ...out, ok, verification, durationMs: Date.now() - started,
        ...(out.ok && verification && !verification.ok ? { error: `Verificação falhou: ${verification.detail}` } : {}),
      };
    } catch (e) {
      result = { ...base, ok: false, error: e instanceof PermissionError ? e.message : errMsg(e), durationMs: Date.now() - started, denied: e instanceof PermissionError };
    } finally {
      clearTimeout(timer);
      offStop();
      req.signal?.removeEventListener('abort', onAbort);
    }
    this.record(req, callId, result);
    this.bus.emitEvent({
      type: 'tool.end', conversationId: req.conversationId ?? null, taskId: req.taskId ?? null, callId, tool: req.tool,
      ok: result.ok, summary: result.ok ? summarize(result.data) : result.error ?? 'erro', durationMs: result.durationMs,
    });
    log.info(`${req.tool} ${result.ok ? 'ok' : 'falhou'} em ${result.durationMs} ms`, result.ok ? undefined : { error: result.error });
    return result;
  }

  private record(req: InvokeRequest, callId: string, r: InvokeResult) {
    this.db.run(
      'INSERT INTO tool_calls (id, task_id, step_id, conversation_id, tool, args, origin, ok, result, error, evidence, undo, verification, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      callId, req.taskId ?? null, req.stepId ?? null, req.conversationId ?? null, req.tool, json(req.args), req.origin, r.ok ? 1 : 0,
      json(truncateDeep(r.data)), r.error ?? null, json(r.evidence), json(r.undo), json(r.verification), r.durationMs, nowIso(),
    );
  }
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function summarize(d: unknown): string {
  if (d == null) return 'ok';
  const s = typeof d === 'string' ? d : JSON.stringify(d);
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}

function truncateDeep(d: unknown): unknown {
  const s = JSON.stringify(d ?? null);
  return s.length > 20_000 ? { truncated: true, preview: s.slice(0, 20_000) } : d;
}
