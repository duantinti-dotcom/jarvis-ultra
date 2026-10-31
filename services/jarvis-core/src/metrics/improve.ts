import type { Db } from '../db/index.js';
import { parse } from '../db/index.js';

export type Proposal = { id: string; severity: 'info' | 'warn' | 'critical'; area: string; finding: string; suggestion: string; labPrompt?: string };

/** Analisa execuções reais (erros, latência, conclusão, memória) e propõe melhorias. */
export function analyze(db: Db, days = 14) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const toolStats = db.all<{ tool: string; total: number; failed: number; avg_ms: number }>(
    'SELECT tool, count(*) AS total, sum(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed, avg(duration_ms) AS avg_ms FROM tool_calls WHERE created_at > ? GROUP BY tool ORDER BY total DESC', since);
  const topErrors = db.all<{ tool: string; error: string; n: number }>(
    'SELECT tool, error, count(*) AS n FROM tool_calls WHERE ok = 0 AND created_at > ? AND error IS NOT NULL GROUP BY tool, error ORDER BY n DESC LIMIT 10', since);
  const tasks = db.all<{ state: string; n: number }>('SELECT state, count(*) AS n FROM tasks WHERE created_at > ? GROUP BY state', since);
  const gens = db.all<{ value: string }>("SELECT value FROM metrics WHERE kind = 'generation' AND created_at > ? ORDER BY created_at DESC LIMIT 500", since)
    .map((r) => parse<{ timeToFirstTokenMs: number | null; tokensPerSecond: number | null; totalMs: number; model: string }>(r.value, { timeToFirstTokenMs: null, tokensPerSecond: null, totalMs: 0, model: '' }));
  const intents = db.all<{ value: string }>("SELECT value FROM metrics WHERE kind = 'intent' AND created_at > ? ORDER BY created_at DESC LIMIT 300", since).map((r) => parse<{ totalMs: number }>(r.value, { totalMs: 0 }));

  const pct = (arr: number[], p: number) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!);
  };
  const ttft = gens.map((g) => g.timeToFirstTokenMs).filter((x): x is number => x != null);
  const tps = gens.map((g) => g.tokensPerSecond).filter((x): x is number => x != null);
  const totalTasks = tasks.reduce((s, t) => s + t.n, 0);
  const completed = tasks.find((t) => t.state === 'completed')?.n ?? 0;
  const summary = {
    periodDays: days,
    generations: gens.length,
    ttftP50: pct(ttft, 50), ttftP95: pct(ttft, 95),
    tokensPerSecondP50: pct(tps, 50),
    intentP50: pct(intents.map((i) => i.totalMs), 50),
    totalP50: pct(gens.map((g) => g.totalMs), 50),
    tasks: totalTasks, taskSuccessRate: totalTasks ? Math.round((completed / totalTasks) * 1000) / 10 : null,
    tasksByState: Object.fromEntries(tasks.map((t) => [t.state, t.n])),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
  };

  const proposals: Proposal[] = [];
  for (const t of toolStats) {
    const rate = t.total ? t.failed / t.total : 0;
    if (t.total >= 3 && rate >= 0.3) {
      const err = topErrors.find((e) => e.tool === t.tool);
      proposals.push({
        id: `tool-${t.tool}`, severity: rate > 0.6 ? 'critical' : 'warn', area: 'ferramentas',
        finding: `${t.tool} falhou em ${Math.round(rate * 100)}% das ${t.total} chamadas. Erro mais comum: ${err?.error?.slice(0, 160) ?? 'n/d'}`,
        suggestion: /Permissão ausente|fora das pastas|não está na lista/.test(err?.error ?? '') ? 'As falhas são de permissão: revise pastas/aplicativos autorizados na Central de Segurança ou ajuste as instruções do agente.' : 'Investigar entradas que causam o erro e criar uma ferramenta mais robusta no LAB.',
        labPrompt: `Ferramenta mais robusta que substitua ${t.tool} nos casos em que ele falha com: ${err?.error?.slice(0, 200)}`,
      });
    }
    if (t.avg_ms > 15_000 && t.total >= 3) proposals.push({ id: `slow-${t.tool}`, severity: 'info', area: 'latência', finding: `${t.tool} leva em média ${Math.round(t.avg_ms / 1000)} s.`, suggestion: 'Limitar escopo (pastas menores, limit menor) ou cachear resultados.' });
  }
  if (summary.ttftP50 && summary.ttftP50 > 4000) proposals.push({ id: 'ttft', severity: 'warn', area: 'modelo', finding: `Tempo até o primeiro token (p50) é ${summary.ttftP50} ms.`, suggestion: 'Use o perfil ECO/BALANCED, mantenha o modelo pré-carregado (keep_alive) e reduza num_ctx. Verifique se a GPU está sendo usada (VRAM no Monitor).' });
  if (summary.tokensPerSecondP50 && summary.tokensPerSecondP50 < 8) proposals.push({ id: 'tps', severity: 'warn', area: 'modelo', finding: `Geração a ${summary.tokensPerSecondP50} tokens/s.`, suggestion: 'Modelo grande demais para a VRAM: troque por um modelo menor ou quantização Q4.' });
  if (summary.taskSuccessRate != null && totalTasks >= 5 && summary.taskSuccessRate < 70) proposals.push({ id: 'tasks', severity: 'warn', area: 'tarefas', finding: `Taxa de conclusão de tarefas: ${summary.taskSuccessRate}%.`, suggestion: 'Veja os erros mais comuns abaixo; considere o perfil MAXIMUM para tarefas complexas.' });
  if (summary.rssMb > 1500) proposals.push({ id: 'rss', severity: 'info', area: 'memória', finding: `O processo do JARVIS usa ${summary.rssMb} MB.`, suggestion: 'Feche o navegador automatizado quando não estiver em uso.' });
  return { summary, toolStats, topErrors, proposals };
}
