import { logger } from '../log.js';

const log = logger('ollama');

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
};

export type OllamaTool = { type: 'function'; function: { name: string; description: string; parameters: unknown } };

export type ChatChunk = {
  message: ChatMessage;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_duration?: number;
  load_duration?: number;
  total_duration?: number;
};

export type ModelTag = {
  name: string; size: number; modified_at: string; digest: string;
  details: { family?: string; families?: string[]; parameter_size?: string; quantization_level?: string; format?: string };
};

export type ModelShow = { capabilities?: string[]; model_info?: Record<string, unknown>; details?: ModelTag['details'] };

export class OllamaError extends Error {}

export class OllamaClient {
  private showCache = new Map<string, ModelShow>();
  constructor(public baseUrl: string) {}

  private async req(path: string, init?: RequestInit & { timeoutMs?: number }) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('timeout')), init?.timeoutMs ?? 10_000);
    const signal = init?.signal ? AbortSignal.any([init.signal, ac.signal]) : ac.signal;
    try {
      const r = await fetch(this.baseUrl + path, { ...init, signal });
      if (!r.ok) throw new OllamaError(`Ollama ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
      return r;
    } catch (e) {
      if (e instanceof OllamaError) throw e;
      throw new OllamaError(`Ollama indisponível em ${this.baseUrl}: ${(e as Error).message}`);
    } finally {
      clearTimeout(t);
    }
  }

  async version(): Promise<string | null> {
    try {
      return ((await (await this.req('/api/version', { timeoutMs: 2500 })).json()) as { version: string }).version;
    } catch {
      return null;
    }
  }

  async tags(): Promise<ModelTag[]> {
    return ((await (await this.req('/api/tags')).json()) as { models: ModelTag[] }).models ?? [];
  }

  async ps(): Promise<{ name: string; size: number; size_vram: number; expires_at: string; context_length?: number }[]> {
    return ((await (await this.req('/api/ps')).json()) as { models: [] }).models ?? [];
  }

  async show(model: string): Promise<ModelShow> {
    const c = this.showCache.get(model);
    if (c) return c;
    const r = (await (await this.req('/api/show', { method: 'POST', body: JSON.stringify({ model }) })).json()) as ModelShow;
    this.showCache.set(model, { capabilities: r.capabilities, details: r.details, model_info: pickInfo(r.model_info) });
    return this.showCache.get(model)!;
  }

  invalidate() {
    this.showCache.clear();
  }

  /** Chat com streaming. Retorna a mensagem final agregada (texto + tool_calls) e métricas. */
  async chat(opts: {
    model: string; messages: ChatMessage[]; tools?: OllamaTool[]; signal?: AbortSignal; onDelta?: (t: string) => void;
    format?: unknown; options?: Record<string, unknown>; keepAlive?: string; think?: boolean;
  }) {
    const started = performance.now();
    let firstTokenAt: number | null = null;
    const body = {
      model: opts.model, messages: opts.messages, stream: true,
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
      ...(opts.format ? { format: opts.format } : {}),
      ...(opts.think !== undefined ? { think: opts.think } : {}),
      options: { temperature: 0.3, ...opts.options },
      keep_alive: opts.keepAlive ?? '30m',
    };
    const res = await this.req('/api/chat', { method: 'POST', body: JSON.stringify(body), signal: opts.signal, timeoutMs: 15 * 60_000 });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let content = '';
    const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];
    let final: ChatChunk | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as ChatChunk & { error?: string };
        if (chunk.error) throw new OllamaError(chunk.error);
        const piece = chunk.message?.content ?? '';
        if (piece) {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          content += piece;
          opts.onDelta?.(piece);
        }
        if (chunk.message?.tool_calls?.length) {
          if (firstTokenAt === null) firstTokenAt = performance.now();
          toolCalls.push(...chunk.message.tool_calls);
        }
        if (chunk.done) final = chunk;
      }
    }
    const totalMs = performance.now() - started;
    const evalCount = final?.eval_count ?? null;
    const evalNs = final?.eval_duration ?? null;
    return {
      message: { role: 'assistant' as const, content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      metrics: {
        model: opts.model,
        timeToFirstTokenMs: firstTokenAt === null ? null : Math.round(firstTokenAt - started),
        totalMs: Math.round(totalMs),
        promptTokens: final?.prompt_eval_count ?? null,
        completionTokens: evalCount,
        tokensPerSecond: evalCount && evalNs ? Math.round((evalCount / (evalNs / 1e9)) * 10) / 10 : null,
        loadMs: final?.load_duration ? Math.round(final.load_duration / 1e6) : null,
        promptEvalMs: final?.prompt_eval_duration ? Math.round(final.prompt_eval_duration / 1e6) : null,
        doneReason: final?.done_reason ?? null,
      },
    };
  }

  async embed(model: string, input: string[], signal?: AbortSignal): Promise<number[][]> {
    const r = await this.req('/api/embed', { method: 'POST', body: JSON.stringify({ model, input, keep_alive: '30m' }), signal, timeoutMs: 120_000 });
    return ((await r.json()) as { embeddings: number[][] }).embeddings;
  }

  /** Pré-carrega o modelo na memória (reduz a latência da primeira resposta). */
  async load(model: string, keepAlive = '30m') {
    await this.req('/api/chat', { method: 'POST', body: JSON.stringify({ model, messages: [], keep_alive: keepAlive }), timeoutMs: 10 * 60_000 });
  }

  async unload(model: string) {
    await this.req('/api/chat', { method: 'POST', body: JSON.stringify({ model, messages: [], keep_alive: 0 }), timeoutMs: 60_000 });
  }

  async pull(model: string, onProgress: (p: { status: string; completed?: number; total?: number }) => void, signal?: AbortSignal) {
    const res = await this.req('/api/pull', { method: 'POST', body: JSON.stringify({ model, stream: true }), signal, timeoutMs: 6 * 3600_000 });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const p = JSON.parse(line);
        if (p.error) throw new OllamaError(p.error);
        onProgress(p);
      }
    }
    this.invalidate();
    log.info(`modelo ${model} instalado`);
  }

  async remove(model: string) {
    await this.req('/api/delete', { method: 'DELETE', body: JSON.stringify({ model }) });
    this.invalidate();
  }
}

function pickInfo(info?: Record<string, unknown>) {
  if (!info) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(info)) if (/context_length|block_count|embedding_length|parameter_count/.test(k)) out[k] = v;
  return out;
}
