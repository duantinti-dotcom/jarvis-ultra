import type { RequestOrigin, GenerationMetrics, ToolManifest, ReasoningMode, TimingBreakdown } from '@jarvis/contracts';
import type { Db } from '../db/index.js';
import { json } from '../db/index.js';
import type { Bus } from '../bus.js';
import type { OllamaClient, ChatMessage, OllamaTool } from './ollama.js';
import type { ModelRouter } from './router.js';
import type { ToolRegistry, InvokeResult } from '../tools/registry.js';
import type { TaskStore } from './tasks.js';
import type { Conversations } from './conversations.js';
import type { MemoryStore } from '../memory/store.js';
import type { PermissionEngine } from '../permissions/engine.js';
import { LlmQueue } from './llmqueue.js';
import { AGENTS, BASE_SYSTEM_PROMPT, fastRoute, type AgentId } from './agents.js';
import { buildHistory, estimateTokens } from './context.js';
import { newId, nowIso } from '../util/ids.js';
import { logger } from '../log.js';

const log = logger('brain');

export type Intent = {
  kind: 'conversation' | 'question' | 'plan_request' | 'action' | 'ambiguous';
  agent: AgentId;
  needs_tools: boolean;
  goal: string;
  clarifying_question: string;
  steps: string[];
  success_criteria: string[];
};

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['conversation', 'question', 'plan_request', 'action', 'ambiguous'] },
    agent: { type: 'string', enum: ['general', 'developer', 'research', 'desktop', 'documents', 'memory', 'lab'] },
    needs_tools: { type: 'boolean' },
    goal: { type: 'string' },
    clarifying_question: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    success_criteria: { type: 'array', items: { type: 'string' }, maxItems: 4 },
  },
  required: ['kind', 'agent', 'needs_tools', 'goal', 'clarifying_question', 'steps', 'success_criteria'],
};

/** Ferramentas que alteram estado: suas falhas definem se a tarefa falhou. */
const READ_ONLY_SCOPES = new Set(['fs.read', 'apps.list', 'system.read', 'memory.read', 'net.fetch']);
const isSideEffect = (m: ToolManifest | undefined) => !!m && m.permissions.some((p) => !READ_ONLY_SCOPES.has(p));

const STOP_RE = /^\s*(jarvis[,!\s]*)?(pare|parar|cancele|cancelar|interrompa|aborte|stop)\b.*\b(tarefa|tarefas|tudo|isso|agora|atual|execu[cç][aã]o)?/i;
const VOICE_RE = /\b(ligue|ligar|ative|ativar|inicie|iniciar|comece|come[cç]ar)\b.*\b(modo de voz|chamada|liga[cç][aã]o|voz)\b/i;
export const IMAGE_RE = /\b(crie|cria|criar|gere|gera|gerar|fa[cç]a|fazer|desenhe|desenha|desenhar|imagine)\b[^.?!]{0,60}\b(imagem|imagens|foto|desenho|ilustra[cç][aã]o|logo|logotipo|arte|wallpaper|papel de parede|figura|retrato|pintura)\b/i;
const SMALLTALK_RE = /^\s*(jarvis[,!\s]*)?(oi|ol[aá]|e a[ií]|bom dia|boa tarde|boa noite|obrigad[oa]|valeu|tudo bem\??|como vai\??|tchau|at[eé] logo)[\s!.?]*$/i;

/** Conversa por voz: respostas faladas, curtas e naturais. */
export const VOICE_NOTE = 'Modo voz: a resposta será FALADA. Responda como numa conversa real, em 1 a 3 frases curtas, naturais e calorosas, sem Markdown, listas, emojis ou símbolos. Nada de "como IA, eu...". Se precisar de detalhes, ofereça continuar.';

export type ChatInput = { conversationId?: string | null; text: string; origin: RequestOrigin; projectId?: string | null; mode?: ReasoningMode; images?: string[]; voice?: boolean };

/** O que cada modo muda de fato no pipeline. */
export const MODES: Record<ReasoningMode, { label: string; classifier: 'never' | 'auto' | 'always'; semanticMemory: boolean; maxIterations: number; numPredict: number; think: boolean; temperature: number; audit: boolean; modelClass: 'fast' | 'tools' | 'deep' }> = {
  fast: { label: 'Rápido', classifier: 'never', semanticMemory: false, maxIterations: 5, numPredict: 700, think: false, temperature: 0.3, audit: false, modelClass: 'fast' },
  balanced: { label: 'Equilibrado', classifier: 'auto', semanticMemory: true, maxIterations: 8, numPredict: 2048, think: false, temperature: 0.3, audit: false, modelClass: 'tools' },
  deep: { label: 'Profundo', classifier: 'always', semanticMemory: true, maxIterations: 14, numPredict: 4096, think: true, temperature: 0.4, audit: true, modelClass: 'deep' },
};
export type ChatOutcome = { conversationId: string; messageId: string; content: string; taskId: string | null; state: 'completed' | 'failed' | 'cancelled' | 'answered' | 'clarify'; metrics: GenerationMetrics; intent: Intent | null };

export class Brain {
  readonly queue = new LlmQueue();
  private messageControllers = new Map<string, AbortController>();

  constructor(
    private db: Db, private bus: Bus, private ollama: OllamaClient, private router: ModelRouter, private tools: ToolRegistry,
    private tasks: TaskStore, private convs: Conversations, private memory: MemoryStore, private perms: PermissionEngine,
  ) {
    perms.onEmergencyStop(() => {
      for (const ac of this.messageControllers.values()) ac.abort(new Error('Parada de emergência'));
      this.tasks.cancelAll('Parada de emergência');
    });
  }

  /** Inicia o processamento e devolve imediatamente os ids (a resposta chega por eventos). */
  start(input: ChatInput): { conversationId: string; messageId: string; done: Promise<ChatOutcome> } {
    const conversationId = this.convs.ensure(input.conversationId ?? null, input.text, input.origin, input.projectId ?? null);
    this.convs.add(conversationId, { role: 'user', content: input.text, origin: input.origin });
    const messageId = newId('msg');
    const ac = new AbortController();
    this.messageControllers.set(messageId, ac);
    const done = this.process(conversationId, messageId, input, ac.signal)
      .catch((e): ChatOutcome => {
        const error = e instanceof Error ? e.message : String(e);
        this.bus.emitEvent({ type: 'chat.error', conversationId, messageId, error });
        this.convs.add(conversationId, { role: 'assistant', content: `⚠️ ${error}`, id: messageId, origin: input.origin });
        this.bus.emitEvent({ type: 'agent.state', state: 'error' });
        return { conversationId, messageId, content: `⚠️ ${error}`, taskId: null, state: 'failed', metrics: emptyMetrics(''), intent: null };
      })
      .finally(() => this.messageControllers.delete(messageId));
    return { conversationId, messageId, done };
  }

  cancelMessage(messageId: string) {
    this.messageControllers.get(messageId)?.abort(new Error('Cancelado pelo usuário'));
  }

  private say(conversationId: string, messageId: string, text: string) {
    this.bus.emitEvent({ type: 'chat.delta', conversationId, messageId, text });
  }

  private async process(conversationId: string, messageId: string, input: ChatInput, signal: AbortSignal): Promise<ChatOutcome> {
    const t0 = performance.now();
    const text = input.text.trim();
    this.bus.emitEvent({ type: 'agent.state', state: 'thinking' });

    // 1. Comandos de controle reconhecidos sem modelo (latência zero).
    if (STOP_RE.test(text) && text.split(/\s+/).length <= 8) {
      const active = this.tasks.active();
      this.tasks.cancelAll('Cancelada por comando do usuário');
      return this.finishDirect(conversationId, messageId, input, active.length ? `Parei ${active.length} tarefa(s) em execução.` : 'Não há tarefas em execução no momento.', t0);
    }
    if (VOICE_RE.test(text) && text.split(/\s+/).length <= 10) {
      this.bus.emitEvent({ type: 'ui.action', action: 'voice.start' });
      return this.finishDirect(conversationId, messageId, input, 'Iniciando a chamada de voz. Pode falar.', t0);
    }

    const mode: ReasoningMode = input.mode ?? this.db.getSetting<ReasoningMode>('chat.mode', 'balanced');
    const cfg = MODES[mode];
    const tm: TimingBreakdown = {};
    if (IMAGE_RE.test(text) && !input.images?.length) return this.createImage(conversationId, messageId, input, text, signal, t0);
    const pick = (await this.router.pick(cfg.modelClass)) ?? (await this.router.pick('tools'));
    if (!pick) {
      const v = await this.ollama.version();
      throw new Error(v ? 'Nenhum modelo de linguagem compatível está instalado. Abra o Gerenciador de Modelos e instale um (ex.: qwen3:4b-instruct-2507-q4_K_M).' : `O motor de IA local (Ollama) não está respondendo em ${this.ollama.baseUrl}. Inicie o Ollama e tente novamente.`);
    }

    // 2. Contexto: memórias relevantes + histórico dentro do orçamento.
    const tMem = performance.now();
    const memories = await this.memory.search(text, { limit: 4, semantic: cfg.semanticMemory }).catch(() => ({ semantic: false, results: [] }));
    const procedures = mode === 'fast' ? { semantic: false, results: [] as Awaited<ReturnType<MemoryStore['search']>>['results'] } : await this.memory.search(text, { limit: 2, category: 'procedural', semantic: cfg.semanticMemory }).catch(() => ({ semantic: false, results: [] }));
    tm.memoryMs = Math.round(performance.now() - tMem);
    const history = buildHistory(this.convs, conversationId, Math.floor(pick.numCtx * 0.35));
    history.messages.pop(); // remove a mensagem atual (adicionada novamente abaixo)
    if (history.needsSummary) void this.summarize(conversationId).catch((e) => log.warn(`resumo falhou: ${e.message}`));

    // 3. Intenção e plano: regras rápidas quando há certeza; senão o classificador.
    let intent: Intent;
    const fast = SMALLTALK_RE.test(text) ? null : fastRoute(text);
    if (input.images?.length) {
      return this.answerImages(conversationId, messageId, input, history.messages, text, signal, t0, mode, tm);
    }
    if (SMALLTALK_RE.test(text) || (cfg.classifier === 'never' && !fast)) {
      intent = { kind: 'conversation', agent: 'general', needs_tools: false, goal: text, clarifying_question: '', steps: [], success_criteria: [] };
    } else if (fast === 'ambiguous') {
      intent = { kind: 'ambiguous', agent: 'general', needs_tools: false, goal: text, clarifying_question: 'Esse pedido pode modificar muitos arquivos. O que exatamente você quer que eu faça? Por exemplo: em qual pasta, qual critério de organização (por tipo, data, projeto) e se posso mover ou apenas sugerir.', steps: [], success_criteria: [] };
      this.bus.emitEvent({ type: 'intent', conversationId, kind: 'ambiguous', agent: 'rules', model: 'regras', ms: 0 });
    } else if (fast && cfg.classifier !== 'always') {
      intent = { kind: fast.kind, agent: fast.agent, needs_tools: true, goal: text, clarifying_question: '', steps: [], success_criteria: [] };
      this.bus.emitEvent({ type: 'intent', conversationId, kind: fast.kind, agent: fast.agent, model: 'regras', ms: 0 });
    } else {
      const ti = performance.now();
      intent = await this.classify(text, history.messages, pick.model, signal);
      tm.intentMs = Math.round(performance.now() - ti);
      this.bus.emitEvent({ type: 'intent', conversationId, kind: intent.kind, agent: intent.agent, model: pick.model, ms: tm.intentMs });
    }

    if (intent.kind === 'ambiguous' && intent.clarifying_question.trim()) {
      return this.finishDirect(conversationId, messageId, input, intent.clarifying_question.trim(), t0, intent, 'clarify');
    }

    const agent = AGENTS[intent.agent] ?? AGENTS.general;
    const memoryBlock = memories.results.length
      ? '\nMemórias relevantes (cite a origem se usar):\n' + memories.results.map((m) => `- [${m.category}] ${m.title}: ${m.content.slice(0, 400)} (origem: ${m.source}, ${m.updatedAt.slice(0, 10)}, confiança ${m.confidence})`).join('\n')
      : '';
    const approvedProcs = procedures.results.filter((p) => p.confidence >= 0.9);
    const procBlock = approvedProcs.length ? '\nProcedimentos aprovados que já funcionaram:\n' + approvedProcs.map((p) => `- ${p.title}: ${p.content.slice(0, 500)}`).join('\n') : '';
    const roots = this.perms.roots().filter((r) => input.origin !== 'remote' || r.remote);
    // Prefixo estável (sistema + ferramentas) é reaproveitado pelo cache KV do Ollama;
    // o que muda a cada turno vai junto da mensagem do usuário.
    const envBlock = `\n\nAmbiente: ${process.platform === 'win32' ? 'Windows' : process.platform}.\nPastas autorizadas: ${roots.map((r) => `${r.path} (${r.access === 'readwrite' ? 'leitura e escrita' : 'somente leitura'})`).join('; ') || 'nenhuma'}.\nAplicativos autorizados: ${this.perms.apps().filter((a) => input.origin !== 'remote' || a.remote).map((a) => a.name).join(', ') || 'nenhum'}.`;
    const system: ChatMessage = { role: 'system', content: `${BASE_SYSTEM_PROMPT}\n\nVocê está atuando como ${agent.name}: ${agent.description} ${agent.instructions}${envBlock}` };
    const dynamic = `[Contexto: ${new Date().toLocaleString('pt-BR')} · origem ${input.origin === 'remote' ? 'site remoto (celular/navegador)' : 'aplicativo local'}${input.voice ? `\n${VOICE_NOTE}` : ''}${memoryBlock}${procBlock}]`;
    const userMsg: ChatMessage = { role: 'user', content: `${dynamic}\n\n${text}` };

    const useTools = intent.needs_tools || intent.kind === 'action' || intent.kind === 'plan_request' && agent.tools.length > 0;
    if (!useTools) {
      return this.answerOnly(conversationId, messageId, input, [system, ...history.messages, userMsg], pick.model, pick.numCtx, signal, t0, intent, mode, tm);
    }

    const modelPick = (agent.modelClass === 'code' && mode !== 'fast' ? await this.router.pick(mode === 'deep' ? 'deep' : 'code') : null) ?? pick;
    return this.runTask(conversationId, messageId, input, intent, agent.id, [system, ...history.messages, userMsg], modelPick.model, modelPick.numCtx, signal, t0, mode, tm);
  }

  private finishDirect(conversationId: string, messageId: string, input: ChatInput, text: string, t0: number, intent: Intent | null = null, state: ChatOutcome['state'] = 'answered'): ChatOutcome {
    this.say(conversationId, messageId, text);
    const metrics = { ...emptyMetrics('regras'), totalMs: Math.round(performance.now() - t0) };
    this.convs.add(conversationId, { role: 'assistant', content: text, id: messageId, metrics, origin: input.origin });
    this.bus.emitEvent({ type: 'chat.done', conversationId, messageId, metrics });
    this.bus.emitEvent({ type: 'agent.state', state: 'idle' });
    return { conversationId, messageId, content: text, taskId: null, state, metrics, intent };
  }

  async classify(text: string, history: ChatMessage[], model: string, signal: AbortSignal): Promise<Intent> {
    const agentList = Object.values(AGENTS).filter((a) => a.tools.length).map((a) => `- ${a.id}: ${a.description}`).join('\n');
    const recent = history.slice(-4).map((m) => `${m.role}: ${m.content.slice(0, 300)}`).join('\n');
    const prompt = `Analise o pedido do usuário para um assistente que controla o computador dele.
Especialistas disponíveis:
${agentList}

Classifique:
- kind: "conversation" (papo), "question" (pergunta), "plan_request" (quer um plano/sugestão sem execução), "action" (quer que algo seja feito no PC/arquivos/apps/web), "ambiguous" (pedido vago que poderia modificar ou apagar dados sem objetivo claro — ex.: "arrume meus projetos").
- needs_tools: true se a resposta depende do estado real do computador, de arquivos, da internet, da memória salva ou do histórico de conversas.
- agent: especialista mais adequado.
- goal: objetivo real em uma frase.
- clarifying_question: se ambiguous, a pergunta para esclarecer; senão "".
- steps: plano curto (até 6 passos) se for ação; senão [].
- success_criteria: como verificar que deu certo; senão [].
${recent ? `\nContexto recente:\n${recent}\n` : ''}
Pedido: """${text.slice(0, 2000)}"""`;
    const show = await this.ollama.show(model).catch(() => ({ capabilities: [] as string[] }));
    const r = await this.queue.run('interactive', () => this.ollama.chat({
      model, messages: [{ role: 'user', content: prompt }], format: INTENT_SCHEMA, signal,
      options: { temperature: 0, num_predict: 350 }, ...(show.capabilities?.includes('thinking') ? { think: false } : {}),
    }), signal);
    this.recordMetrics('intent', r.metrics);
    try {
      const parsed = JSON.parse(r.message.content) as Intent;
      if (!AGENTS[parsed.agent]) parsed.agent = 'general';
      return parsed;
    } catch {
      log.warn('classificação inválida; assumindo ação geral');
      return { kind: 'action', agent: 'general', needs_tools: true, goal: text, clarifying_question: '', steps: [], success_criteria: [] };
    }
  }

  private async answerOnly(conversationId: string, messageId: string, input: ChatInput, messages: ChatMessage[], model: string, _numCtx: number, signal: AbortSignal, t0: number, intent: Intent, mode: ReasoningMode = 'balanced', tm: TimingBreakdown = {}): Promise<ChatOutcome> {
    const cfg = MODES[mode];
    const show = await this.ollama.show(model).catch(() => ({ capabilities: [] as string[] }));
    this.bus.emitEvent({ type: 'agent.state', state: 'speaking' });
    const r = await this.queue.run('interactive', () => this.ollama.chat({
      model, messages, signal, options: { temperature: cfg.temperature, num_predict: cfg.numPredict }, onDelta: (t) => this.say(conversationId, messageId, t),
      ...(show.capabilities?.includes('thinking') ? { think: cfg.think } : {}),
    }), signal);
    addModelTiming(tm, r.metrics);
    let content = r.message.content;
    const urlNote = unverifiedUrlNote(content, '');
    if (urlNote) {
      content += urlNote;
      this.say(conversationId, messageId, urlNote);
    }
    const totalMs = Math.round(performance.now() - t0);
    const metrics: GenerationMetrics = { ...pickMetrics(r.metrics), totalMs, toolCalls: 0, mode, timing: finishTiming(tm, totalMs, r.metrics.timeToFirstTokenMs) };
    this.recordMetrics('generation', { ...metrics, origin: input.origin });
    this.convs.add(conversationId, { role: 'assistant', content, id: messageId, metrics, origin: input.origin });
    this.afterAnswer(conversationId);
    this.bus.emitEvent({ type: 'chat.done', conversationId, messageId, metrics });
    this.bus.emitEvent({ type: 'agent.state', state: 'idle' });
    return { conversationId, messageId, content, taskId: null, state: 'answered', metrics, intent };
  }

  private async runTask(conversationId: string, messageId: string, input: ChatInput, intent: Intent, agentId: AgentId, messages: ChatMessage[], model: string, numCtx: number, outerSignal: AbortSignal, t0: number, mode: ReasoningMode = 'balanced', tm: TimingBreakdown = {}): Promise<ChatOutcome> {
    const cfg = MODES[mode];
    const agent = AGENTS[agentId];
    const { task, signal: taskSignal } = this.tasks.create({ conversationId, origin: input.origin, goal: intent.goal || input.text, plan: intent.steps, successCriteria: intent.success_criteria });
    const signal = AbortSignal.any([outerSignal, taskSignal]);
    const manifests = this.tools.usable(input.origin, (m) => agent.tools.includes(m.name));
    const nameMap = new Map<string, string>();
    const ollamaTools: OllamaTool[] = manifests.map((m) => {
      const fn = m.name.replace(/\./g, '_');
      nameMap.set(fn, m.name);
      return { type: 'function', function: { name: fn, description: m.description, parameters: m.parameters } };
    });
    const unavailable = agent.tools.filter((t) => !manifests.some((m) => m.name === t));
    const last = messages[messages.length - 1]!;
    if (unavailable.length) last.content += `\n\n[Ferramentas indisponíveis nesta origem (sem permissão): ${unavailable.join(', ')}. Se forem necessárias, explique ao usuário qual permissão falta.]`;
    if (intent.steps.length) last.content += `\n\n[Plano proposto:\n${intent.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}]`;

    const show = await this.ollama.show(model).catch(() => ({ capabilities: [] as string[] }));
    const think = show.capabilities?.includes('thinking') ? { think: cfg.think } : {};
    const calls: { manifest: ToolManifest | undefined; result: InvokeResult; args: unknown }[] = [];
    const failures = new Map<string, number>();
    let content = '';
    let firstMetrics: ReturnType<typeof pickMetrics> | null = null;
    let promptTokens = 0, completionTokens = 0;
    const maxIters = Number(this.db.getSetting('brain.maxIterations', cfg.maxIterations));
    let toolsMs = 0;
    this.tasks.setState(task.id, 'executing', { plan: intent.steps });
    this.bus.emitEvent({ type: 'agent.state', state: 'executing' });

    try {
      for (let iter = 0; iter < maxIters; iter++) {
        if (signal.aborted) throw signal.reason ?? new Error('Cancelado');
        await this.tasks.waitIfPaused(task.id, signal);
        const budgetNote = estimateTokens(JSON.stringify(messages)) > numCtx * 0.8;
        if (budgetNote) compactToolResults(messages);
        const r = await this.queue.run('interactive', () => this.ollama.chat({
          model, messages, tools: ollamaTools, signal, options: { temperature: Math.min(0.3, cfg.temperature), num_predict: cfg.numPredict }, ...think,
          onDelta: (t) => {
            content += t;
            this.say(conversationId, messageId, t);
          },
        }), signal);
        firstMetrics ??= pickMetrics(r.metrics);
        addModelTiming(tm, r.metrics);
        promptTokens += r.metrics.promptTokens ?? 0;
        completionTokens += r.metrics.completionTokens ?? 0;
        messages.push(r.message);
        const toolCalls = r.message.tool_calls ?? [];
        if (!toolCalls.length) break;
        if (r.message.content) {
          content += '\n\n';
          this.say(conversationId, messageId, '\n\n');
        }
        for (const tc of toolCalls) {
          const name = nameMap.get(tc.function.name) ?? tc.function.name.replace(/_/g, '.');
          const manifest = this.tools.get(name)?.manifest;
          const args = tc.function.arguments ?? {};
          const key = `${name}:${JSON.stringify(args)}`;
          let result: InvokeResult;
          if ((failures.get(key) ?? 0) >= 2) {
            result = { callId: 'skip', tool: name, ok: false, error: 'Esta mesma chamada já falhou duas vezes. Não repita: explique o problema ao usuário ou tente outra abordagem.', durationMs: 0, verification: null };
          } else {
            await this.tasks.waitIfPaused(task.id, signal);
            const stepId = this.tasks.addStep(task.id, { agent: agent.name, description: `${name} ${summarizeArgs(args)}`, tool: name, args: args as Record<string, unknown> });
            const stepIndex = calls.length;
            const app = typeof (args as { name?: unknown }).name === 'string' && name.startsWith('apps.') ? String((args as { name: string }).name) : typeof (args as { window?: unknown }).window === 'string' ? String((args as { window: string }).window) : undefined;
            this.bus.emitEvent({ type: 'task.step', taskId: task.id, conversationId, index: stepIndex, tool: name, app, description: summarizeArgs(args), state: 'running' });
            const tTool = performance.now();
            if (manifest && this.perms.evaluate(manifest, input.origin).allowed && (this.perms.evaluate(manifest, input.origin) as { needsApproval: boolean }).needsApproval) this.tasks.setState(task.id, 'awaiting_approval');
            result = await this.tools.invoke({ tool: name, args, origin: input.origin, taskId: task.id, stepId, conversationId, signal });
            this.tasks.setState(task.id, result.ok ? 'executing' : 'correcting');
            toolsMs += performance.now() - tTool;
            this.tasks.finishStep(stepId, result.ok ? 'done' : 'failed', { result: result.data, error: result.error, verification: result.verification });
            this.bus.emitEvent({ type: 'task.step', taskId: task.id, conversationId, index: stepIndex, tool: name, app, description: result.ok ? (result.verification?.detail ?? 'concluído') : (result.error ?? 'falhou'), state: result.ok ? 'done' : 'failed' });
            if (!result.ok) failures.set(key, (failures.get(key) ?? 0) + 1);
          }
          calls.push({ manifest, result, args });
          messages.push({ role: 'tool', tool_name: tc.function.name, content: toolMessage(result) });
        }
      }

      // 4. Verificação final (determinística) — impede declarar sucesso sem evidência.
      this.tasks.setState(task.id, 'verifying');
      const verdict = auditCalls(calls, intent, content);
      if (cfg.audit && !verdict.failed && intent.success_criteria.length && calls.length) {
        const judged = await this.judge(intent, calls.map((c) => ({ tool: c.result.tool, ok: c.result.ok, verification: c.result.verification?.detail ?? null, error: c.result.error ?? null })), model, signal).catch(() => null);
        if (judged && !judged.met) verdict.note += `\n\n---\n🔎 **Auditor (modo Profundo):** critérios possivelmente não atendidos — ${judged.reason}`;
      }
      const urlNote = unverifiedUrlNote(content, calls.map((c) => JSON.stringify(c.result.data ?? '')).join(' '));
      if (urlNote) verdict.note += urlNote;
      if (verdict.note) {
        content += verdict.note;
        this.say(conversationId, messageId, verdict.note);
      }
      if (!content.trim()) {
        const fallback = calls.length ? 'Concluí as ações acima.' : 'Não consegui gerar uma resposta.';
        content = fallback;
        this.say(conversationId, messageId, fallback);
      }
      const finalState = verdict.failed ? 'failed' : 'completed';
      this.tasks.setState(task.id, finalState, { result: content.slice(0, 4000), error: verdict.failed ? verdict.summary : null });
      tm.toolsMs = Math.round(toolsMs);
      const totalMs = Math.round(performance.now() - t0);
      const metrics: GenerationMetrics = {
        model, timeToFirstTokenMs: firstMetrics?.timeToFirstTokenMs ?? null, totalMs,
        promptTokens, completionTokens, tokensPerSecond: firstMetrics?.tokensPerSecond ?? null, toolCalls: calls.length,
        mode, timing: finishTiming(tm, totalMs, firstMetrics?.timeToFirstTokenMs ?? null),
      };
      this.recordMetrics('generation', { ...metrics, origin: input.origin, taskId: task.id });
      this.recordMetrics('task', { taskId: task.id, state: finalState, tools: calls.map((c) => ({ tool: c.result.tool, ok: c.result.ok, ms: c.result.durationMs })) });
      this.convs.add(conversationId, { role: 'assistant', content, id: messageId, metrics, origin: input.origin, toolCalls: calls.map((c) => ({ tool: c.result.tool, ok: c.result.ok, error: c.result.error ?? null, verification: c.result.verification })) });
      this.bus.emitEvent({ type: 'chat.done', conversationId, messageId, metrics });
      this.bus.emitEvent({ type: 'agent.state', state: finalState === 'completed' ? 'success' : 'error' });
      void this.learn(task.id, intent, calls, finalState).catch(() => {});
      this.afterAnswer(conversationId);
      return { conversationId, messageId, content, taskId: task.id, state: finalState, metrics, intent };
    } catch (e) {
      const cancelled = signal.aborted;
      const msg = e instanceof Error ? e.message : String(e);
      this.tasks.setState(task.id, cancelled ? 'cancelled' : 'failed', { error: msg });
      const note = cancelled ? `\n\n⏹ Tarefa interrompida: ${msg}` : `\n\n⚠️ A tarefa falhou: ${msg}`;
      content += note;
      this.say(conversationId, messageId, note);
      const metrics: GenerationMetrics = { ...emptyMetrics(model), totalMs: Math.round(performance.now() - t0), toolCalls: calls.length };
      this.convs.add(conversationId, { role: 'assistant', content, id: messageId, metrics, origin: input.origin });
      this.bus.emitEvent({ type: 'chat.done', conversationId, messageId, metrics });
      this.bus.emitEvent({ type: 'agent.state', state: cancelled ? 'idle' : 'error' });
      return { conversationId, messageId, content, taskId: task.id, state: cancelled ? 'cancelled' : 'failed', metrics, intent };
    }
  }

  /** Imagens: usa um modelo com visão de verdade ou explica que falta instalar um. */
  private async answerImages(conversationId: string, messageId: string, input: ChatInput, history: ChatMessage[], text: string, signal: AbortSignal, t0: number, mode: ReasoningMode, tm: TimingBreakdown): Promise<ChatOutcome> {
    const vision = await this.router.pickVisionModel();
    if (!vision) {
      return this.finishDirect(conversationId, messageId, input, 'Para analisar imagens preciso de um modelo com visão. Instale um em **Configurações → Modelos** (ex.: `qwen2.5vl:3b` ou `gemma3:4b`) e envie a imagem de novo.', t0);
    }
    const images = (input.images ?? []).slice(0, 4).map((b) => b.replace(/^data:[^,]+,/, ''));
    const messages: ChatMessage[] = [{ role: 'system', content: BASE_SYSTEM_PROMPT }, ...history.slice(-6), { role: 'user', content: text || 'Descreva a imagem.', images }];
    return this.answerOnly(conversationId, messageId, input, messages, vision, 0, signal, t0, { kind: 'question', agent: 'general', needs_tools: false, goal: text, clarifying_question: '', steps: [], success_criteria: [] }, mode, tm);
  }

  /**
   * Criação de imagens: o modelo local reescreve o pedido em inglês (até 6 s) e a imagem é
   * gerada pelo FLUX (Pollinations, gratuito). O navegador baixa a imagem direto do serviço.
   */
  private async createImage(conversationId: string, messageId: string, input: ChatInput, text: string, signal: AbortSignal, t0: number): Promise<ChatOutcome> {
    let prompt = text;
    const pick = await this.router.pick('fast').catch(() => null);
    if (pick) {
      try {
        const r = await this.queue.run('interactive', () => this.ollama.chat({
          model: pick.model, think: false, signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]), options: { temperature: 0.4, num_predict: 120 },
          messages: [{ role: 'user', content: `Transforme este pedido num prompt de geração de imagem em INGLÊS, detalhado (assunto, estilo, luz, composição), numa única linha. Responda só o prompt.\nPedido: ${text}` }],
        }), signal);
        const out = r.message.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (out && out.length < 900) prompt = out.replace(/^["']|["']$/g, '');
      } catch { /* sem modelo ou demorou: usa o texto original */ }
    }
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux&seed=${Math.floor(Math.random() * 1e9)}`;
    return this.finishDirect(conversationId, messageId, input, `Aqui está a imagem que criei:\n\n![${text.slice(0, 80).replace(/[[\]]/g, '')}](${url})\n\n_Prompt usado: ${prompt.slice(0, 300).replace(/[_*]/g, ' ')}_`, t0);
  }

  /** Auditor do modo Profundo: julga só pelas evidências das ferramentas. */
  private async judge(intent: Intent, evidence: unknown, model: string, signal: AbortSignal): Promise<{ met: boolean; reason: string }> {
    const r = await this.queue.run('interactive', () => this.ollama.chat({
      model, signal, format: { type: 'object', properties: { met: { type: 'boolean' }, reason: { type: 'string' } }, required: ['met', 'reason'] },
      options: { temperature: 0, num_predict: 200 },
      messages: [{ role: 'user', content: `Objetivo: ${intent.goal}\nCritérios de sucesso: ${intent.success_criteria.join('; ')}\nEvidências (resultados reais das ferramentas): ${JSON.stringify(evidence).slice(0, 4000)}\nOs critérios foram atendidos segundo as evidências? Responda em JSON.` }],
    }), signal);
    return JSON.parse(r.message.content);
  }

  /** Título automático após a primeira troca de mensagens (prioridade baixa). */
  private afterAnswer(conversationId: string) {
    const conv = this.convs.get(conversationId);
    if (!conv || this.db.getSetting<boolean>('chat.autoTitle', true) === false) return;
    const msgs = this.convs.messages(conversationId, 4).filter((m) => m.role === 'user' || m.role === 'assistant');
    if (msgs.length !== 2) return;
    void (async () => {
      const pick = await this.router.pick('fast');
      if (!pick) return;
      const r = await this.queue.run('background', () => this.ollama.chat({
        model: pick.model, options: { temperature: 0.2, num_predict: 24 }, think: false,
        messages: [{ role: 'user', content: `Crie um título curto (até 6 palavras, sem aspas, sem ponto final) em português para esta conversa:\nUsuário: ${msgs[0]!.content.slice(0, 400)}\nAssistente: ${msgs[1]!.content.slice(0, 400)}` }],
      }).catch(() => this.ollama.chat({ model: pick.model, options: { temperature: 0.2, num_predict: 24 }, messages: [{ role: 'user', content: `Título curto (até 6 palavras) para: ${msgs[0]!.content.slice(0, 300)}` }] })));
      const title = r.message.content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/["'*#\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (title.length >= 3) {
        this.convs.rename(conversationId, title);
        this.bus.emitEvent({ type: 'conversation.updated', conversationId, title });
      }
    })().catch((e) => log.debug(`título automático falhou: ${(e as Error).message}`));
  }

  /** Memória episódica e procedimentos candidatos a partir de tarefas reais. */
  private async learn(taskId: string, intent: Intent, calls: { result: InvokeResult }[], state: string) {
    if (!calls.length) return;
    const ok = calls.filter((c) => c.result.ok);
    await this.memory.save({
      category: 'episodic', title: `Tarefa ${nowIso().slice(0, 10)}: ${intent.goal.slice(0, 120)}`,
      content: `Resultado: ${state}. Ferramentas: ${calls.map((c) => `${c.result.tool}${c.result.ok ? '✓' : '✗'}`).join(', ')}.`,
      source: `tarefa:${taskId}`, confidence: 1,
    }).catch(() => {});
    const distinct = [...new Set(ok.map((c) => c.result.tool))];
    if (state === 'completed' && distinct.length >= 2) {
      await this.memory.save({
        category: 'procedural', title: `Procedimento: ${intent.goal.slice(0, 120)}`,
        content: `Sequência que funcionou: ${ok.map((c) => c.result.tool).join(' → ')}. Aguardando aprovação do usuário para virar procedimento confiável.`,
        source: `tarefa:${taskId}`, confidence: 0.5, tags: ['candidato'],
      }).catch(() => {});
    }
  }

  /** Resumo incremental das mensagens antigas (prioridade baixa). */
  async summarize(conversationId: string) {
    const conv = this.convs.get(conversationId);
    if (!conv) return;
    const msgs = this.convs.messages(conversationId, 200).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.seq > conv.summarized_upto);
    const older = msgs.slice(0, Math.max(0, msgs.length - 6));
    if (older.length < 4) return;
    const pick = await this.router.pick('fast');
    if (!pick) return;
    const text = older.map((m) => `${m.role === 'user' ? 'Usuário' : 'JARVIS'}: ${m.content.slice(0, 1500)}`).join('\n');
    const r = await this.queue.run('background', () => this.ollama.chat({
      model: pick.model, options: { temperature: 0.1, num_predict: 500 },
      messages: [{ role: 'user', content: `Atualize o resumo da conversa em até 10 tópicos curtos (fatos, decisões, pendências).\nResumo anterior: ${conv.summary ?? '(nenhum)'}\n\nNovas mensagens:\n${text}` }],
    }));
    this.convs.setSummary(conversationId, r.message.content.trim(), older[older.length - 1]!.seq);
    this.recordMetrics('summary', r.metrics);
  }

  recordMetrics(kind: string, value: unknown) {
    this.db.run('INSERT INTO metrics (id, kind, model, value, created_at) VALUES (?, ?, ?, ?, ?)', newId('met'), kind, (value as { model?: string })?.model ?? null, json(value), nowIso());
  }
}

function toolMessage(r: InvokeResult): string {
  const payload: Record<string, unknown> = { ok: r.ok };
  if (r.ok) payload.data = r.data;
  else payload.error = r.error;
  if (r.verification) payload.verification = r.verification;
  if (r.denied) payload.note = 'Bloqueado pelo sistema de permissões. Não tente contornar; explique ao usuário.';
  if (!r.ok && !r.denied) payload.hint = 'Analise o erro. Tente uma alternativa segura ou explique ao usuário o que impediu a ação.';
  const s = JSON.stringify(payload);
  return s.length > 7000 ? s.slice(0, 7000) + '…(truncado)' : s;
}

/** Quando o contexto enche, resultados antigos de ferramentas são encurtados. */
function compactToolResults(messages: ChatMessage[]) {
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIdx.slice(0, -2)) {
    const m = messages[i]!;
    if (m.content.length > 600) m.content = m.content.slice(0, 600) + '…(resumido para caber no contexto)';
  }
}

export function auditCalls(calls: { manifest: ToolManifest | undefined; result: InvokeResult }[], intent: Intent, content: string): { failed: boolean; note: string; summary: string } {
  // Uma falha só conta se a mesma ferramenta não teve sucesso depois (recuperação).
  const unresolved: InvokeResult[] = [];
  calls.forEach((c, i) => {
    if (c.result.ok || !isSideEffect(c.manifest)) return;
    const recovered = calls.slice(i + 1).some((n) => n.result.ok && n.result.tool === c.result.tool);
    if (!recovered) unresolved.push(c.result);
  });
  const sideOk = calls.filter((c) => c.result.ok && isSideEffect(c.manifest));
  const claimsDone = /\b(criei|abri|salvei|conclu[ií]|feito|pronto|movi|renomeei|exclu[ií]|atualizei|preenchi|cliquei)\b/i.test(content);
  if (unresolved.length) {
    const lines = unresolved.map((r) => `- \`${r.tool}\`: ${r.error}`).join('\n');
    return { failed: true, summary: unresolved.map((r) => `${r.tool}: ${r.error}`).join('; '), note: `\n\n---\n⚠️ **Verificação do JARVIS:** ${unresolved.length} ação(ões) não foram concluídas:\n${lines}` };
  }
  if (intent.kind === 'action' && claimsDone && sideOk.length === 0 && calls.every((c) => !isSideEffect(c.manifest))) {
    return { failed: true, summary: 'nenhuma ação executada', note: '\n\n---\n⚠️ **Verificação do JARVIS:** nenhuma ação que altera o sistema foi executada nesta resposta; desconsidere qualquer afirmação de conclusão acima.' };
  }
  const verified = sideOk.filter((c) => c.result.verification?.ok);
  if (verified.length) {
    return { failed: false, summary: 'ok', note: `\n\n---\n✅ **Verificado:** ${verified.map((c) => `\`${c.result.tool}\` — ${c.result.verification!.detail}`).join('; ')}` };
  }
  return { failed: false, summary: 'ok', note: '' };
}

/** Links citados que não vieram de nenhuma ferramenta são marcados como não verificados. */
export function unverifiedUrlNote(content: string, evidence: string): string {
  const urls = [...new Set(content.match(/https?:\/\/[^\s)\]>"']+/g) ?? [])];
  const bad = urls.filter((u) => !evidence.includes(u.replace(/[.,;:]+$/, '')));
  return bad.length ? `\n\n---\n⚠️ **Verificação do JARVIS:** ${bad.length === 1 ? 'o link acima não foi consultado' : 'os links acima não foram consultados'} nesta resposta (${bad.slice(0, 3).join(', ')}); trate como não verificado.` : '';
}

function summarizeArgs(a: unknown) {
  const s = JSON.stringify(a);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

function pickMetrics(m: { model: string; timeToFirstTokenMs: number | null; totalMs: number; promptTokens: number | null; completionTokens: number | null; tokensPerSecond: number | null }) {
  return { model: m.model, timeToFirstTokenMs: m.timeToFirstTokenMs, totalMs: m.totalMs, promptTokens: m.promptTokens, completionTokens: m.completionTokens, tokensPerSecond: m.tokensPerSecond };
}

function emptyMetrics(model: string): GenerationMetrics {
  return { model, timeToFirstTokenMs: null, totalMs: 0, promptTokens: null, completionTokens: null, tokensPerSecond: null, toolCalls: 0 };
}

type RawMetrics = { totalMs: number; timeToFirstTokenMs: number | null; loadMs?: number | null; promptEvalMs?: number | null };

function addModelTiming(tm: TimingBreakdown, m: RawMetrics) {
  tm.modelLoadMs = (tm.modelLoadMs ?? 0) + (m.loadMs ?? 0);
  tm.promptEvalMs = (tm.promptEvalMs ?? 0) + (m.promptEvalMs ?? 0);
  tm.generationMs = (tm.generationMs ?? 0) + Math.max(0, m.totalMs - (m.loadMs ?? 0) - (m.promptEvalMs ?? 0));
}

/** Tudo que não é modelo nem ferramenta é custo do próprio backend (memória, contexto, banco). */
function finishTiming(tm: TimingBreakdown, totalMs: number, _ttft: number | null): TimingBreakdown {
  const model = (tm.modelLoadMs ?? 0) + (tm.promptEvalMs ?? 0) + (tm.generationMs ?? 0) + (tm.intentMs ?? 0);
  return { ...tm, backendMs: Math.max(0, totalMs - model - (tm.toolsMs ?? 0)) };
}
