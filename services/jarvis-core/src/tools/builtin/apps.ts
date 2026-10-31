import path from 'node:path';
import type { Tool } from '../types.js';
import { powershell, run, spawnDetached } from '../../util/proc.js';

const isWin = process.platform === 'win32';
const s = (v: unknown) => String(v);

type Proc = { pid: number; name: string; title: string };

export async function listProcesses(): Promise<Proc[]> {
  if (isWin) {
    const r = await powershell("Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress");
    if (r.code !== 0 || !r.stdout.trim()) return [];
    const p = JSON.parse(r.stdout);
    return (Array.isArray(p) ? p : [p]).map((x: { Id: number; ProcessName: string; MainWindowTitle: string }) => ({ pid: x.Id, name: x.ProcessName, title: x.MainWindowTitle }));
  }
  const r = await run('ps', ['-eo', 'pid=,comm='], { timeoutMs: 5000 });
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(.*)$/);
    return { pid: Number(m?.[1]), name: m?.[2] ?? '', title: '' };
  });
}

export function imageName(execPath: string) {
  return path.basename(execPath).replace(/\.exe$/i, '').toLowerCase();
}

async function isRunning(execPath: string, pid?: number): Promise<boolean> {
  const name = imageName(execPath);
  if (isWin) {
    const r = await run('tasklist.exe', ['/FI', `IMAGENAME eq ${name}.exe`, '/FO', 'CSV', '/NH'], { timeoutMs: 8000 });
    if (r.stdout.toLowerCase().includes(`"${name}.exe"`)) return true;
  }
  const procs = await listProcesses();
  return procs.some((p) => p.pid === pid || p.name.toLowerCase().startsWith(name.slice(0, 15)));
}

export const appTools: Tool[] = [
  {
    manifest: {
      name: 'apps.list', version: '1.0.0', category: 'system', permissions: ['apps.list'], risk: 'low', reversible: true, timeoutMs: 5_000, requires: [],
      description: 'Lista os aplicativos que o usuário autorizou o JARVIS a abrir.',
      parameters: { type: 'object', properties: {} },
      returns: 'Aplicativos autorizados',
    },
    async run(_a, ctx) {
      const apps = ctx.perms.apps().filter((a) => ctx.origin !== 'remote' || a.remote);
      return { ok: true, data: apps.map((a) => ({ name: a.name, canClose: a.canClose, remote: a.remote })) };
    },
  },
  {
    manifest: {
      name: 'apps.launch', version: '1.0.0', category: 'system', permissions: ['apps.launch'], risk: 'low', reversible: true, timeoutMs: 20_000, requires: [],
      description: 'Abre um aplicativo autorizado pelo nome (ex.: "Bloco de Notas", "Navegador"). Opcionalmente abre um arquivo de uma pasta autorizada nele.',
      parameters: { type: 'object', properties: { name: { type: 'string' }, file: { type: 'string', description: 'Arquivo a abrir (opcional, precisa estar em pasta autorizada)' } }, required: ['name'] },
      returns: 'PID do processo iniciado',
    },
    async run(a, ctx) {
      const app = ctx.perms.findApp(s(a.name), ctx.origin);
      const extra = a.file ? [ctx.perms.resolvePath(s(a.file), 'read', ctx.origin)] : [];
      const r = await spawnDetached(app.execPath, [...app.args, ...extra]);
      if (!r.pid) return { ok: false, error: `Falha ao iniciar ${app.name}: ${r.error ?? 'desconhecido'}` };
      return { ok: true, data: { app: app.name, pid: r.pid, execPath: app.execPath }, evidence: { pid: r.pid }, undo: app.canClose ? { tool: 'apps.close', args: { name: app.name } } : undefined };
    },
    async verify(a, out, ctx) {
      const app = ctx.perms.findApp(s(a.name), ctx.origin);
      const pid = (out.evidence as { pid: number }).pid;
      // Aguarda a janela/processo aparecer (aplicativos lançadores podem trocar de PID).
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await isRunning(app.execPath, pid)) return { ok: true, detail: `processo de ${app.name} em execução` };
      }
      return { ok: false, detail: `${app.name} não foi encontrado entre os processos em execução` };
    },
  },
  {
    manifest: {
      name: 'apps.running', version: '1.0.0', category: 'system', permissions: ['apps.list'], risk: 'low', reversible: true, timeoutMs: 15_000, requires: [],
      description: 'Lista janelas/processos abertos no momento, com títulos das janelas no Windows.',
      parameters: { type: 'object', properties: { limit: { type: 'integer', default: 60 } } },
      returns: 'Processos com janela',
    },
    async run(a) {
      const procs = await listProcesses();
      return { ok: true, data: { count: procs.length, processes: procs.slice(0, Number(a.limit ?? 60)) } };
    },
  },
  {
    manifest: {
      name: 'apps.active_window', version: '1.0.0', category: 'system', permissions: ['apps.list'], risk: 'low', reversible: true, timeoutMs: 10_000, requires: ['windows'],
      description: 'Identifica a janela ativa (em primeiro plano) e seu processo.',
      parameters: { type: 'object', properties: {} },
      returns: 'Título e processo da janela ativa',
    },
    async available() {
      return isWin ? { ok: true } : { ok: false, reason: 'Disponível somente no Windows' };
    },
    async run() {
      if (!isWin) return { ok: false, error: 'Disponível somente no Windows.' };
      const r = await powershell(`Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }
"@
$h=[W]::GetForegroundWindow(); $sb=New-Object Text.StringBuilder 512; [void][W]::GetWindowText($h,$sb,512); $p=0; [void][W]::GetWindowThreadProcessId($h,[ref]$p)
@{ title=$sb.ToString(); pid=$p; process=(Get-Process -Id $p).ProcessName } | ConvertTo-Json -Compress`);
      if (r.code !== 0) return { ok: false, error: r.stderr.trim() || 'falha ao consultar a janela ativa' };
      return { ok: true, data: JSON.parse(r.stdout) };
    },
  },
  {
    manifest: {
      name: 'apps.focus', version: '1.0.0', category: 'system', permissions: ['apps.launch'], risk: 'low', reversible: true, timeoutMs: 10_000, requires: ['windows'],
      description: 'Traz para frente a janela de um aplicativo autorizado que já esteja aberto.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      returns: 'Se a janela foi ativada',
    },
    async run(a, ctx) {
      if (!isWin) return { ok: false, error: 'Disponível somente no Windows.' };
      const app = ctx.perms.findApp(s(a.name), ctx.origin);
      const img = imageName(app.execPath).replace(/'/g, '');
      const r = await powershell(`$p=Get-Process -Name '${img}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if(-not $p){ 'NOTFOUND'; exit 0 }; (New-Object -ComObject WScript.Shell).AppActivate($p.Id)`);
      const outText = r.stdout.trim();
      if (outText === 'NOTFOUND') return { ok: false, error: `${app.name} não está aberto.` };
      return { ok: outText.toLowerCase() === 'true', data: { app: app.name }, error: outText.toLowerCase() === 'true' ? undefined : 'O Windows recusou a troca de foco.' };
    },
  },
  {
    manifest: {
      name: 'apps.close', version: '1.0.0', category: 'system', permissions: ['apps.close'], risk: 'high', reversible: false, timeoutMs: 15_000, requires: [],
      description: 'Fecha um aplicativo autorizado (somente os marcados como "pode fechar"). Pede para a janela fechar normalmente, sem forçar.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      returns: 'Processos fechados',
    },
    async run(a, ctx) {
      const app = ctx.perms.findApp(s(a.name), ctx.origin);
      if (!app.canClose) return { ok: false, error: `${app.name} não está autorizado a ser fechado pelo JARVIS.` };
      const img = imageName(app.execPath);
      if (isWin) {
        const r = await powershell(`Get-Process -Name '${img.replace(/'/g, '')}' -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }; 'ok'`);
        return r.code === 0 ? { ok: true, data: { app: app.name } } : { ok: false, error: r.stderr };
      }
      const r = await run('pkill', ['-TERM', '-x', img], { timeoutMs: 5000 });
      return r.code === 0 ? { ok: true, data: { app: app.name } } : { ok: false, error: 'Nenhum processo encontrado.' };
    },
    async verify(a, _o, ctx) {
      const app = ctx.perms.findApp(s(a.name), ctx.origin);
      await new Promise((r) => setTimeout(r, 1500));
      return (await isRunning(app.execPath)) ? { ok: false, detail: 'o aplicativo continua aberto (pode estar pedindo para salvar)' } : { ok: true, detail: 'aplicativo fechado' };
    },
  },
];
