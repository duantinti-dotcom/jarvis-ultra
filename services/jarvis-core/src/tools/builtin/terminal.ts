import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Tool, ToolContext } from '../types.js';

/** Comandos que sempre exigem confirmação explícita, mesmo com o terminal liberado. */
const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*r|-[a-z]*f)/i, /\bremove-item\b.*-recurse/i, /\b(rd|rmdir)\s+\/s/i, /\bdel\s+\/[sfq]/i, /\bformat(\.com)?\s+[a-z]:/i,
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D)/i, /\bnpm\s+publish\b/i, /\b(shutdown|restart-computer|stop-computer)\b/i,
  /\breg(\.exe)?\s+(add|delete)\b/i, /\bset-executionpolicy\b/i, /\b(diskpart|bcdedit|cipher\s+\/w)\b/i, /\bcurl\b.*\|\s*(sh|bash|iex)/i, /\biex\b|\binvoke-expression\b/i,
  /\b(runas|start-process\b.*-verb\s+runas)\b/i, /\bmkfs|\bdd\s+if=/i, /:\(\)\s*\{\s*:\|:&\s*\};:/,
];

export function isDestructive(cmd: string) {
  return DESTRUCTIVE.some((r) => r.test(cmd));
}

export type TermChunk = { stream: 'stdout' | 'stderr'; text: string };

/** Executa um comando no shell do sistema dentro de uma pasta autorizada, com streaming. */
export function runShell(cmd: string, cwd: string, signal: AbortSignal, onChunk: (c: TermChunk) => void, timeoutMs = 600_000): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${cmd}`], { cwd, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0' } })
      : spawn('bash', ['-lc', cmd], { cwd, env: { ...process.env, FORCE_COLOR: '0' } });
    let timedOut = false;
    const kill = () => child.kill(isWin ? undefined : 'SIGTERM');
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d: Buffer) => onChunk({ stream: 'stdout', text: d.toString('utf8') }));
    child.stderr.on('data', (d: Buffer) => onChunk({ stream: 'stderr', text: d.toString('utf8') }));
    child.on('error', (e) => onChunk({ stream: 'stderr', text: String(e.message) }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
  });
}

/** Valida pasta e permissões; pede confirmação para comandos destrutivos. */
export async function prepareCommand(ctx: Pick<ToolContext, 'perms' | 'origin' | 'taskId' | 'signal'>, cmd: string, cwdInput: string | undefined) {
  if (!cmd.trim() || cmd.length > 4000) throw new Error('Comando vazio ou longo demais.');
  const roots = ctx.perms.roots().filter((r) => r.access === 'readwrite');
  const cwd = ctx.perms.resolvePath(cwdInput || roots[0]?.path || '', 'write', ctx.origin);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Pasta inexistente: ${cwd}`);
  if (isDestructive(cmd)) {
    const ok = await ctx.perms.requestApproval({ tool: 'terminal.run', args: { command: cmd, cwd }, risk: 'high', reason: 'Comando potencialmente destrutivo no terminal', origin: ctx.origin, taskId: ctx.taskId, signal: ctx.signal });
    if (!ok) throw new Error('Comando destrutivo não aprovado.');
  }
  return cwd;
}

export const terminalTools: Tool[] = [
  {
    manifest: {
      name: 'terminal.run', version: '1.0.0', category: 'programming', permissions: ['terminal.exec'], risk: 'medium', reversible: false, timeoutMs: 600_000, requires: [],
      description: 'Executa um comando de terminal (PowerShell no Windows) dentro de uma pasta autorizada com escrita: npm, pnpm, git, python, testes, builds. Comandos destrutivos pedem confirmação.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string', description: 'Pasta (dentro das autorizadas)' } }, required: ['command'] },
      returns: 'Código de saída e saída do comando',
    },
    async run(a, ctx) {
      const cwd = await prepareCommand(ctx, String(a.command), a.cwd ? String(a.cwd) : undefined);
      let out = '';
      const r = await runShell(String(a.command), cwd, ctx.signal, (c) => { if (out.length < 200_000) out += c.text; }, 590_000);
      const tail = out.length > 12_000 ? '…' + out.slice(-12_000) : out;
      return { ok: true, data: { command: a.command, cwd, exitCode: r.code, timedOut: r.timedOut, output: tail } };
    },
  },
];
