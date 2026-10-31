import { execFile, spawn } from 'node:child_process';

export type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/** Executa um binário sem shell, com timeout e limite de saída. */
export function run(cmd: string, args: string[], opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: opts.timeoutMs ?? 15_000, cwd: opts.cwd, env: opts.env, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal: opts.signal, encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, stdout: stdout ?? '', stderr: stderr ?? (e ? String(e.message) : ''), timedOut: !!e?.killed });
    });
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

/** PowerShell com -EncodedCommand: evita problemas de escape de aspas. */
export function powershell(script: string, timeoutMs = 15_000) {
  const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;${script}`, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeoutMs });
}

export async function which(bin: string): Promise<string | null> {
  const r = process.platform === 'win32' ? await run('where.exe', [bin], { timeoutMs: 5000 }) : await run('sh', ['-c', `command -v "${bin.replace(/"/g, '')}"`], { timeoutMs: 5000 });
  return r.code === 0 ? r.stdout.split(/\r?\n/)[0]!.trim() || null : null;
}

export function spawnDetached(cmd: string, args: string[]) {
  return new Promise<{ pid: number | undefined; error?: string }>((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
      child.once('error', (e) => resolve({ pid: undefined, error: e.message }));
      child.once('spawn', () => {
        child.unref();
        resolve({ pid: child.pid });
      });
    } catch (e) {
      resolve({ pid: undefined, error: (e as Error).message });
    }
  });
}
