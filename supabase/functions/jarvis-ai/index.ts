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

const SYSTEM = `Você é o JARVIS, assistente pessoal de IA do usuário, inspirado no J.A.R.V.I.S. do Homem de Ferro: elegante, muito inteligente, prestativo, com humor sutil e confiança tranquila. Responda em português do Brasil.
Converse como uma pessoa de verdade falando com alguém que conhece bem: natural, caloroso e direto — nunca robótico, burocrático ou genérico. Entenda a intenção real do pedido, raciocine com cuidado e entregue a melhor resposta possível, com opinião e sugestões quando fizer sentido. Lembre-se do que já foi dito na conversa.
Use Markdown quando ajudar (listas, tabelas, blocos de código); em conversa casual responda curto, sem listas.
Você está rodando na nuvem (pelo site): aqui você conversa, explica, escreve, programa e planeja, mas NÃO tem acesso ao computador do usuário (arquivos, programas, tela). Se o pedido exigir o computador, diga que isso é feito pelo app JARVIS no PC (Desktop Control / Jarvis Code).
Nunca invente fontes, links ou resultados de ações. Se não souber algo atual, diga que não tem acesso à internet em tempo real.`;

const VOICE = `\n\nMODO VOZ (ligação): sua resposta será FALADA em voz alta. Responda como numa conversa real ao telefone: 1 a 3 frases curtas, naturais e expressivas. Proibido: Markdown, listas, títulos, emojis, símbolos, links e código. Não diga "como IA". Se o assunto pedir detalhes, dê o essencial e pergunte se quer que continue.`;

/** Provedor da requisição: chave pessoal do usuário (Configurações) > chave do projeto > gratuito. */
type AI = { key: string; base: string; provider: string; models: { fast: string; balanced: string; deep: string } };
const PROVIDERS: Record<string, { base: string; models: AI['models'] }> = {
  groq: { base: 'https://api.groq.com/openai/v1', models: { fast: 'openai/gpt-oss-20b', balanced: 'openai/gpt-oss-120b', deep: 'openai/gpt-oss-120b' } },
  openai: { base: 'https://api.openai.com/v1', models: { fast: 'gpt-4o-mini', balanced: 'gpt-4o', deep: 'gpt-4o' } },
  openrouter: { base: 'https://openrouter.ai/api/v1', models: { fast: 'openai/gpt-oss-20b', balanced: 'openai/gpt-oss-120b', deep: 'openai/gpt-oss-120b' } },
};
const PROJECT_AI: AI | null = KEY ? { key: KEY, base: BASE, provider: PROVIDER, models: { fast: MODES.fast.model, balanced: MODES.balanced.model, deep: MODES.deep.model } } : null;

const POLL_KEY = env('POLLINATIONS_KEY');

/** Reescreve o pedido como prompt em inglês (até 4 s); se demorar, usa o texto original. */
async function imagePrompt(text: string, ai: AI | null): Promise<string> {
  try {
    const r = await fetch(ai ? `${ai.base}/chat/completions` : BASE, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(ai ? { authorization: `Bearer ${ai.key}` } : {}) },
      body: JSON.stringify({ model: ai ? ai.models.fast : FREE_MODEL, max_tokens: 400, ...(ai && /gpt-oss/.test(ai.models.fast) ? { reasoning_effort: 'low' } : {}), messages: [{ role: 'system', content: 'Rewrite the user request as a detailed English image-generation prompt (subject, style, lighting, composition) in one line. Reply with the prompt only.' }, { role: 'user', content: text }] }),
      signal: AbortSignal.timeout(4000),
    });
    const j = await r.json();
    const out = String(j.choices?.[0]?.message?.content ?? '').trim().replace(/^["']|["']$/g, '');
    return out && out.length < 900 ? out : text;
  } catch {
    return text;
  }
}

const isImage = (res: Response, bytes: Uint8Array) => res.ok && /^image\//.test(res.headers.get('content-type') ?? '') && bytes.length > 15_000;

/** Pollinations (FLUX) conferido no servidor; se estiver no limite, AI Horde (comunitário, gratuito). */
async function generateImage(prompt: string, status: (m: string) => void): Promise<{ bytes: Uint8Array; mime: string; provider: string } | { error: string }> {
  const tried: string[] = [];
  try {
    const seed = Math.floor(Math.random() * 1e9);
    const r = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux&seed=${seed}`, { headers: POLL_KEY ? { authorization: `Bearer ${POLL_KEY}` } : {}, signal: AbortSignal.timeout(60_000) });
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (isImage(r, bytes)) return { bytes, mime: r.headers.get('content-type')!, provider: 'FLUX (Pollinations)' };
    tried.push(`Pollinations ${r.status}`);
  } catch (e) {
    tried.push(`Pollinations: ${(e as Error).message}`);
  }
  // AI Horde: rede comunitária gratuita (fila variável).
  try {
    status('Gerador principal ocupado; usando a rede comunitária (pode levar até 1 minuto)…');
    const h = { 'content-type': 'application/json', apikey: env('HORDE_KEY', '0000000000'), 'Client-Agent': 'jarvis-ultra:0.2:github.com/duantinti-dotcom' };
    const sub = await fetch('https://stablehorde.net/api/v2/generate/async', { method: 'POST', headers: h, body: JSON.stringify({ prompt: prompt.slice(0, 900), params: { width: 512, height: 512, steps: 25, n: 1, sampler_name: 'k_euler_a', cfg_scale: 6 }, nsfw: false, censor_nsfw: true, r2: true, models: ['AlbedoBase XL (SDXL)', 'Deliberate', 'stable_diffusion'] }) });
    const sj = await sub.json();
    if (!sub.ok || !sj.id) throw new Error(sj.message ?? `HTTP ${sub.status}`);
    const deadline = Date.now() + 110_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const c = await (await fetch(`https://stablehorde.net/api/v2/generate/check/${sj.id}`, { headers: h })).json();
      if (c.faulted) throw new Error('falha na rede comunitária');
      if (c.done) break;
      if (c.queue_position != null) status(`Na fila da rede comunitária (posição ${c.queue_position}, ~${c.wait_time ?? '?'} s)…`);
    }
    const st = await (await fetch(`https://stablehorde.net/api/v2/generate/status/${sj.id}`, { headers: h })).json();
    const url = st.generations?.[0]?.img;
    if (!url) throw new Error('tempo esgotado na fila');
    const ir = await fetch(url);
    const bytes = new Uint8Array(await ir.arrayBuffer());
    if (!ir.ok) throw new Error(`download HTTP ${ir.status}`);
    return { bytes, mime: ir.headers.get('content-type') ?? 'image/webp', provider: 'Stable Diffusion (AI Horde)' };
  } catch (e) {
    tried.push(`AI Horde: ${(e as Error).message}`);
  }
  return { error: `os geradores gratuitos estão sobrecarregados (${tried.join('; ')}). Tente de novo em alguns segundos, ou configure uma chave do Pollinations para gerar sem limite.` };
}

const CODE_SYSTEM = `Você é o JARVIS Code, engenheiro de software sênior e designer de produto. Você cria sites e aplicações web COMPLETOS, bonitos e funcionais, prontos para abrir no navegador.
Regras de saída (obrigatórias):
- Explique em 1–3 frases o que vai fazer e depois entregue os arquivos.
- Cada arquivo vem num bloco de código cuja PRIMEIRA linha da cerca tem a linguagem e o nome do arquivo, por exemplo: \`\`\`html index.html  /  \`\`\`css styles.css  /  \`\`\`js script.js
- Sempre entregue o arquivo INTEIRO (nunca "...resto igual"). Ao alterar um projeto existente, reenvie completos só os arquivos que mudaram.
- Nomes de arquivo simples e relativos (index.html, styles.css, script.js, sobre.html, assets/logo.svg). Nunca use blocos sem nome de arquivo para código do projeto.
- Para remover um arquivo, escreva numa linha própria: DELETE: nome-do-arquivo
- index.html é a página principal e deve referenciar os outros arquivos por caminho relativo (styles.css, script.js).
- Sem dependências de build. Pode usar CDNs públicos estáveis (Google Fonts, cdnjs, jsdelivr) quando agregar.
Qualidade: HTML semântico e acessível, CSS moderno (variáveis, grid/flex, responsivo mobile-first, animações suaves e prefers-reduced-motion), JavaScript sem erros, textos realistas em português, design de nível profissional com hierarquia visual clara. Nunca use imagens quebradas: use gradientes, SVG inline ou https://picsum.photos.
No fim, liste em 1–2 linhas como testar ou o que pode ser melhorado.`;

// No modo código o estado atual dos arquivos já vai na mensagem: o histórico guarda só a conversa.
const stripCode = (t: string) => t.replace(/```[^\n]*?([\w./-]+\.\w+)[^\n]*\n[\s\S]*?(```|$)/g, (_m, f) => `[arquivo ${f} entregue]`);

/**
 * O gpt-oss gratuito às vezes escreve a própria "análise" (em inglês) no texto da resposta.
 * Segura o começo da resposta e, se for esse preâmbulo, corta até onde a resposta de verdade começa.
 */
const LEAK_START = /^\s*(the user|user (is|asks|wants|said)|we (need|should|have|must|can)|i (need|should|will) |let's|the question|they (ask|want))/i;
const LEAK_END = /assistant\s*final|<\|start\|>assistant|[.!?:](?=[A-ZÀ-Ý¿¡])/;
function cleanLeak(pre: string, final: boolean): { ready: boolean; text: string } {
  if (!LEAK_START.test(pre)) return { ready: pre.length >= 40 || final, text: pre };
  const m = LEAK_END.exec(pre);
  if (m) return { ready: true, text: pre.slice(m.index + m[0].length).replace(/^(final|assistant)\s*/i, '').trimStart() };
  return { ready: final || pre.length > 1500, text: final ? '' : pre };
}

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

  let body: { text?: string; conversationId?: string | null; mode?: string; code?: { files?: Record<string, string> }; voice?: boolean };
  try { body = await req.json(); } catch { return json(400, { error: 'JSON inválido' }); }
  const text = String(body.text ?? '').trim().slice(0, 16000);
  if (!text) return json(400, { error: 'Mensagem vazia.' });
  const mode = (['fast', 'balanced', 'deep'].includes(String(body.mode)) ? body.mode : 'balanced') as keyof typeof MODES;
  const cfg = MODES[mode];


  // Limite de uso (30/min) e conversa consultados em paralelo para reduzir a latência.
  const since = new Date(Date.now() - 60_000).toISOString();
  const [usage, existing, userAi] = await Promise.all([
    admin.from('jarvis_ai_usage').select('id', { count: 'exact', head: true }).eq('owner', owner).gt('created_at', since),
    body.conversationId ? admin.from('jarvis_cloud_conversations').select('id').eq('id', body.conversationId).eq('owner', owner).maybeSingle() : Promise.resolve({ data: null }),
    admin.from('jarvis_user_ai').select('api_key, provider').eq('owner', owner).maybeSingle(),
  ]);
  const ua = userAi.data as { api_key: string; provider: string } | null;
  const ai: AI | null = ua && PROVIDERS[ua.provider] ? { key: ua.api_key, base: PROVIDERS[ua.provider]!.base, provider: `${ua.provider} (sua chave)`, models: PROVIDERS[ua.provider]!.models } : PROJECT_AI;
  if ((usage.count ?? 0) >= 30) return json(429, { error: 'Muitas mensagens em pouco tempo. Aguarde um minuto.' });
  void admin.from('jarvis_ai_usage').insert({ owner }).then(() => {});
  let conversationId = (existing.data as { id: string } | null)?.id ?? null;
  if (!conversationId) {
    const { data, error } = await admin.from('jarvis_cloud_conversations').insert({ owner, title: (body.code ? 'Code · ' : '') + text.replace(/\s+/g, ' ').slice(0, 60) }).select('id').single();
    if (error) return json(500, { error: error.message });
    conversationId = data.id;
  }
  const [{ data: hist }] = await Promise.all([
    admin.from('jarvis_cloud_messages').select('role, content').eq('conversation_id', conversationId).order('seq', { ascending: false }).limit(cfg.history),
    admin.from('jarvis_cloud_messages').insert({ conversation_id: conversationId, owner, role: 'user', content: text }),
  ]);
  const backendMs = Date.now() - t0;

  // ---------- criação de imagens: gerada e conferida no servidor, salva no Storage ----------
  if (!body.code && IMAGE_RE.test(text)) {
    const enc0 = new TextEncoder();
    const mid = crypto.randomUUID();
    const stream0 = new ReadableStream({
      async start(ctrl) {
        const send = (o: unknown) => { try { ctrl.enqueue(enc0.encode(`data: ${JSON.stringify(o)}\n\n`)); } catch { /* cliente desconectou */ } };
        send({ type: 'meta', conversationId, messageId: mid, model: 'imagem', mode });
        try {
          const prompt = await imagePrompt(text, ai);
          const img = await generateImage(prompt, (msg) => send({ type: 'status', text: msg }));
          let content: string;
          if ('error' in img) {
            content = `Não consegui criar a imagem agora: ${img.error}`;
          } else {
            const path = `${owner}/${crypto.randomUUID()}.${img.mime.includes('png') ? 'png' : img.mime.includes('webp') ? 'webp' : 'jpg'}`;
            const up = await admin.storage.from('jarvis-images').upload(path, img.bytes, { contentType: img.mime, upsert: false });
            if (up.error) throw new Error(up.error.message);
            const url = admin.storage.from('jarvis-images').getPublicUrl(path).data.publicUrl;
            content = `Aqui está a imagem que criei:\n\n![${text.slice(0, 80).replace(/[[\]]/g, '')}](${url})\n\n_Gerada com ${img.provider}. Prompt: ${prompt.slice(0, 280).replace(/[_*]/g, ' ')}_`;
          }
          const metrics = { model: 'error' in img ? 'imagem (falhou)' : img.provider, mode, timeToFirstTokenMs: Date.now() - t0, totalMs: Date.now() - t0, toolCalls: 0, timing: { backendMs } };
          await admin.from('jarvis_cloud_messages').insert({ conversation_id: conversationId, owner, role: 'assistant', content, metrics });
          send({ type: 'delta', text: content });
          send({ type: 'done', metrics });
        } catch (e) {
          send({ type: 'error', error: `Falha ao criar a imagem: ${(e as Error).message}` });
        } finally {
          try { ctrl.close(); } catch { /* já fechado */ }
        }
      },
    });
    return new Response(stream0, { headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  }

  const codeFiles = body.code?.files && typeof body.code.files === 'object' ? Object.entries(body.code.files).slice(0, 20) : [];
  const codeCtx = body.code ? (codeFiles.length ? `\n\nArquivos atuais do projeto:\n${codeFiles.map(([n, c]) => `\`\`\`${n.split('.').pop()} ${n}\n${String(c).slice(0, 30000)}\n\`\`\``).join('\n\n')}` : '\n\n(Projeto vazio: crie do zero.)') : '';
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'short' });
  const sys = body.code ? CODE_SYSTEM : SYSTEM + `\nAgora: ${now} (horário de Brasília).` + (body.voice ? VOICE : '') + (mode === 'deep' && !ai ? '\nPense passo a passo antes de responder e verifique seu raciocínio.' : '');
  const messages = [{ role: 'system', content: sys }, ...(hist ?? []).reverse().map((m) => ({ role: m.role, content: (body.code ? stripCode(m.content) : m.content).slice(0, 8000) })), { role: 'user', content: text + codeCtx }];
  // Voz: modelo grande com raciocínio leve = inteligente e rápido para falar.
  const model = ai ? (body.code || body.voice ? ai.models.balanced : ai.models[mode]) : FREE_MODEL;
  const payload: Record<string, unknown> = { model, messages, stream: true, max_tokens: body.code ? (ai?.base.includes('groq') ? 7000 : 16000) : body.voice ? 1200 : cfg.maxTokens };
  if (ai) payload.temperature = body.voice ? 0.7 : mode === 'deep' ? 0.6 : 0.5;
  if (ai && /gpt-oss|o\d|reason/i.test(model)) payload.reasoning_effort = body.voice ? 'low' : cfg.effort;

  const tReq = Date.now();
  const up = await fetch(ai ? `${ai.base}/chat/completions` : BASE, { method: 'POST', headers: { 'content-type': 'application/json', ...(ai ? { authorization: `Bearer ${ai.key}` } : {}) }, body: JSON.stringify(payload) });
  if (!up.ok || !up.body) {
    const detail = (await up.text()).slice(0, 400);
    if (ua && (up.status === 401 || up.status === 403)) return json(502, { error: 'Sua chave de IA foi recusada pelo provedor. Confira em Configurações → Inteligência na nuvem.' });
    return json(502, { error: `O provedor de IA recusou (HTTP ${up.status}): ${detail}` });
  }

  const messageId = crypto.randomUUID();
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o: unknown) => { try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`)); } catch { /* cliente desconectou */ } };
      send({ type: 'meta', conversationId, messageId, model, mode, provider: ai?.provider ?? 'pollinations' });
      let full = '', ttft: number | null = null, usage: Record<string, number> | null = null, buf = '';
      let pre = '', gated = !body.code;
      const emit = (piece: string) => { if (!piece) return; ttft ??= Date.now() - tReq; full += piece; send({ type: 'delta', text: piece }); };
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
                if (gated) {
                  pre += piece;
                  const c = cleanLeak(pre, false);
                  if (c.ready) { gated = false; emit(c.text); }
                } else emit(piece);
              }
              if (j.usage || j.x_groq?.usage) usage = j.usage ?? j.x_groq.usage;
            } catch { /* linha parcial */ }
          }
        }
        if (gated) emit(cleanLeak(pre, true).text);
        const totalMs = Date.now() - t0;
        const metrics = {
          model: `${model} (${ai?.provider ?? 'pollinations'})`, mode, timeToFirstTokenMs: ttft, totalMs, toolCalls: 0,
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
        try { ctrl.close(); } catch { /* já fechado */ }
      }
    },
  });
  return new Response(stream, { headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
});
