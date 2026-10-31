import type { Tool } from '../types.js';
import { powershell } from '../../util/proc.js';

const isWin = process.platform === 'win32';
const s = (v: unknown) => String(v);
const psq = (v: unknown) => s(v).replace(/'/g, "''");
const winOnly = async () => (isWin ? { ok: true } : { ok: false, reason: 'Disponível somente no Windows' });

/** Encontra a janela de um aplicativo AUTORIZADO pelo título ou processo. */
const FIND_WINDOW = (title: string) => `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$root=[System.Windows.Automation.AutomationElement]::RootElement
$cond=[System.Windows.Automation.Condition]::TrueCondition
$wins=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$cond)
$w=$null
foreach($x in $wins){ if($x.Current.Name -like '*${psq(title)}*'){ $w=$x; break } }
if(-not $w){ Write-Error 'JANELA_NAO_ENCONTRADA'; exit 2 }`;

const INPUT_TYPES = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class JIn {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@`;

/** Garante que a janela-alvo pertence a um app autorizado (a ação não sai do app permitido). */
async function assertAuthorizedWindow(title: string, ctx: Parameters<Tool['run']>[1]) {
  const apps = ctx.perms.apps().filter((a) => ctx.origin !== 'remote' || a.remote);
  const r = await powershell(`${FIND_WINDOW(title)}
$p=Get-Process -Id $w.Current.ProcessId
@{ name=$w.Current.Name; process=$p.ProcessName; path=$p.Path; handle=[int64]$w.Current.NativeWindowHandle } | ConvertTo-Json -Compress`);
  if (r.code !== 0) throw new Error(r.stderr.includes('JANELA_NAO_ENCONTRADA') ? `Janela "${title}" não encontrada.` : r.stderr.trim());
  const info = JSON.parse(r.stdout) as { name: string; process: string; path: string | null; handle: number };
  const proc = info.process.toLowerCase();
  const ok = apps.some((a) => {
    const exe = a.execPath.toLowerCase().replace(/\\/g, '/').split('/').pop()!.replace(/\.exe$/, '');
    return exe === proc || (info.path ?? '').toLowerCase() === a.execPath.toLowerCase();
  });
  if (!ok) throw new Error(`"${info.name}" (${info.process}) não está na lista de aplicativos autorizados. Libere-o em Desktop Control → Permissões.`);
  return info;
}

const base = { version: '1.0.0', category: 'system' as const, requires: ['windows'], reversible: false };

export const inputTools: Tool[] = [
  {
    manifest: { ...base, name: 'ui.inspect', permissions: ['apps.list'], risk: 'low', reversible: true, timeoutMs: 30_000,
      description: 'Lê a interface de uma janela de um app autorizado via UI Automation: botões, campos, menus e textos com nome, tipo e posição. Use antes de interagir.',
      parameters: { type: 'object', properties: { window: { type: 'string', description: 'Parte do título da janela' }, limit: { type: 'integer', default: 120 } }, required: ['window'] }, returns: 'Elementos da janela' },
    available: winOnly,
    async run(a, ctx) {
      if (!isWin) return { ok: false, error: 'Disponível somente no Windows.' };
      await assertAuthorizedWindow(s(a.window), ctx);
      const r = await powershell(`${FIND_WINDOW(s(a.window))}
$all=$w.FindAll([System.Windows.Automation.TreeScope]::Descendants,$cond)
$out=@(); $i=0
foreach($e in $all){ if($i -ge ${Number(a.limit ?? 120)}){break}; $c=$e.Current; if(-not $c.IsOffscreen -and ($c.Name -or $c.AutomationId)){ $b=$c.BoundingRectangle; $out+=@{ name=$c.Name; type=$c.ControlType.ProgrammaticName -replace 'ControlType.',''; id=$c.AutomationId; enabled=$c.IsEnabled; x=[int]($b.X+$b.Width/2); y=[int]($b.Y+$b.Height/2) }; $i++ } }
@{ window=$w.Current.Name; elements=$out } | ConvertTo-Json -Depth 4 -Compress`, 30_000);
      if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
      return { ok: true, data: JSON.parse(r.stdout) };
    },
  },
  {
    manifest: { ...base, name: 'ui.invoke', permissions: ['input.control'], risk: 'medium', timeoutMs: 30_000,
      description: 'Aciona um elemento (botão, item de menu, link) de uma janela autorizada pelo nome visível, via UI Automation. Mais confiável que clicar por coordenadas.',
      parameters: { type: 'object', properties: { window: { type: 'string' }, element: { type: 'string', description: 'Nome visível do elemento' } }, required: ['window', 'element'] }, returns: 'Elemento acionado' },
    available: winOnly,
    async run(a, ctx) {
      if (!isWin) return { ok: false, error: 'Disponível somente no Windows.' };
      await assertAuthorizedWindow(s(a.window), ctx);
      const r = await powershell(`${FIND_WINDOW(s(a.window))}
$nc=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'${psq(a.element)}')
$e=$w.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$nc)
if(-not $e){ Write-Error 'ELEMENTO_NAO_ENCONTRADO'; exit 3 }
$p=$null
if($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$p)){ $p.Invoke(); 'invoke' }
elseif($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$p)){ $p.Toggle(); 'toggle' }
elseif($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$p)){ $p.Select(); 'select' }
elseif($e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$p)){ $p.Expand(); 'expand' }
else { Write-Error 'SEM_PADRAO_DE_ACAO'; exit 4 }`);
      if (r.code !== 0) {
        const e = r.stderr;
        return { ok: false, error: e.includes('ELEMENTO_NAO_ENCONTRADO') ? `Elemento "${a.element}" não encontrado. Use ui.inspect para ver os nomes.` : e.includes('SEM_PADRAO') ? 'O elemento não aceita acionamento direto; tente input.click nas coordenadas dele.' : e.trim() };
      }
      return { ok: true, data: { window: a.window, element: a.element, action: r.stdout.trim() } };
    },
  },
  {
    manifest: { ...base, name: 'input.click', permissions: ['input.control'], risk: 'medium', timeoutMs: 15_000,
      description: 'Move o mouse e clica numa posição da tela, DENTRO de uma janela de app autorizado (coordenadas de ui.inspect). Use ui.invoke quando possível.',
      parameters: { type: 'object', properties: { window: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' }, button: { type: 'string', enum: ['left', 'right'], default: 'left' }, double: { type: 'boolean', default: false } }, required: ['window', 'x', 'y'] }, returns: 'Clique realizado' },
    available: winOnly,
    async run(a, ctx) {
      if (!isWin) return { ok: false, error: 'Disponível somente no Windows.' };
      const win = await assertAuthorizedWindow(s(a.window), ctx);
      const [down, up] = a.button === 'right' ? [0x0008, 0x0010] : [0x0002, 0x0004];
      const clicks = a.double ? 2 : 1;
      const r = await powershell(`${INPUT_TYPES}
${FIND_WINDOW(s(a.window))}
$b=$w.Current.BoundingRectangle
if(${Number(a.x)} -lt $b.Left -or ${Number(a.x)} -gt $b.Right -or ${Number(a.y)} -lt $b.Top -or ${Number(a.y)} -gt $b.Bottom){ Write-Error 'FORA_DA_JANELA'; exit 5 }
[void][JIn]::SetForegroundWindow([IntPtr]${win.handle}); Start-Sleep -Milliseconds 120
[void][JIn]::SetCursorPos(${Number(a.x)}, ${Number(a.y)})
for($i=0;$i -lt ${clicks};$i++){ [JIn]::mouse_event(${down},0,0,0,[UIntPtr]::Zero); [JIn]::mouse_event(${up},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }
'ok'`);
      if (r.code !== 0) return { ok: false, error: r.stderr.includes('FORA_DA_JANELA') ? 'Coordenadas fora da janela autorizada: clique bloqueado.' : r.stderr.trim() };
      return { ok: true, data: { window: win.name, x: a.x, y: a.y } };
    },
  },
  {
    manifest: { ...base, name: 'input.type', permissions: ['input.control'], risk: 'medium', timeoutMs: 30_000,
      description: 'Digita texto na janela de um app autorizado (traz a janela para frente antes). Não use para senhas.',
      parameters: { type: 'object', properties: { window: { type: 'string' }, text: { type: 'string' } }, required: ['window', 'text'] }, returns: 'Texto digitado' },
    available: winOnly,
    async run(a, ctx) {
      if (!isWin) return { ok: false, error: 'Disponível somente no Windows.' };
      const win = await assertAuthorizedWindow(s(a.window), ctx);
      // SendKeys interpreta + ^ % ~ ( ) { } [ ] — escapamos tudo para digitar literalmente.
      const escaped = s(a.text).replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/\r?\n/g, '{ENTER}');
      const r = await powershell(`Add-Type -AssemblyName System.Windows.Forms
${INPUT_TYPES}
[void][JIn]::SetForegroundWindow([IntPtr]${win.handle}); Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('${psq(escaped)}'); 'ok'`, 30_000);
      return r.code === 0 ? { ok: true, data: { window: win.name, chars: s(a.text).length } } : { ok: false, error: r.stderr.trim() };
    },
  },
  {
    manifest: { ...base, name: 'input.keys', permissions: ['input.control'], risk: 'medium', timeoutMs: 15_000,
      description: 'Envia um atalho de teclado para a janela de um app autorizado. Ex.: "ctrl+s", "ctrl+shift+n", "enter", "tab", "alt+f4" (fechar exige app com permissão de fechar).',
      parameters: { type: 'object', properties: { window: { type: 'string' }, keys: { type: 'string' } }, required: ['window', 'keys'] }, returns: 'Atalho enviado' },
    available: winOnly,
    async run(a, ctx) {
      if (!isWin) return { ok: false, error: 'Disponível somente no Windows.' };
      const keys = s(a.keys).toLowerCase().replace(/\s+/g, '');
      if (/alt\+f4/.test(keys)) {
        const app = ctx.perms.apps().find((x) => s(a.window).toLowerCase().includes(x.name.toLowerCase()));
        if (!app?.canClose) return { ok: false, error: 'Fechar janelas por atalho exige um app marcado como "pode fechar".' };
      }
      const win = await assertAuthorizedWindow(s(a.window), ctx);
      const map: Record<string, string> = { enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', backspace: '{BACKSPACE}', delete: '{DELETE}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', space: ' ', f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}', f10: '{F10}', f11: '{F11}', f12: '{F12}' };
      const parts = keys.split('+');
      const key = parts.pop()!;
      const mods = parts.map((m) => ({ ctrl: '^', control: '^', shift: '+', alt: '%' })[m] ?? '').join('');
      const k = map[key] ?? (key.length === 1 ? key : null);
      if (!k) return { ok: false, error: `Tecla não suportada: ${key}` };
      const r = await powershell(`Add-Type -AssemblyName System.Windows.Forms
${INPUT_TYPES}
[void][JIn]::SetForegroundWindow([IntPtr]${win.handle}); Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('${psq(mods + k)}'); 'ok'`);
      return r.code === 0 ? { ok: true, data: { window: win.name, keys: a.keys } } : { ok: false, error: r.stderr.trim() };
    },
  },
];
