// JARVIS na nuvem: o site conversa sem depender do PC.
// Provedor compatível com a API da OpenAI (padrão: Groq). A chave fica em segredo do Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const env = (k: string, d = '') => Deno.env.get(k) ?? d;
const KEY = env('AI_API_KEY');
// Com chave: provedor configurado (padrão Groq, muito rápido). Sem chave: Pollinations (gratuito, sem cadastro).
const BASE = KEY ? env('AI_BASE_URL', 'https://api.groq.com/openai/v1').replace(/\/+$/, '') : 'https://text.pollinations.ai/openai';
const PROVIDER = KEY ? (BASE.includes('groq') ? 'groq' : 'custom') : 'pollinations';
const FREE_MODEL = env('AI_FREE_MODEL', 'openai');
const IMAGE_RE = /\b(crie|cria|criar|gere|gera|gerar|fa[cç]a|fazer|desenhe|desenha|desenhar|mostre|imagine)\b[^.?!]{0,60}\b(imagem|imagens|foto|fotos|desenho|ilustra[cç][aã]o|logo|logotipo|arte|wallpaper|papel de parede|figura|retrato|pintura)\b/i;

/** Cada modo muda modelo, esforço de raciocínio e tamanho da resposta. */
const MODES = {
  fast: { model: env('AI_MODEL_FAST', 'openai/gpt-oss-20b'), effort: 'low', maxTokens: 1024, history: 8 },
  balanced: { model: env('AI_MODEL', 'openai/gpt-oss-120b'), effort: 'medium', maxTokens: 4096, history: 16 },
  deep: { model: env('AI_MODEL_DEEP', 'openai/gpt-oss-120b'), effort: 'high', maxTokens: 8192, history: 24 },
} as const;

const SYSTEM = `Você é o JARVIS, assistente pessoal de IA. Responda em português do Brasil, de forma clara, direta e útil. Use Markdown quando ajudar (listas, tabelas, blocos de código).
Você está rodando na nuvem (pelo site): aqui você conversa, explica, escreve, programa e planeja, mas NÃO tem acesso ao computador do usuário (arquivos, programas, tela). Se o pedido exigir o computador, diga que isso é feito pelo app JARVIS no PC (Desktop Control / Jarvis Code).
Nunca invente fontes, links ou resultados de ações. Se não souber algo atual, diga que não tem acesso à internet em tempo real.`;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'método não permitido' });
  const t0 = Date.now();
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: u } = await admin.auth.getUser(jwt);
  if (!u?.user) return json(401, { error: 'Sessão inválida. Entre novamente.' });
  const owner = u.user.id;

  let body: { text?: string; conversationId?: string | null; mode?: string };
  try { body = await req.json(); } catch { return json(400, { error: 'JSON inválido' }); }
  const text = String(body.text ?? '').trim().slice(0, 16000);
  if (!text) return json(400, { error: 'Mensagem vazia.' });
  const mode = (['fast', 'balanced', 'deep'].includes(String(body.mode)) ? body.mode : 'balanced') as keyof typeof MODES;
  const cfg = MODES[mode];


  // Limite de uso: 30 mensagens por minuto por usuário.
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await admin.from('jarvis_ai_usage').select('id', { count: 'exact', head: true }).eq('owner', owner).gt('created_at', since);
  if ((count ?? 0) >= 30) return json(429, { error: 'Muitas mensagens em pouco tempo. Aguarde um minuto.' });
  await admin.from('jarvis_ai_usage').insert({ owner });

  // Conversa (cria se não existir / não for do usuário).
  let conversationId = body.conversationId ?? null;
  if (conversationId) {
    const { data } = await admin.from('jarvis_cloud_conversations').select('id').eq('id', conversationId).eq('owner', owner).maybeSingle();
    if (!data) conversationId = null;
  }
  if (!conversationId) {
    const { data, error } = await admin.from('jarvis_cloud_conversations').insert({ owner, title: text.replace(/\s+/g, ' ').slice(0, 60) }).select('id').single();
    if (error) return json(500, { error: error.message });
    conversationId = data.id;
  }
  const { data: hist } = await admin.from('jarvis_cloud_messages').select('role, content').eq('conversation_id', conversationId).order('seq', { ascending: false }).limit(cfg.history);
  await admin.from('jarvis_cloud_messages').insert({ conversation_id: conversationId, owner, role: 'user', content: text });
  const backendMs = Date.now() - t0;

  // ---------- criação de imagens (FLUX via Pollinations) ----------
  if (IMAGE_RE.test(text)) {
    let prompt = text;
    try {
      const r = await fetch(`${BASE}/chat/completions`.replace('/openai/chat/completions', '/openai'), {
        method: 'POST', headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
        body: JSON.stringify({ model: KEY ? MODES.fast.model : FREE_MODEL, max_tokens: 200, messages: [{ role: 'system', content: 'Transforme o pedido do usuário num prompt de geração de imagem em INGLÊS, detalhado (assunto, estilo, luz, composição), em uma única linha. Responda só o prompt.' }, { role: 'user', content: text }] }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      const out = String(j.choices?.[0]?.message?.content ?? '').trim();
      if (out && out.length < 900) prompt = out.replace(/^["']|["']$/g, '');
    } catch { /* usa o texto original */ }
    const seed = Math.floor(Math.random() * 1e9);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux&seed=${seed}`;
    const content = `Aqui está a imagem que criei:\n\n![${text.slice(0, 80).replace(/[\[\]]/g, '')}](${url})\n\n_Prompt usado: ${prompt.slice(0, 300).replace(/[_*]/g, " ")}_`;
    const metrics = { model: 'flux (pollinations)', mode, timeToFirstTokenMs: Date.now() - t0, totalMs: Date.now() - t0, toolCalls: 0, timing: { backendMs } };
    await admin.from('jarvis_cloud_messages').insert({ conversation_id: conversationId, owner, role: 'assistant', content, metrics });
    const enc0 = new TextEncoder();
    const mid = crypto.randomUUID();
    const sse = [{ type: 'meta', conversationId, messageId: mid, model: 'flux', mode }, { type: 'delta', text: content }, { type: 'done', metrics }].map((o) => `data: ${JSON.stringify(o)}\n\n`).join('');
    return new Response(enc0.encode(sse), { headers: { ...CORS, 'content-type': 'text/event-stream' } });
  }

  const messages = [{ role: 'system', content: SYSTEM + (mode === 'deep' && !KEY ? '\nPense passo a passo antes de responder e verifique seu raciocínio.' : '') }, ...(hist ?? []).reverse().map((m) => ({ role: m.role, content: m.content.slice(0, 8000) })), { role: 'user', content: text }];
  const model = KEY ? cfg.model : FREE_MODEL;
  const payload: Record<string, unknown> = { model, messages, stream: true, max_tokens: cfg.maxTokens };
  if (KEY) payload.temperature = mode === 'deep' ? 0.6 : 0.5;
  if (KEY && /gpt-oss|o\d|reason/i.test(model)) payload.reasoning_effort = cfg.effort;

  const tReq = Date.now();
  const up = await fetch(KEY ? `${BASE}/chat/completions` : BASE, { method: 'POST', headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) }, body: JSON.stringify(payload) });
  if (!up.ok || !up.body) {
    const detail = (await up.text()).slice(0, 400);
    return json(502, { error: `O provedor de IA recusou (HTTP ${up.status}): ${detail}` });
  }

  const messageId = crypto.randomUUID();
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      send({ type: 'meta', conversationId, messageId, model, mode, provider: PROVIDER });
      let full = '', ttft: number | null = null, usage: Record<string, number> | null = null, buf = '';
      const reader = up.body!.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const d = line.slice(5).trim();
            if (d === '[DONE]') continue;
            try {
              const j = JSON.parse(d);
              const piece = j.choices?.[0]?.delta?.content ?? '';
              if (piece) {
                ttft ??= Date.now() - tReq;
                full += piece;
                send({ type: 'delta', text: piece });
              }
              if (j.usage || j.x_groq?.usage) usage = j.usage ?? j.x_groq.usage;
            } catch { /* linha parcial */ }
          }
        }
        const totalMs = Date.now() - t0;
        const metrics = {
          model: `${model} (${PROVIDER})`, mode, timeToFirstTokenMs: ttft, totalMs, toolCalls: 0,
          promptTokens: usage?.prompt_tokens ?? null, completionTokens: usage?.completion_tokens ?? null,
          tokensPerSecond: usage?.completion_tokens && totalMs ? Math.round((usage.completion_tokens / ((Date.now() - tReq) / 1000)) * 10) / 10 : null,
          timing: { backendMs, generationMs: Date.now() - tReq },
        };
        await admin.from('jarvis_cloud_messages').insert({ conversation_id: conversationId, owner, role: 'assistant', content: full || '(sem resposta)', metrics });
        await admin.from('jarvis_cloud_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
        send({ type: 'done', metrics });
      } catch (e) {
        send({ type: 'error', error: String((e as Error).message ?? e) });
      } finally {
        ctrl.close();
      }
    },
  });
  return new Response(stream, { headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
});
