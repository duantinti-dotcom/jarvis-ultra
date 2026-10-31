/**
 * Fila de prioridade para chamadas ao modelo local. O Ollama processa poucas
 * requisições em paralelo; conversas interativas passam na frente de tarefas
 * de fundo (resumos, auditoria, laboratório).
 */
export type Priority = 'interactive' | 'background';

export class LlmQueue {
  private running = 0;
  private queue: { p: Priority; start: () => void }[] = [];
  constructor(private concurrency = Number(process.env.JARVIS_LLM_CONCURRENCY ?? 1)) {}

  async run<T>(p: Priority, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const item = { p, start: resolve };
      if (this.running < this.concurrency) {
        this.running++;
        return resolve();
      }
      if (p === 'interactive') {
        const idx = this.queue.findIndex((q) => q.p === 'background');
        if (idx === -1) this.queue.push(item);
        else this.queue.splice(idx, 0, item);
      } else this.queue.push(item);
      signal?.addEventListener('abort', () => {
        const i = this.queue.indexOf(item);
        if (i >= 0) this.queue.splice(i, 1);
        reject(signal.reason ?? new Error('Cancelado'));
      }, { once: true });
    });
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next.start();
      else this.running--;
    }
  }

  get pending() {
    return this.queue.length;
  }
}
