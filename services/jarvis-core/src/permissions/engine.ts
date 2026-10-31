import fs from 'node:fs';
import path from 'node:path';
import type { PermissionScope, RequestOrigin, RiskLevel, ToolManifest, Approval } from '@jarvis/contracts';
import { PermissionScope as ScopeEnum } from '@jarvis/contracts';
import type { Db } from '../db/index.js';
import { json, parse } from '../db/index.js';
import type { Bus } from '../bus.js';
import { newId, nowIso } from '../util/ids.js';
import { logger } from '../log.js';

const log = logger('permissions');
const isWin = process.platform === 'win32';

/** Escopos ligados por padrão em cada origem. Tudo o mais começa desligado. */
const DEFAULT_GRANTS: Record<RequestOrigin, PermissionScope[]> = {
  local: ['fs.read', 'fs.write', 'fs.delete', 'apps.list', 'apps.launch', 'apps.close', 'browser.control', 'screen.capture', 'system.read', 'memory.read', 'memory.write', 'lab.execute', 'net.fetch'],
  remote: ['fs.read', 'apps.list', 'apps.launch', 'system.read', 'memory.read'],
  lab: [],
  system: ['system.read', 'memory.read'],
};

export type AllowedRoot = { id: string; path: string; access: 'read' | 'readwrite'; remote: boolean };
export type AllowedApp = { id: string; name: string; execPath: string; args: string[]; canClose: boolean; remote: boolean };

export type Decision =
  | { allowed: false; reason: string }
  | { allowed: true; needsApproval: boolean; reason: string };

export class PermissionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PermissionError';
  }
}

type Pending = { resolve: (ok: boolean) => void; timer: NodeJS.Timeout };

export class PermissionEngine {
  private pending = new Map<string, Pending>();
  private stopped = false;
  private stopListeners = new Set<() => void>();

  constructor(private db: Db, private bus: Bus) {
    this.stopped = db.getSetting('emergencyStop', false);
  }

  // ---------- escopos ----------
  grants(origin: RequestOrigin): Set<PermissionScope> {
    const set = new Set<PermissionScope>(DEFAULT_GRANTS[origin]);
    for (const r of this.db.all<{ scope: PermissionScope; enabled: number }>('SELECT scope, enabled FROM scope_grants WHERE origin = ?', origin)) {
      if (r.enabled) set.add(r.scope);
      else set.delete(r.scope);
    }
    return set;
  }

  setGrant(scope: PermissionScope, origin: RequestOrigin, enabled: boolean) {
    ScopeEnum.parse(scope);
    if (origin === 'lab' && enabled && scope !== 'memory.read') throw new PermissionError('O laboratório não pode receber escopos que tocam o sistema real.');
    this.db.run(
      'INSERT INTO scope_grants (scope, origin, enabled, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(scope, origin) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at',
      scope, origin, enabled ? 1 : 0, nowIso(),
    );
    this.audit('permission.grant', 'local', { scope, origin, enabled });
  }

  // ---------- pastas ----------
  roots(): AllowedRoot[] {
    return this.db.all<{ id: string; path: string; access: 'read' | 'readwrite'; remote: number }>('SELECT * FROM allowed_roots ORDER BY path')
      .map((r) => ({ id: r.id, path: r.path, access: r.access, remote: !!r.remote }));
  }

  addRoot(p: string, access: 'read' | 'readwrite', remote = false): AllowedRoot {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new PermissionError(`Pasta inexistente: ${abs}`);
    const real = fs.realpathSync.native(abs);
    if (isFilesystemRoot(real)) throw new PermissionError('Não é permitido autorizar a raiz de um disco inteiro. Escolha uma pasta específica.');
    const id = newId('root');
    this.db.run('INSERT INTO allowed_roots (id, path, access, remote, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET access = excluded.access, remote = excluded.remote', id, real, access, remote ? 1 : 0, nowIso());
    this.audit('permission.root.add', 'local', { path: real, access, remote });
    return this.roots().find((r) => r.path === real)!;
  }

  removeRoot(id: string) {
    this.db.run('DELETE FROM allowed_roots WHERE id = ?', id);
    this.audit('permission.root.remove', 'local', { id });
  }

  /**
   * Resolve um caminho e garante que ele está dentro de uma pasta autorizada.
   * Resolve links simbólicos do ancestral existente mais próximo para impedir fugas.
   */
  resolvePath(input: string, need: 'read' | 'write', origin: RequestOrigin): string {
    if (typeof input !== 'string' || !input.trim()) throw new PermissionError('Caminho vazio.');
    if (input.includes('\0')) throw new PermissionError('Caminho inválido.');
    if (/^\\\\[?.]\\/.test(input)) throw new PermissionError('Caminhos de dispositivo não são permitidos.');
    const roots = this.roots().filter((r) => origin !== 'remote' || r.remote);
    if (roots.length === 0) throw new PermissionError(origin === 'remote' ? 'Nenhuma pasta liberada para acesso remoto.' : 'Nenhuma pasta autorizada. Adicione uma na Central de Segurança.');
    // Caminhos relativos são resolvidos contra a primeira pasta autorizada.
    const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(roots[0]!.path, input);
    const real = realpathOfNearest(abs);
    for (const r of roots) {
      if (isInside(real, r.path)) {
        if (need === 'write' && r.access !== 'readwrite') throw new PermissionError(`A pasta ${r.path} está liberada somente para leitura.`);
        return real;
      }
    }
    throw new PermissionError(`Acesso negado: ${abs} está fora das pastas autorizadas.`);
  }

  // ---------- aplicativos ----------
  apps(): AllowedApp[] {
    return this.db.all<{ id: string; name: string; exec_path: string; args: string; can_close: number; remote: number }>('SELECT * FROM allowed_apps ORDER BY name')
      .map((a) => ({ id: a.id, name: a.name, execPath: a.exec_path, args: parse<string[]>(a.args, []), canClose: !!a.can_close, remote: !!a.remote }));
  }

  addApp(name: string, execPath: string, opts: { args?: string[]; canClose?: boolean; remote?: boolean } = {}): AllowedApp {
    if (!/^[\p{L}\p{N} ._-]{1,60}$/u.test(name)) throw new PermissionError('Nome de aplicativo inválido.');
    if (!path.isAbsolute(execPath) && !/^[a-z0-9._-]+$/i.test(execPath)) throw new PermissionError('Informe o caminho completo do executável ou um comando simples (ex.: notepad).');
    const id = newId('app');
    this.db.run(
      'INSERT INTO allowed_apps (id, name, exec_path, args, can_close, remote, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET exec_path = excluded.exec_path, args = excluded.args, can_close = excluded.can_close, remote = excluded.remote',
      id, name, execPath, json(opts.args ?? []), opts.canClose ? 1 : 0, opts.remote ? 1 : 0, nowIso(),
    );
    this.audit('permission.app.add', 'local', { name, execPath });
    return this.apps().find((a) => a.name === name)!;
  }

  removeApp(id: string) {
    this.db.run('DELETE FROM allowed_apps WHERE id = ?', id);
    this.audit('permission.app.remove', 'local', { id });
  }

  findApp(name: string, origin: RequestOrigin): AllowedApp {
    const n = name.trim().toLowerCase();
    const app = this.apps().find((a) => a.name.toLowerCase() === n) ?? this.apps().find((a) => a.name.toLowerCase().includes(n) || n.includes(a.name.toLowerCase()));
    if (!app) throw new PermissionError(`Aplicativo "${name}" não está na lista de aplicativos autorizados.`);
    if (origin === 'remote' && !app.remote) throw new PermissionError(`"${app.name}" não está liberado para acionamento remoto.`);
    return app;
  }

  // ---------- decisão ----------
  evaluate(tool: ToolManifest, origin: RequestOrigin): Decision {
    if (this.stopped) return { allowed: false, reason: 'Parada de emergência ativa. Retome a operação na Central de Segurança.' };
    const grants = this.grants(origin);
    const missing = tool.permissions.filter((s) => !grants.has(s));
    if (missing.length) return { allowed: false, reason: `Permissão ausente para origem "${origin}": ${missing.join(', ')}` };
    const needsApproval = approvalRequired(tool.risk, origin, this.db.getSetting<'balanced' | 'strict'>('approvalMode', 'balanced'));
    return { allowed: true, needsApproval, reason: needsApproval ? `Risco ${tool.risk} exige aprovação` : 'permitido' };
  }

  // ---------- aprovações ----------
  async requestApproval(req: { tool: string; args: Record<string, unknown>; risk: RiskLevel; reason: string; origin: RequestOrigin; taskId?: string | null; stepId?: string | null; timeoutMs?: number; signal?: AbortSignal }): Promise<boolean> {
    const id = newId('apr');
    const timeoutMs = req.timeoutMs ?? 5 * 60_000;
    const expires = new Date(Date.now() + timeoutMs).toISOString();
    this.db.run(
      'INSERT INTO approvals (id, task_id, step_id, tool, args, risk, reason, origin, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, req.taskId ?? null, req.stepId ?? null, req.tool, json(req.args), req.risk, req.reason, req.origin, 'pending', nowIso(), expires,
    );
    log.info(`aprovação solicitada ${id} para ${req.tool}`);
    const decision = new Promise<boolean>((resolve) => {
      const finish = (ok: boolean, state: Approval['state']) => {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        this.db.run("UPDATE approvals SET state = ?, decided_at = ? WHERE id = ? AND state = 'pending'", state, nowIso(), id);
        this.bus.emitEvent({ type: 'approval.resolved', approvalId: id, state });
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false, 'expired'), timeoutMs);
      this.pending.set(id, { resolve: (ok) => finish(ok, ok ? 'approved' : 'denied'), timer });
      req.signal?.addEventListener('abort', () => finish(false, 'denied'), { once: true });
    });
    // Emite somente depois de registrar a pendência: respostas imediatas são válidas.
    this.bus.emitEvent({ type: 'approval.request', approvalId: id, tool: req.tool, args: req.args, risk: req.risk, reason: req.reason, origin: req.origin });
    return decision;
  }

  /** Decide uma aprovação. Aprovações de risco alto só podem ser concedidas localmente. */
  decide(id: string, approve: boolean, decidedBy: 'local' | 'remote'): Approval['state'] {
    const row = this.db.get<{ risk: RiskLevel; state: string }>('SELECT risk, state FROM approvals WHERE id = ?', id);
    if (!row) throw new PermissionError('Aprovação não encontrada.');
    if (row.state !== 'pending') throw new PermissionError(`Aprovação já está em estado "${row.state}".`);
    if (approve && decidedBy === 'remote' && (row.risk === 'high' || row.risk === 'critical') && !this.db.getSetting('allowRemoteHighRiskApproval', false)) {
      throw new PermissionError('Ações de risco alto só podem ser aprovadas no próprio computador.');
    }
    this.db.run('UPDATE approvals SET decided_by = ? WHERE id = ?', decidedBy, id);
    const p = this.pending.get(id);
    if (!p) {
      // Processo reiniciado: a aprovação perdeu o executor que aguardava.
      this.db.run("UPDATE approvals SET state = 'expired', decided_at = ? WHERE id = ?", nowIso(), id);
      return 'expired';
    }
    p.resolve(approve);
    this.audit('approval.decide', decidedBy, { id, approve });
    return approve ? 'approved' : 'denied';
  }

  listApprovals(state?: string): Approval[] {
    const rows = state
      ? this.db.all<Record<string, string>>('SELECT * FROM approvals WHERE state = ? ORDER BY created_at DESC LIMIT 100', state)
      : this.db.all<Record<string, string>>('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100');
    return rows.map((r) => ({
      id: r.id!, taskId: r.task_id ?? null, stepId: r.step_id ?? null, tool: r.tool!, args: parse(r.args, {}), risk: r.risk!,
      reason: r.reason!, origin: r.origin!, state: r.state as Approval['state'], createdAt: r.created_at!, decidedAt: r.decided_at ?? null,
    }));
  }

  /** Aprovações deixadas pendentes por um processo anterior não têm mais executor. */
  expireOrphans() {
    this.db.run("UPDATE approvals SET state = 'expired', decided_at = ? WHERE state = 'pending'", nowIso());
  }

  // ---------- emergência ----------
  get emergencyStopped() {
    return this.stopped;
  }
  onEmergencyStop(fn: () => void) {
    this.stopListeners.add(fn);
    return () => this.stopListeners.delete(fn);
  }
  emergencyStop(origin: RequestOrigin) {
    this.stopped = true;
    this.db.setSetting('emergencyStop', true);
    for (const id of [...this.pending.keys()]) this.pending.get(id)?.resolve(false);
    for (const fn of this.stopListeners) fn();
    this.audit('emergency.stop', origin, {});
    this.bus.emitEvent({ type: 'emergency.stop', at: nowIso() });
    log.warn('PARADA DE EMERGÊNCIA acionada');
  }
  resume() {
    this.stopped = false;
    this.db.setSetting('emergencyStop', false);
    this.audit('emergency.resume', 'local', {});
  }

  audit(kind: string, origin: RequestOrigin | string, detail: unknown) {
    this.db.run('INSERT INTO audit_events (id, kind, origin, detail, created_at) VALUES (?, ?, ?, ?, ?)', newId('aud'), kind, origin, json(detail), nowIso());
  }
}

export function approvalRequired(risk: RiskLevel, origin: RequestOrigin, mode: 'balanced' | 'strict'): boolean {
  if (risk === 'high' || risk === 'critical') return true;
  if (risk === 'medium') return mode === 'strict' || origin !== 'local';
  return false;
}

function norm(p: string) {
  const n = path.resolve(p);
  return isWin ? n.toLowerCase() : n;
}

export function isInside(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isFilesystemRoot(p: string) {
  return path.parse(p).root === path.resolve(p) || path.resolve(p) === path.resolve(process.env.SystemRoot ?? '/__none__');
}

/** realpath do ancestral existente mais próximo + o restante do caminho. */
function realpathOfNearest(abs: string): string {
  let cur = abs;
  const rest: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  const base = fs.existsSync(cur) ? fs.realpathSync.native(cur) : cur;
  return path.join(base, ...rest);
}
