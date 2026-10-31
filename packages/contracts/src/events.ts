/** Eventos emitidos pelo core (SSE local e espelhados pelo relay). */
export type CoreEvent =
  | { type: 'chat.delta'; conversationId: string; messageId: string; text: string }
  | { type: 'chat.done'; conversationId: string; messageId: string; metrics: GenerationMetrics }
  | { type: 'chat.error'; conversationId: string; messageId: string; error: string }
  | { type: 'tool.start'; conversationId: string | null; taskId: string | null; callId: string; tool: string; args: unknown }
  | { type: 'tool.end'; conversationId: string | null; taskId: string | null; callId: string; tool: string; ok: boolean; summary: string; durationMs: number }
  | { type: 'task.update'; taskId: string; state: string; detail?: string }
  | { type: 'approval.request'; approvalId: string; tool: string; args: unknown; risk: string; reason: string; origin: string }
  | { type: 'approval.resolved'; approvalId: string; state: string }
  | { type: 'agent.state'; state: CoreVisualState }
  | { type: 'emergency.stop'; at: string }
  | { type: 'screen.capture'; path: string; scope: string; at: string }
  | { type: 'relay.status'; connected: boolean; detail?: string }
  | { type: 'ui.action'; action: 'voice.start' | 'voice.stop' | 'navigate'; target?: string }
  | { type: 'intent'; conversationId: string; kind: string; agent: string; model: string; ms: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** Estados visuais do núcleo JARVIS. */
export type CoreVisualState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'executing' | 'success' | 'error' | 'offline';

/** Métricas reais de geração, medidas no core. */
export type GenerationMetrics = {
  model: string;
  timeToFirstTokenMs: number | null;
  totalMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  tokensPerSecond: number | null;
  toolCalls: number;
};
