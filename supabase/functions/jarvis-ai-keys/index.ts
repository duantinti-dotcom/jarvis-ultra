// JARVIS — conecta chaves grátis de vários provedores de IA. Testa a chave, descobre os
// melhores modelos disponíveis na conta e guarda no servidor (o navegador nunca lê a chave).
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

/** Provedores compatíveis com a API da OpenAI e a ordem de preferência dos modelos (mais inteligente primeiro). */
export const PROVIDERS: Record<string, { base: string; prefer: RegExp[]; free?: RegExp; skip?: RegExp }> = {
  groq: { base: 'https://api.groq.com/openai/v1', prefer: [/gpt-oss-120b$/, /kimi-k2/, /qwen3/, /llama-3\.3-70b/, /llama-4-maverick/, /gpt-oss-20b$/, /llama-4-scout/], skip: /guard|whisper|orpheus|tts|allam|safeguard/ },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', prefer: [/gemini-[\d.]+-pro$/, /gemini-[\d.]+-flash$/, /gemini-[\d.]+-flash-lite$/, /gemini-.*flash/], skip: /embed|image|tts|audio|live|vision|preview-tts|aqa|gemma/ },
  cerebras: { base: 'https://api.cerebras.ai/v1', prefer: [/gpt-oss-120b/, /qwen-3-coder/, /qwen-3-235b/, /llama-3\.3-70b/, /qwen-3-32b/, /llama/], skip: /embed/ },
  openrouter: { base: 'https://openrouter.ai/api/v1', free: /:free$/, prefer: [/qwen3-coder/, /deepseek-(chat-v3|r1|v3)/, /gpt-oss-120b/, /kimi-k2/, /llama-3\.3-70b/, /gemini/, /qwen/, /mistral/], skip: /embed|vision|guard/ },
  mistral: { base: 'https://api.mistral.ai/v1', prefer: [/^mistral-large-latest$/, /^codestral-latest$/, /^mistral-medium-latest$/, /^devstral/, /^mistral-small-latest$/], skip: /embed|moderation|ocr|pixtral/ },
  sambanova: { base: 'https://api.sambanova.ai/v1', prefer: [/DeepSeek-V3/i, /gpt-oss-120b/i, /Qwen3/i, /Llama-4-Maverick/i, /Llama-3\.3-70B/i], skip: /embed|guard|whisper|audio/i },
  nvidia: { base: 'https://integrate.api.nvidia.com/v1', prefer: [/qwen3-coder/, /deepseek-v3/, /gpt-oss-120b/, /kimi-k2/, /llama-3\.3-70b/, /qwen/], skip: /embed|rerank|guard|vision|vlm|parse|reward|safety/ },
};

async function discover(provider: string, key: string) {
  const p = PROVIDERS[provider]!;
  const h = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const r = await fetch(`${p.base}/models`, { headers: h, signal: AbortSignal.timeout(15000) });
  if (r.status === 401 || r.status === 403) throw new Error('chave recusada pelo provedor (confira se copiou inteira)');
  if (!r.ok) throw new Error(`o provedor respondeu HTTP ${r.status}`);
  const j = await r.json();
  let ids: string[] = (j.data ?? j.models ?? []).map((m: { id?: string; name?: string }) => String(m.id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean);
  if (p.free) ids = ids.filter((id) => p.free!.test(id));
  if (p.skip) ids = ids.filter((id) => !p.skip!.test(id));
  const picked: string[] = [];
  for (const re of p.prefer) for (const id of ids) if (re.test(id) && !picked.includes(id) && picked.length < 4) picked.push(id);
  if (!picked.length) throw new Error('nenhum modelo de texto disponível nesta conta');
  // teste real com o 1º modelo que responder; lê o limite de tokens/min quando o provedor informa
  for (const m of picked) {
    const t = await fetch(`${p.base}/chat/completions`, { method: 'POST', headers: h, body: JSON.stringify({ model: m, max_tokens: 8, messages: [{ role: 'user', content: 'Responda só: ok' }] }), signal: AbortSignal.timeout(25000) });
    if (t.ok) {
      const tpm = Number(t.headers.get('x-ratelimit-limit-tokens') ?? t.headers.get('x-ratelimit-limit-tokens-minute') ?? NaN);
      return { models: [m, ...picked.filter((x) => x !== m)], tpm: Number.isFinite(tpm) && tpm > 0 ? tpm : null };
    }
    if (t.status === 401 || t.status === 403) throw new Error('chave recusada pelo provedor');
  }
  throw new Error('a chave funciona, mas nenhum modelo respondeu agora (limite ou indisponível). Tente de novo em 1 minuto.');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'método não permitido' });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: u } = await admin.auth.getUser((req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));
  if (!u?.user) return json(401, { error: 'Sessão inválida. Entre novamente.' });
  let body: { provider?: string; key?: string; action?: string };
  try { body = await req.json(); } catch { return json(400, { error: 'JSON inválido' }); }
  const provider = String(body.provider ?? '');
  if (!PROVIDERS[provider]) return json(400, { error: 'provedor desconhecido' });
  if (body.action === 'remove') {
    await admin.from('jarvis_user_ai').delete().eq('owner', u.user.id).eq('provider', provider);
    return json(200, { ok: true });
  }
  const key = String(body.key ?? '').trim();
  if (key.length < 20 || key.length > 300) return json(400, { error: 'Chave inválida (muito curta ou longa).' });
  try {
    const d = await discover(provider, key);
    const { error } = await admin.from('jarvis_user_ai').upsert({ owner: u.user.id, provider, api_key: key, models: d.models, tpm: d.tpm, status: 'ok', updated_at: new Date().toISOString() }, { onConflict: 'owner,provider' });
    if (error) throw new Error(error.message);
    return json(200, { ok: true, provider, models: d.models, tpm: d.tpm });
  } catch (e) {
    return json(400, { error: `Não consegui conectar: ${(e as Error).message}` });
  }
});
