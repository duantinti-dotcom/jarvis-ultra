import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Executor isolado: processo Node separado com o Permission Model ativo
 * (--permission): sem leitura/escrita fora das pastas permitidas, sem
 * child_process, sem workers e sem addons nativos. Variáveis de ambiente
 * são removidas. Limites de memória e tempo aplicados pelo host.
 */
const RUNNER = `
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';
const [entry, mode] = process.argv.slice(2);
const rl = readline.createInterface({ input: process.stdin });
const pending = new Map(); let seq = 0; let started = false;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const api = { call: (tool, args) => new Promise((res) => { const id = ++seq; pending.set(id, res); send({ type: 'call', id, tool, args }); }), log: (...m) => send({ type: 'log', message: m.map(String).join(' ') }) };
rl.on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'result') { pending.get(msg.id)?.(msg.result); pending.delete(msg.id); return; }
  if (msg.type !== 'start' || started) return; started = true;
  try {
    const mod = await import(pathToFileURL(entry).href);
    if (mode === 'test') { const fn = mod.default ?? mod.test; await fn(); send({ type: 'done', result: { ok: true } }); }
    else { const r = await mod.run(msg.args ?? {}, api); send({ type: 'done', result: r }); }
  } catch (e) { send({ type: 'done', result: { ok: false, error: String(e && e.stack || e).slice(0, 4000) } }); }
  process.exit(0);
});
`;

export function ensureRunner(runtimeDir: string) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const file = path.join(runtimeDir, 'sandbox-runner.mjs');
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== RUNNER) fs.writeFileSync(file, RUNNER);
  return file;
}

export type SandboxResult = { ok: boolean; result?: { ok: boolean; data?: unknown; error?: string }; stdout: string; stderr: string; logs: string[]; timedOut: boolean; exitCode: number | null; durationMs: number };

export function runSandboxed(opts: {
  runner: string; entry: string; readDirs: string[]; writeDirs: string[]; mode: 'run' | 'test'; args?: unknown;
  timeoutMs: number; memoryMb?: number; onCall?: (tool: string, args: unknown) => Promise<unknown>; signal?: AbortSignal;
}): Promise<SandboxResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const flags = [
      '--permission',
      // Uma flag por pasta (o Node 22 não aceita listas separadas por vírgula).
      ...[path.dirname(opts.runner), ...opts.readDirs].map((d) => `--allow-fs-read=${d}`),
      ...opts.writeDirs.map((d) => `--allow-fs-write=${d}`),
      `--max-old-space-size=${opts.memoryMb ?? 128}`,
      '--disable-proto=throw',
    ];
    const child = spawn(process.execPath, [...flags, opts.runner, opts.entry, opts.mode], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { NODE_NO_WARNINGS: '1', SystemRoot: process.env.SystemRoot ?? '' },
      cwd: path.dirname(opts.entry),
    });
    let stdout = '', stderr = '', buf = '';
    const logs: string[] = [];
    let result: SandboxResult['result'];
    let timedOut = false;
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    opts.signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', async (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 2_000_000) kill();
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { type: string; id?: number; tool?: string; args?: unknown; result?: SandboxResult['result']; message?: string };
        try { msg = JSON.parse(line); } catch { logs.push(line); continue; }
        if (msg.type === 'done') result = msg.result;
        else if (msg.type === 'log') logs.push(String(msg.message).slice(0, 2000));
        else if (msg.type === 'call') {
          const r = opts.onCall ? await opts.onCall(String(msg.tool), msg.args).catch((e) => ({ ok: false, error: String(e) })) : { ok: false, error: 'Chamadas a ferramentas não são permitidas neste contexto.' };
          child.stdin.write(JSON.stringify({ type: 'result', id: msg.id, result: r }) + '\n');
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.length > 200_000) kill(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0 && !!result?.ok, result, stdout: stdout.slice(-20_000), stderr: stderr.slice(-20_000), logs, timedOut, exitCode: code, durationMs: Date.now() - started });
    });
    child.stdin.write(JSON.stringify({ type: 'start', args: opts.args ?? {} }) + '\n');
  });
}
