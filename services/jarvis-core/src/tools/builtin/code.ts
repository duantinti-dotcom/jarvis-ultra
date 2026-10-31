import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Tool } from '../types.js';
import { run, which } from '../../util/proc.js';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '__pycache__', '.venv', 'venv', 'out', 'coverage']);

/** Comandos de projeto permitidos. Nada fora desta lista é executado. */
const ALLOWED_COMMANDS: Record<string, { bin: string; args: string[] }> = {
  'npm test': { bin: 'npm', args: ['test', '--silent'] },
  'npm run build': { bin: 'npm', args: ['run', 'build'] },
  'npm run lint': { bin: 'npm', args: ['run', 'lint'] },
  'pnpm test': { bin: 'pnpm', args: ['test'] },
  'pnpm build': { bin: 'pnpm', args: ['build'] },
  'npx tsc --noEmit': { bin: 'npx', args: ['tsc', '--noEmit'] },
  'python -m pytest': { bin: 'python', args: ['-m', 'pytest', '-q'] },
  'cargo test': { bin: 'cargo', args: ['test'] },
  'cargo check': { bin: 'cargo', args: ['check'] },
  'go test': { bin: 'go', args: ['test', './...'] },
};

export const codeTools: Tool[] = [
  {
    manifest: {
      name: 'code.analyze_project', version: '1.0.0', category: 'programming', permissions: ['fs.read'], risk: 'low', reversible: true, timeoutMs: 60_000, requires: [],
      description: 'Analisa um projeto de programação: detecta linguagens e frameworks, scripts, estrutura de pastas, tamanho e marcadores TODO/FIXME.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      returns: 'Resumo técnico do projeto',
    },
    async run(a, ctx) {
      const root = ctx.perms.resolvePath(String(a.path), 'read', ctx.origin);
      const byExt: Record<string, { files: number; lines: number }> = {};
      const todos: { file: string; line: number; text: string }[] = [];
      const tree: string[] = [];
      let files = 0;
      const walk = async (dir: string, depth: number) => {
        if (files > 5000 || ctx.signal.aborted) return;
        for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (SKIP.has(e.name) || e.name.startsWith('.') && e.name !== '.github') continue;
          const full = path.join(dir, e.name);
          const rel = path.relative(root, full);
          if (e.isDirectory()) {
            if (depth < 2) tree.push(rel + '/');
            await walk(full, depth + 1);
          } else if (e.isFile()) {
            files++;
            if (depth < 2 && tree.length < 120) tree.push(rel);
            const ext = path.extname(e.name).toLowerCase() || e.name;
            const st = await fsp.stat(full);
            const entry = (byExt[ext] ??= { files: 0, lines: 0 });
            entry.files++;
            if (st.size < 1_000_000 && /\.(ts|tsx|js|jsx|mjs|py|rs|go|java|cs|c|cpp|h|vue|svelte|css|scss|html|sql|rb|php|kt|swift)$/.test(ext)) {
              const txt = await fsp.readFile(full, 'utf8').catch(() => '');
              const lines = txt.split('\n');
              entry.lines += lines.length;
              lines.forEach((l, i) => {
                if (todos.length < 40 && /\b(TODO|FIXME|HACK|XXX)\b/.test(l)) todos.push({ file: rel, line: i + 1, text: l.trim().slice(0, 140) });
              });
            }
          }
        }
      };
      await walk(root, 0);
      const manifests: Record<string, unknown> = {};
      const pkgPath = path.join(root, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(await fsp.readFile(pkgPath, 'utf8'));
        manifests.packageJson = { name: pkg.name, scripts: pkg.scripts, dependencies: Object.keys(pkg.dependencies ?? {}), devDependencies: Object.keys(pkg.devDependencies ?? {}) };
      }
      for (const f of ['pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'tsconfig.json', 'Dockerfile', 'README.md']) if (fs.existsSync(path.join(root, f))) manifests[f] = true;
      const git = fs.existsSync(path.join(root, '.git'));
      return { ok: true, data: { root, files, git, languages: Object.entries(byExt).sort((x, y) => y[1].lines - x[1].lines).slice(0, 12), manifests, todos, tree: tree.slice(0, 120) } };
    },
  },
  {
    manifest: {
      name: 'code.git', version: '1.0.0', category: 'programming', permissions: ['fs.read'], risk: 'low', reversible: true, timeoutMs: 30_000, requires: ['git'],
      description: 'Consulta Git (somente leitura) em um projeto autorizado: status, diff, log ou branches.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, action: { type: 'string', enum: ['status', 'diff', 'log', 'branches'] } }, required: ['path', 'action'] },
      returns: 'Saída do Git',
    },
    async available() {
      return (await which('git')) ? { ok: true } : { ok: false, reason: 'Git não instalado' };
    },
    async run(a, ctx) {
      const root = ctx.perms.resolvePath(String(a.path), 'read', ctx.origin);
      const args = { status: ['status', '--short', '--branch'], diff: ['diff', '--stat', '--patch', '--no-color', '-U2'], log: ['log', '--oneline', '-n', '20'], branches: ['branch', '-a'] }[String(a.action) as 'status'];
      const r = await run('git', ['-C', root, ...args], { timeoutMs: 25_000 });
      if (r.code !== 0) return { ok: false, error: r.stderr.trim() || 'git falhou' };
      return { ok: true, data: { output: r.stdout.slice(0, 30_000), truncated: r.stdout.length > 30_000 } };
    },
  },
  {
    manifest: {
      name: 'code.run', version: '1.0.0', category: 'programming', permissions: ['lab.execute', 'fs.read'], risk: 'high', reversible: false, timeoutMs: 600_000, requires: [],
      description: `Executa um comando de projeto da lista permitida (testes/build) dentro de uma pasta autorizada. Sempre pede aprovação. Comandos: ${Object.keys(ALLOWED_COMMANDS).join(' | ')}`,
      parameters: { type: 'object', properties: { path: { type: 'string' }, command: { type: 'string', enum: Object.keys(ALLOWED_COMMANDS) } }, required: ['path', 'command'] },
      returns: 'Código de saída, stdout e stderr',
    },
    async run(a, ctx) {
      const root = ctx.perms.resolvePath(String(a.path), 'read', ctx.origin);
      const spec = ALLOWED_COMMANDS[String(a.command)];
      if (!spec) return { ok: false, error: 'Comando fora da lista permitida.' };
      const bin = process.platform === 'win32' && ['npm', 'pnpm', 'npx'].includes(spec.bin) ? `${spec.bin}.cmd` : spec.bin;
      const r = await run(bin, spec.args, { cwd: root, timeoutMs: 590_000, signal: ctx.signal, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
      const tail = (s: string) => (s.length > 12_000 ? '…' + s.slice(-12_000) : s);
      return { ok: true, data: { command: a.command, exitCode: r.code, passed: r.code === 0, timedOut: r.timedOut, stdout: tail(r.stdout), stderr: tail(r.stderr) } };
    },
  },
];
