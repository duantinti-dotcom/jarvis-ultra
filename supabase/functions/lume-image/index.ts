// Lume IA — imagens para os projetos do Lume Code.
// Recebe uma descrição + tamanho, gera por IA (FLUX via Pollinations), confere que é uma imagem
// real com as dimensões pedidas, salva no Storage e devolve a URL pública. Mesma descrição = mesmo arquivo.
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
const POLL_KEY = Deno.env.get('POLLINATIONS_KEY') ?? '';

/** Lê largura/altura do cabeçalho JPEG/PNG/WebP (sem decodificar a imagem inteira). */
function dims(b: Uint8Array): { w: number; h: number } | null {
  if (b[0] === 0x89 && b[1] === 0x50) return { w: (b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!, h: (b[20]! << 24) | (b[21]! << 16) | (b[22]! << 8) | b[23]! };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length - 9) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5]! << 8) | b[i + 6]!, w: (b[i + 7]! << 8) | b[i + 8]! };
      i += 2 + ((b[i + 2]! << 8) | b[i + 3]!);
    }
  }
  if (b[8] === 0x57 && b[9] === 0x45 && b[12] === 0x56 && b[15] === 0x38) {
    if (b[15] === 0x38 && b[14] === 0x50) return { w: ((b[27]! << 8) | b[26]!) & 0x3fff, h: ((b[29]! << 8) | b[28]!) & 0x3fff };
  }
  return null;
}

async function sha(s: string) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].slice(0, 16).map((x) => x.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'método não permitido' });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: u } = await admin.auth.getUser((req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));
  if (!u?.user) return json(401, { error: 'Sessão inválida.' });
  let body: { prompt?: string; w?: number; h?: number };
  try { body = await req.json(); } catch { return json(400, { error: 'JSON inválido' }); }
  const prompt = String(body.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 700);
  if (prompt.length < 3) return json(400, { error: 'descrição vazia' });
  const w = Math.max(256, Math.min(1600, Math.round(Number(body.w) || 1024)));
  const h = Math.max(256, Math.min(1600, Math.round(Number(body.h) || 768)));
  const path = `${u.user.id}/lume/${await sha(`${prompt}|${w}x${h}`)}.jpg`;
  const pub = admin.storage.from('jarvis-images').getPublicUrl(path).data.publicUrl;

  // já gerada antes: reaproveita (mesma descrição e tamanho)
  const exists = await fetch(pub, { method: 'HEAD' }).catch(() => null);
  if (exists?.ok) return json(200, { url: pub, w, h, cached: true });

  const tried: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const seed = Math.floor(Math.random() * 1e9);
      const r = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt + ', high quality, professional, sharp focus, no text, no watermark')}?width=${w}&height=${h}&nologo=true&model=flux&seed=${seed}`, { headers: POLL_KEY ? { authorization: `Bearer ${POLL_KEY}` } : {}, signal: AbortSignal.timeout(70_000) });
      const bytes = new Uint8Array(await r.arrayBuffer());
      const type = r.headers.get('content-type') ?? '';
      const d = dims(bytes);
      // confere: é imagem de verdade, não é o aviso de limite, e tem a proporção pedida (±6%)
      const okRatio = d ? Math.abs(d.w / d.h - w / h) / (w / h) < 0.06 : false;
      if (r.ok && /^image\//.test(type) && bytes.length > 15_000 && okRatio) {
        const up = await admin.storage.from('jarvis-images').upload(path, bytes, { contentType: type, upsert: true });
        if (up.error) throw new Error(up.error.message);
        return json(200, { url: pub, w: d!.w, h: d!.h, provider: 'FLUX (Pollinations)' });
      }
      tried.push(`tentativa ${attempt + 1}: HTTP ${r.status}, ${type || 'sem tipo'}, ${bytes.length} bytes${d ? `, ${d.w}x${d.h}` : ''}`);
      if (r.status === 429) await new Promise((res) => setTimeout(res, 2500 * (attempt + 1)));
    } catch (e) {
      tried.push(`tentativa ${attempt + 1}: ${(e as Error).message}`);
    }
  }
  return json(502, { error: `não consegui gerar a imagem agora (${tried.join('; ')})` });
});
