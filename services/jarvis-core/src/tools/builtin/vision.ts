import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { Tool, ToolContext } from '../types.js';
import { powershell, run, which } from '../../util/proc.js';
import { newId, nowIso } from '../../util/ids.js';
import { untrusted } from './untrusted.js';
import type { Bus } from '../../bus.js';
import type { OllamaClient } from '../../brain/ollama.js';
import type { ModelRouter } from '../../brain/router.js';

const isWin = process.platform === 'win32';

function capturesDir(ctx: ToolContext) {
  const d = path.join(ctx.config.dataDir, 'captures');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Imagens só podem vir da pasta de capturas do JARVIS ou de pastas autorizadas. */
function resolveImage(ctx: ToolContext, p: string) {
  const abs = path.resolve(p);
  const rel = path.relative(capturesDir(ctx), abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return abs;
  return ctx.perms.resolvePath(p, 'read', ctx.origin);
}

async function captureWindows(file: string, windowTitle?: string) {
  const esc = (windowTitle ?? '').replace(/'/g, "''");
  const script = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class R { [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,Ri,B; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[void][R]::SetProcessDPIAware()
$title='${esc}'
if ($title) {
  $p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$title*" } | Select-Object -First 1
  if (-not $p) { Write-Error 'JANELA_NAO_ENCONTRADA'; exit 2 }
  $r = New-Object R+RECT; [void][R]::GetWindowRect($p.MainWindowHandle, [ref]$r)
  $x=$r.L; $y=$r.T; $w=$r.Ri-$r.L; $h=$r.B-$r.T
} else { $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $x=$b.X; $y=$b.Y; $w=$b.Width; $h=$b.Height }
$bmp = New-Object System.Drawing.Bitmap $w,$h
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($x,$y,0,0,$bmp.Size)
$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
"$w x $h"`;
  return powershell(script, 20_000);
}

export function visionTools(bus: Bus, ollama: OllamaClient, router: ModelRouter): Tool[] {
  return [
    {
      manifest: {
        name: 'screen.capture', version: '1.0.0', category: 'vision', permissions: ['screen.capture'], risk: 'medium', reversible: true, timeoutMs: 30_000, requires: ['windows|x11'],
        description: 'Captura UMA imagem da tela inteira ou de uma janela (pelo título). Nunca captura continuamente. A interface mostra um aviso a cada captura.',
        parameters: { type: 'object', properties: { window: { type: 'string', description: 'Parte do título da janela; vazio = tela inteira' } } },
        returns: 'Caminho do PNG capturado',
      },
      async available() {
        if (isWin) return { ok: true };
        return (await which('import')) || (await which('grim')) ? { ok: true } : { ok: false, reason: 'Sem utilitário de captura (Windows, ImageMagick import ou grim)' };
      },
      async run(a, ctx) {
        const file = path.join(capturesDir(ctx), `${newId('scr')}.png`);
        if (isWin) {
          const r = await captureWindows(file, a.window ? String(a.window) : undefined);
          if (r.code !== 0) return { ok: false, error: r.stderr.includes('JANELA_NAO_ENCONTRADA') ? `Janela "${a.window}" não encontrada.` : r.stderr.trim() || 'falha na captura' };
        } else if (await which('import')) {
          const r = await run('import', ['-window', 'root', file], { timeoutMs: 15000 });
          if (r.code !== 0) return { ok: false, error: r.stderr || 'falha na captura (sem servidor gráfico?)' };
        } else {
          const r = await run('grim', [file], { timeoutMs: 15000 });
          if (r.code !== 0) return { ok: false, error: r.stderr };
        }
        bus.emitEvent({ type: 'screen.capture', path: file, scope: a.window ? `janela: ${a.window}` : 'tela inteira', at: nowIso() });
        ctx.perms.audit('screen.capture', ctx.origin, { file, window: a.window ?? null });
        return { ok: true, data: { path: file } };
      },
      async verify(_a, out) {
        const p = (out.data as { path: string }).path;
        if (!fs.existsSync(p)) return { ok: false, detail: 'arquivo de captura ausente' };
        const png = PNG.sync.read(await fsp.readFile(p));
        return png.width > 0 && png.height > 0 ? { ok: true, detail: `PNG válido ${png.width}x${png.height}` } : { ok: false, detail: 'PNG inválido' };
      },
    },
    {
      manifest: {
        name: 'vision.ocr', version: '1.0.0', category: 'vision', permissions: ['fs.read'], risk: 'low', reversible: true, timeoutMs: 60_000, requires: ['tesseract'],
        description: 'Lê o texto visível em uma imagem (OCR com Tesseract, português e inglês).',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        returns: 'Texto reconhecido',
      },
      async available() {
        return (await which('tesseract')) ? { ok: true } : { ok: false, reason: 'Tesseract OCR não instalado' };
      },
      async run(a, ctx) {
        const img = resolveImage(ctx, String(a.path));
        const bin = await which('tesseract');
        if (!bin) return { ok: false, error: 'Tesseract OCR não está instalado. Instale-o (winget install UB-Mannheim.TesseractOCR) para habilitar OCR.' };
        const r = await run(bin, [img, 'stdout', '-l', 'por+eng'], { timeoutMs: 55_000 });
        const r2 = r.code === 0 ? r : await run(bin, [img, 'stdout'], { timeoutMs: 55_000 });
        if (r2.code !== 0) return { ok: false, error: r2.stderr };
        return { ok: true, data: untrusted('ocr', r2.stdout) };
      },
    },
    {
      manifest: {
        name: 'vision.describe', version: '1.0.0', category: 'vision', permissions: ['fs.read'], risk: 'low', reversible: true, timeoutMs: 180_000, requires: ['vision-model'],
        description: 'Interpreta uma imagem/captura com um modelo de visão local: descreve a interface, lê mensagens de erro, localiza botões.',
        parameters: { type: 'object', properties: { path: { type: 'string' }, question: { type: 'string', default: 'Descreva a tela: janelas, botões, textos e mensagens de erro visíveis.' } }, required: ['path'] },
        returns: 'Descrição produzida pelo modelo de visão',
      },
      async available() {
        return (await router.pickVisionModel()) ? { ok: true } : { ok: false, reason: 'Nenhum modelo de visão instalado (ex.: qwen2.5vl:3b, gemma3:4b)' };
      },
      async run(a, ctx) {
        const img = resolveImage(ctx, String(a.path));
        const model = await router.pickVisionModel();
        if (!model) return { ok: false, error: 'Nenhum modelo de visão instalado. Instale um no Gerenciador de Modelos (ex.: qwen2.5vl:3b).' };
        const b64 = (await fsp.readFile(img)).toString('base64');
        const r = await ollama.chat({ model, messages: [{ role: 'user', content: String(a.question), images: [b64] }], signal: ctx.signal, options: { temperature: 0.1 } });
        return { ok: true, data: { model, description: r.message.content } };
      },
    },
    {
      manifest: {
        name: 'vision.compare', version: '1.0.0', category: 'vision', permissions: ['fs.read'], risk: 'low', reversible: true, timeoutMs: 30_000, requires: [],
        description: 'Compara duas capturas PNG e informa a porcentagem de pixels alterados e a região que mudou (útil para verificar se uma ação teve efeito).',
        parameters: { type: 'object', properties: { before: { type: 'string' }, after: { type: 'string' } }, required: ['before', 'after'] },
        returns: 'Percentual de mudança e retângulo alterado',
      },
      async run(a, ctx) {
        const A = PNG.sync.read(await fsp.readFile(resolveImage(ctx, String(a.before))));
        const B = PNG.sync.read(await fsp.readFile(resolveImage(ctx, String(a.after))));
        if (A.width !== B.width || A.height !== B.height) return { ok: true, data: { changedPercent: 100, note: 'dimensões diferentes', before: [A.width, A.height], after: [B.width, B.height] } };
        let changed = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
        for (let y = 0; y < A.height; y++) for (let x = 0; x < A.width; x++) {
          const i = (y * A.width + x) * 4;
          const d = Math.abs(A.data[i]! - B.data[i]!) + Math.abs(A.data[i + 1]! - B.data[i + 1]!) + Math.abs(A.data[i + 2]! - B.data[i + 2]!);
          if (d > 30) {
            changed++;
            if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
          }
        }
        const pct = Math.round((changed / (A.width * A.height)) * 10000) / 100;
        return { ok: true, data: { changedPercent: pct, region: changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null } };
      },
    },
  ];
}
