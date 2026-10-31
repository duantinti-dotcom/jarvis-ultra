import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ToolManifest } from '@jarvis/contracts';
import { ToolManifestSchema } from '@jarvis/contracts';
import type { Db } from '../db/index.js';
import { json, parse } from '../db/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { CoreConfig } from '../config.js';
import type { Tool } from '../tools/types.js';
import { ensureRunner, runSandboxed } from './sandbox.js';
import { newId, nowIso, sha256 } from '../util/ids.js';
import { logger } from '../log.js';

const log = logger('plugins');

export type PluginManifest = ToolManifest & { entry: string; author?: string; dependencies?: string[] };

export async function hashDir(dir: string): Promise<string> {
  const files = (await fsp.readdir(dir)).filter((f) => !f.startsWith('.')).sort();
  const parts: string[] = [];
  for (const f of files) {
    const p = path.join(dir, f);
    if ((await fsp.stat(p)).isFile()) parts.push(`${f}:${sha256(await fsp.readFile(p))}`);
  }
  return sha256(parts.join('\n'));
}

export class PluginManager {
  readonly runner: string;
  constructor(private db: Db, private registry: ToolRegistry, private config: CoreConfig) {
    this.runner = ensureRunner(path.join(config.dataDir, 'runtime'));
  }

  list() {
    return this.db.all<{ name: string; version: string; enabled: number; manifest: string; path: string; sha256: string; installed_at: string; updated_at: string }>('SELECT * FROM plugins ORDER BY name')
      .map((p) => ({ name: p.name, version: p.version, enabled: !!p.enabled, manifest: parse<PluginManifest>(p.manifest, {} as PluginManifest), path: p.path, sha256: p.sha256, installedAt: p.installed_at, updatedAt: p.updated_at, versions: this.versions(p.name) }));
  }

  versions(name: string) {
    return this.db.all<{ id: string; version: string; status: string; created_at: string; sha256: string; path: string }>('SELECT * FROM plugin_versions WHERE name = ? ORDER BY created_at DESC', name);
  }

  /** Carrega plugins habilitados, conferindo a integridade (hash) de cada um. */
  async loadAll() {
    for (const p of this.list()) {
      if (!p.enabled) continue;
      const h = fs.existsSync(p.path) ? await hashDir(p.path) : null;
      if (h !== p.sha256) {
        log.error(`plugin ${p.name} desativado: arquivos alterados fora do JARVIS (hash não confere)`);
        this.db.run('UPDATE plugins SET enabled = 0 WHERE name = ?', p.name);
        continue;
      }
      this.mount(p.manifest, p.path);
    }
  }

  private mount(manifest: PluginManifest, dir: string) {
    this.registry.unregister(manifest.name);
    const { entry, author: _a, dependencies: _d, ...toolManifest } = manifest;
    const declared = new Set(manifest.permissions);
    const tool: Tool = {
      manifest: toolManifest,
      run: async (args, ctx) => {
        const dataDir = path.join(this.config.dataDir, 'plugin-data', manifest.name);
        fs.mkdirSync(dataDir, { recursive: true });
        const r = await runSandboxed({
          runner: this.runner, entry: path.join(dir, entry), readDirs: [dir, dataDir], writeDirs: [dataDir], mode: 'run', args,
          timeoutMs: manifest.timeoutMs, signal: ctx.signal,
          // O plugin só pode chamar ferramentas cujas permissões ele declarou (e que a origem possui).
          onCall: async (name, cargs) => {
            const target = this.registry.get(name);
            if (!target) return { ok: false, error: `ferramenta inexistente: ${name}` };
            if (!target.manifest.permissions.every((p) => declared.has(p))) return { ok: false, error: `plugin não declarou as permissões de ${name}` };
            if (name.startsWith('plugin.') || name === manifest.name) return { ok: false, error: 'recursão bloqueada' };
            const res = await this.registry.invoke({ tool: name, args: cargs, origin: ctx.origin, taskId: ctx.taskId, conversationId: ctx.conversationId, signal: ctx.signal });
            return { ok: res.ok, data: res.data, error: res.error };
          },
        });
        if (r.timedOut) return { ok: false, error: 'Plugin excedeu o tempo limite.' };
        if (!r.result) return { ok: false, error: `Plugin terminou sem resultado: ${r.stderr.slice(-500)}` };
        return { ok: !!r.result.ok, data: r.result.data, error: r.result.error };
      },
    };
    this.registry.register(tool);
  }

  /** Instala uma versão a partir de uma pasta já testada (chamado somente após aprovação). */
  async install(srcDir: string, opts: { experimentId?: string } = {}) {
    const manifest = JSON.parse(await fsp.readFile(path.join(srcDir, 'manifest.json'), 'utf8')) as PluginManifest;
    validatePluginManifest(manifest);
    const dest = path.join(this.config.pluginsDir, manifest.name, manifest.version);
    if (fs.existsSync(dest)) throw new Error(`A versão ${manifest.version} de ${manifest.name} já existe. Incremente a versão.`);
    await fsp.mkdir(dest, { recursive: true });
    for (const f of await fsp.readdir(srcDir)) if (/\.(mjs|json|md)$/.test(f)) await fsp.copyFile(path.join(srcDir, f), path.join(dest, f));
    const h = await hashDir(dest);
    const prev = this.list().find((p) => p.name === manifest.name);
    const now = nowIso();
    this.db.tx(() => {
      this.db.run('INSERT INTO plugin_versions (id, name, version, path, sha256, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', newId('pv'), manifest.name, manifest.version, dest, h, 'installed', now);
      this.db.run('INSERT INTO plugins (name, version, enabled, manifest, path, sha256, installed_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET version = excluded.version, enabled = 1, manifest = excluded.manifest, path = excluded.path, sha256 = excluded.sha256, updated_at = excluded.updated_at',
        manifest.name, manifest.version, json(manifest), dest, h, now, now);
      this.db.run('INSERT INTO updates (id, kind, target, from_version, to_version, experiment_id, status, backup_path, approved_at, applied_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        newId('upd'), 'plugin', manifest.name, prev?.version ?? null, manifest.version, opts.experimentId ?? null, 'applied', prev?.path ?? null, now, now, now);
    });
    this.mount(manifest, dest);
    log.info(`plugin ${manifest.name}@${manifest.version} instalado`);
    return { name: manifest.name, version: manifest.version, sha256: h, previous: prev?.version ?? null };
  }

  setEnabled(name: string, enabled: boolean) {
    const p = this.list().find((x) => x.name === name);
    if (!p) throw new Error('Plugin não encontrado.');
    this.db.run('UPDATE plugins SET enabled = ?, updated_at = ? WHERE name = ?', enabled ? 1 : 0, nowIso(), name);
    if (enabled) this.mount(p.manifest, p.path);
    else this.registry.unregister(name);
  }

  /** Volta para a versão instalada anterior. */
  async rollback(name: string) {
    const cur = this.list().find((p) => p.name === name);
    if (!cur) throw new Error('Plugin não encontrado.');
    const prev = this.versions(name).find((v) => v.version !== cur.version && v.status !== 'rolled_back' && fs.existsSync(v.path));
    if (!prev) throw new Error('Não há versão anterior para restaurar.');
    const manifest = JSON.parse(await fsp.readFile(path.join(prev.path, 'manifest.json'), 'utf8')) as PluginManifest;
    if ((await hashDir(prev.path)) !== prev.sha256) throw new Error('A versão anterior foi alterada fora do JARVIS; rollback recusado.');
    const now = nowIso();
    this.db.tx(() => {
      this.db.run("UPDATE plugin_versions SET status = 'rolled_back' WHERE name = ? AND version = ?", name, cur.version);
      this.db.run('UPDATE plugins SET version = ?, manifest = ?, path = ?, sha256 = ?, updated_at = ? WHERE name = ?', prev.version, json(manifest), prev.path, prev.sha256, now, name);
      this.db.run('INSERT INTO updates (id, kind, target, from_version, to_version, status, applied_at, rolled_back_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', newId('upd'), 'plugin-rollback', name, cur.version, prev.version, 'applied', now, now, now);
    });
    this.mount(manifest, prev.path);
    return { name, from: cur.version, to: prev.version };
  }

  async uninstall(name: string) {
    this.registry.unregister(name);
    this.db.run('DELETE FROM plugins WHERE name = ?', name);
  }
}

const ALLOWED_PLUGIN_SCOPES = new Set(['fs.read', 'fs.write', 'net.fetch', 'memory.read', 'memory.write', 'system.read', 'apps.list']);

export function validatePluginManifest(m: PluginManifest) {
  const { entry, author: _a, dependencies: _d, ...rest } = m;
  const r = ToolManifestSchema.safeParse(rest);
  if (!r.success) throw new Error(`Manifesto inválido: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  if (!m.name.startsWith('plugin.')) throw new Error('Plugins devem ter nome iniciado por "plugin." (separado das ferramentas internas).');
  if (!/^[a-z0-9_-]+\.mjs$/.test(entry)) throw new Error('entry deve ser um arquivo .mjs na raiz do plugin.');
  for (const p of m.permissions) if (!ALLOWED_PLUGIN_SCOPES.has(p)) throw new Error(`Plugins não podem solicitar o escopo ${p}.`);
  const writes = m.permissions.some((p) => p.endsWith('.write'));
  if (writes && m.risk === 'low') throw new Error('Plugins que escrevem dados precisam de risco medium ou maior.');
}
