import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext } from '../types.js';
import { sha256, newId } from '../../util/ids.js';

const TEXT_EXT = new Set(['.txt', '.md', '.json', '.csv', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.cs', '.html', '.css', '.scss', '.yml', '.yaml', '.toml', '.ini', '.xml', '.sql', '.sh', '.ps1', '.bat', '.log', '.env.example', '.gitignore']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.venv', 'venv', '.cache']);

const s = (v: unknown) => String(v);

export async function backupFile(ctx: ToolContext, file: string): Promise<string> {
  const dir = path.join(ctx.config.backupsDir, new Date().toISOString().slice(0, 10), newId('bak'));
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, path.basename(file));
  await fsp.cp(file, dest, { recursive: true, preserveTimestamps: true });
  await fsp.writeFile(path.join(dir, 'origin.json'), JSON.stringify({ original: file, at: new Date().toISOString() }));
  return dest;
}

async function* walk(dir: string, depth: number, signal: AbortSignal): AsyncGenerator<{ full: string; dirent: fs.Dirent }> {
  if (signal.aborted) return;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    yield { full, dirent: e };
    if (e.isDirectory() && depth > 0 && !SKIP_DIRS.has(e.name) && !e.isSymbolicLink()) yield* walk(full, depth - 1, signal);
  }
}

export const fsTools: Tool[] = [
  {
    manifest: {
      name: 'fs.list', version: '1.0.0', category: 'files', permissions: ['fs.read'], risk: 'low', reversible: true, timeoutMs: 20_000, requires: [],
      description: 'Lista arquivos e pastas de um diretório autorizado. Use recursive=true para incluir subpastas (até depth níveis).',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Pasta (absoluta ou relativa à primeira pasta autorizada)' }, recursive: { type: 'boolean', default: false }, depth: { type: 'integer', default: 2 }, limit: { type: 'integer', default: 200 } }, required: ['path'] },
      returns: 'Lista de entradas {name, path, type, size, modified}',
    },
    async run(a, ctx) {
      const dir = ctx.perms.resolvePath(s(a.path), 'read', ctx.origin);
      const limit = Math.min(Number(a.limit ?? 200), 2000);
      const out: { name: string; path: string; type: string; size: number; modified: string }[] = [];
      for await (const { full, dirent } of walk(dir, a.recursive ? Number(a.depth ?? 2) : 0, ctx.signal)) {
        const st = await fsp.stat(full).catch(() => null);
        if (!st) continue;
        out.push({ name: dirent.name, path: full, type: dirent.isDirectory() ? 'dir' : 'file', size: st.size, modified: st.mtime.toISOString() });
        if (out.length >= limit) break;
      }
      return { ok: true, data: { dir, count: out.length, truncated: out.length >= limit, entries: out } };
    },
  },
  {
    manifest: {
      name: 'fs.read', version: '1.0.0', category: 'files', permissions: ['fs.read'], risk: 'low', reversible: true, timeoutMs: 15_000, requires: [],
      description: 'Lê o conteúdo de um arquivo de texto ou código em uma pasta autorizada. Para Excel, Word ou PDF use documents.read.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, maxBytes: { type: 'integer', default: 60000 } }, required: ['path'] },
      returns: 'Conteúdo textual do arquivo e se foi truncado',
    },
    async run(a, ctx) {
      const file = ctx.perms.resolvePath(s(a.path), 'read', ctx.origin);
      const st = await fsp.stat(file);
      if (st.isDirectory()) return { ok: false, error: 'O caminho é uma pasta. Use fs.list.' };
      const max = Math.min(Number(a.maxBytes ?? 60000), 500_000);
      const fh = await fsp.open(file, 'r');
      try {
        const buf = Buffer.alloc(Math.min(max, st.size));
        await fh.read(buf, 0, buf.length, 0);
        if (buf.includes(0)) return { ok: false, error: 'Arquivo binário: use a ferramenta de documentos adequada.' };
        return { ok: true, data: { path: file, size: st.size, truncated: st.size > max, content: buf.toString('utf8') } };
      } finally {
        await fh.close();
      }
    },
  },
  {
    manifest: {
      name: 'fs.search', version: '1.0.0', category: 'files', permissions: ['fs.read'], risk: 'low', reversible: true, timeoutMs: 60_000, requires: [],
      description: 'Pesquisa arquivos por nome e, opcionalmente, por conteúdo de texto dentro das pastas autorizadas.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string', description: 'Pasta inicial; padrão: todas as autorizadas' }, content: { type: 'boolean', default: false }, limit: { type: 'integer', default: 50 } }, required: ['query'] },
      returns: 'Arquivos encontrados com trecho correspondente',
    },
    async run(a, ctx) {
      const q = s(a.query).toLowerCase();
      const roots = a.path ? [ctx.perms.resolvePath(s(a.path), 'read', ctx.origin)] : ctx.perms.roots().filter((r) => ctx.origin !== 'remote' || r.remote).map((r) => r.path);
      const limit = Math.min(Number(a.limit ?? 50), 500);
      const hits: { path: string; match: 'name' | 'content'; snippet?: string; modified: string }[] = [];
      let scanned = 0;
      for (const root of roots) {
        for await (const { full, dirent } of walk(root, 8, ctx.signal)) {
          if (hits.length >= limit || scanned > 50_000) break;
          scanned++;
          if (!dirent.isFile()) continue;
          const st = await fsp.stat(full).catch(() => null);
          if (!st) continue;
          if (dirent.name.toLowerCase().includes(q)) {
            hits.push({ path: full, match: 'name', modified: st.mtime.toISOString() });
            continue;
          }
          if (a.content && TEXT_EXT.has(path.extname(dirent.name).toLowerCase()) && st.size < 2_000_000) {
            const txt = await fsp.readFile(full, 'utf8').catch(() => '');
            const i = txt.toLowerCase().indexOf(q);
            if (i >= 0) hits.push({ path: full, match: 'content', snippet: txt.slice(Math.max(0, i - 60), i + 100).replace(/\s+/g, ' '), modified: st.mtime.toISOString() });
          }
        }
      }
      return { ok: true, data: { query: a.query, scanned, count: hits.length, hits } };
    },
  },
  {
    manifest: {
      name: 'fs.recent', version: '1.0.0', category: 'files', permissions: ['fs.read'], risk: 'low', reversible: true, timeoutMs: 60_000, requires: [],
      description: 'Lista os arquivos modificados recentemente em uma pasta autorizada (ex.: "o que mudou no meu projeto hoje").',
      parameters: { type: 'object', properties: { path: { type: 'string' }, hours: { type: 'number', default: 24 }, limit: { type: 'integer', default: 50 } } },
      returns: 'Arquivos ordenados por data de modificação',
    },
    async run(a, ctx) {
      const roots = a.path ? [ctx.perms.resolvePath(s(a.path), 'read', ctx.origin)] : ctx.perms.roots().filter((r) => ctx.origin !== 'remote' || r.remote).map((r) => r.path);
      const since = Date.now() - Number(a.hours ?? 24) * 3600_000;
      const files: { path: string; modified: string; size: number }[] = [];
      for (const root of roots) {
        for await (const { full, dirent } of walk(root, 8, ctx.signal)) {
          if (!dirent.isFile()) continue;
          const st = await fsp.stat(full).catch(() => null);
          if (st && st.mtimeMs >= since) files.push({ path: full, modified: st.mtime.toISOString(), size: st.size });
        }
      }
      files.sort((x, y) => y.modified.localeCompare(x.modified));
      return { ok: true, data: { sinceHours: Number(a.hours ?? 24), count: files.length, files: files.slice(0, Number(a.limit ?? 50)) } };
    },
  },
  {
    manifest: {
      name: 'fs.write', version: '1.0.0', category: 'files', permissions: ['fs.write'], risk: 'medium', reversible: true, timeoutMs: 15_000, requires: [],
      description: 'Cria ou sobrescreve um arquivo de texto em uma pasta autorizada. Faz backup automático antes de sobrescrever. Use append=true para acrescentar.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, overwrite: { type: 'boolean', default: false }, append: { type: 'boolean', default: false } }, required: ['path', 'content'] },
      returns: 'Caminho, tamanho e hash SHA-256 do arquivo escrito',
    },
    async run(a, ctx) {
      const file = ctx.perms.resolvePath(s(a.path), 'write', ctx.origin);
      const exists = fs.existsSync(file);
      if (exists && fs.statSync(file).isDirectory()) return { ok: false, error: 'O caminho é uma pasta.' };
      if (exists && !a.overwrite && !a.append) return { ok: false, error: `O arquivo já existe: ${file}. Use overwrite=true para substituir (será feito backup).` };
      const backup = exists ? await backupFile(ctx, file) : null;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      if (a.append) await fsp.appendFile(file, s(a.content), 'utf8');
      else await fsp.writeFile(file, s(a.content), 'utf8');
      const finalContent = await fsp.readFile(file);
      return {
        ok: true,
        data: { path: file, bytes: finalContent.length, created: !exists, backup },
        evidence: { sha256: sha256(finalContent), bytes: finalContent.length },
        undo: backup ? { tool: 'fs.restore', args: { backup, path: file } } : { tool: 'fs.delete', args: { path: file } },
      };
    },
    async verify(a, out, ctx) {
      const file = ctx.perms.resolvePath(s(a.path), 'read', ctx.origin);
      if (!fs.existsSync(file)) return { ok: false, detail: 'arquivo não existe após a escrita' };
      const h = sha256(await fsp.readFile(file));
      const expected = (out.evidence as { sha256: string }).sha256;
      if (h !== expected) return { ok: false, detail: 'hash diferente do esperado' };
      if (!a.append && h !== sha256(Buffer.from(s(a.content), 'utf8'))) return { ok: false, detail: 'conteúdo gravado difere do solicitado' };
      return { ok: true, detail: `arquivo confirmado em disco (sha256 ${h.slice(0, 12)}…)` };
    },
  },
  {
    manifest: {
      name: 'fs.mkdir', version: '1.0.0', category: 'files', permissions: ['fs.write'], risk: 'low', reversible: true, timeoutMs: 10_000, requires: [],
      description: 'Cria uma pasta (e as intermediárias) dentro de uma pasta autorizada.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      returns: 'Caminho da pasta criada',
    },
    async run(a, ctx) {
      const dir = ctx.perms.resolvePath(s(a.path), 'write', ctx.origin);
      const existed = fs.existsSync(dir);
      await fsp.mkdir(dir, { recursive: true });
      return { ok: true, data: { path: dir, created: !existed } };
    },
    async verify(a, _o, ctx) {
      const dir = ctx.perms.resolvePath(s(a.path), 'read', ctx.origin);
      return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? { ok: true, detail: 'pasta existe' } : { ok: false, detail: 'pasta não encontrada' };
    },
  },
  {
    manifest: {
      name: 'fs.copy', version: '1.0.0', category: 'files', permissions: ['fs.read', 'fs.write'], risk: 'medium', reversible: true, timeoutMs: 120_000, requires: [],
      description: 'Copia um arquivo ou pasta para outro local autorizado. Não sobrescreve sem overwrite=true.',
      parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, overwrite: { type: 'boolean', default: false } }, required: ['from', 'to'] },
      returns: 'Origem e destino',
    },
    async run(a, ctx) {
      const from = ctx.perms.resolvePath(s(a.from), 'read', ctx.origin);
      const to = ctx.perms.resolvePath(s(a.to), 'write', ctx.origin);
      if (fs.existsSync(to) && !a.overwrite) return { ok: false, error: `Destino já existe: ${to}` };
      const backup = fs.existsSync(to) ? await backupFile(ctx, to) : null;
      await fsp.cp(from, to, { recursive: true, force: !!a.overwrite, errorOnExist: !a.overwrite });
      return { ok: true, data: { from, to, backup }, undo: { tool: 'fs.delete', args: { path: to } } };
    },
    async verify(a, _o, ctx) {
      const to = ctx.perms.resolvePath(s(a.to), 'read', ctx.origin);
      return fs.existsSync(to) ? { ok: true, detail: 'destino existe' } : { ok: false, detail: 'destino não encontrado' };
    },
  },
  {
    manifest: {
      name: 'fs.move', version: '1.0.0', category: 'files', permissions: ['fs.write'], risk: 'medium', reversible: true, timeoutMs: 60_000, requires: [],
      description: 'Move ou renomeia um arquivo ou pasta dentro das pastas autorizadas.',
      parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
      returns: 'Origem e destino',
    },
    async run(a, ctx) {
      const from = ctx.perms.resolvePath(s(a.from), 'write', ctx.origin);
      const to = ctx.perms.resolvePath(s(a.to), 'write', ctx.origin);
      if (!fs.existsSync(from)) return { ok: false, error: `Origem não existe: ${from}` };
      if (fs.existsSync(to)) return { ok: false, error: `Destino já existe: ${to}` };
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to).catch(async (e: NodeJS.ErrnoException) => {
        if (e.code !== 'EXDEV') throw e;
        await fsp.cp(from, to, { recursive: true });
        await fsp.rm(from, { recursive: true });
      });
      return { ok: true, data: { from, to }, undo: { tool: 'fs.move', args: { from: to, to: from } } };
    },
    async verify(a, _o, ctx) {
      const from = ctx.perms.resolvePath(s(a.from), 'read', ctx.origin);
      const to = ctx.perms.resolvePath(s(a.to), 'read', ctx.origin);
      return fs.existsSync(to) && !fs.existsSync(from) ? { ok: true, detail: 'movido' } : { ok: false, detail: 'estado inesperado após mover' };
    },
  },
  {
    manifest: {
      name: 'fs.delete', version: '1.0.0', category: 'files', permissions: ['fs.delete'], risk: 'high', reversible: true, timeoutMs: 60_000, requires: [],
      description: 'Remove um arquivo ou pasta autorizada. O item é movido para os backups do JARVIS antes, permitindo restauração.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      returns: 'Caminho removido e local do backup',
    },
    async run(a, ctx) {
      const target = ctx.perms.resolvePath(s(a.path), 'write', ctx.origin);
      if (ctx.perms.roots().some((r) => path.resolve(r.path) === path.resolve(target))) return { ok: false, error: 'Não é permitido excluir uma pasta autorizada inteira.' };
      if (!fs.existsSync(target)) return { ok: false, error: `Não existe: ${target}` };
      const backup = await backupFile(ctx, target);
      await fsp.rm(target, { recursive: true });
      return { ok: true, data: { path: target, backup }, undo: { tool: 'fs.restore', args: { backup, path: target } } };
    },
    async verify(a, out) {
      const d = out.data as { path: string; backup: string };
      return !fs.existsSync(d.path) && fs.existsSync(d.backup) ? { ok: true, detail: 'removido; backup preservado' } : { ok: false, detail: 'remoção não confirmada' };
    },
  },
  {
    manifest: {
      name: 'fs.restore', version: '1.0.0', category: 'files', permissions: ['fs.write'], risk: 'medium', reversible: false, timeoutMs: 60_000, requires: [],
      description: 'Restaura um arquivo a partir de um backup criado pelo JARVIS (reverter alteração).',
      parameters: { type: 'object', properties: { backup: { type: 'string' }, path: { type: 'string' } }, required: ['backup', 'path'] },
      returns: 'Arquivo restaurado',
    },
    async run(a, ctx) {
      const backup = path.resolve(s(a.backup));
      const rel = path.relative(ctx.config.backupsDir, backup);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'O backup precisa estar na pasta de backups do JARVIS.' };
      const target = ctx.perms.resolvePath(s(a.path), 'write', ctx.origin);
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.cp(backup, target, { recursive: true, preserveTimestamps: true });
      return { ok: true, data: { restored: target } };
    },
    async verify(a, _o, ctx) {
      const target = ctx.perms.resolvePath(s(a.path), 'read', ctx.origin);
      return fs.existsSync(target) ? { ok: true, detail: 'restaurado' } : { ok: false, detail: 'não restaurado' };
    },
  },
];
