/**
 * Benchmark reprodutível do motor local. Uso:
 *   pnpm bench               (modelo escolhido pelo roteador)
 *   pnpm bench -- --model qwen3:4b-instruct-2507-q4_K_M --runs 3
 * Mede: carga, TTFT, tokens/s, tool calling e embeddings. Nada é estimado.
 */
import { OllamaClient } from '../brain/ollama.js';

export async function runBenchmark(ollama: OllamaClient, model: string, runs = 3, embedModel?: string | null) {
  const results: Record<string, unknown> = { model, runs, at: new Date().toISOString(), platform: `${process.platform}-${process.arch}` };
  await ollama.unload(model).catch(() => {});
  const tLoad = performance.now();
  await ollama.load(model);
  results.coldLoadMs = Math.round(performance.now() - tLoad);
  const gen: { ttft: number | null; tps: number | null; total: number }[] = [];
  for (let i = 0; i < runs; i++) {
    const r = await ollama.chat({ model, messages: [{ role: 'user', content: 'Explique em 3 frases o que é um sistema operacional.' }], options: { temperature: 0, num_predict: 120, seed: 42 }, think: false }).catch(() =>
      ollama.chat({ model, messages: [{ role: 'user', content: 'Explique em 3 frases o que é um sistema operacional.' }], options: { temperature: 0, num_predict: 120, seed: 42 } }));
    gen.push({ ttft: r.metrics.timeToFirstTokenMs, tps: r.metrics.tokensPerSecond, total: r.metrics.totalMs });
  }
  results.generation = gen;
  results.ttftMsMedian = median(gen.map((g) => g.ttft ?? 0));
  results.tokensPerSecondMedian = median(gen.map((g) => g.tps ?? 0));
  const tools = [{ type: 'function' as const, function: { name: 'fs_write', description: 'Escreve um arquivo', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }];
  let toolOk = 0;
  const toolMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const r = await ollama.chat({ model, tools, messages: [{ role: 'user', content: `Crie o arquivo teste${i}.txt com o texto "ok ${i}"` }], options: { temperature: 0 } });
    toolMs.push(r.metrics.totalMs);
    const c = r.message.tool_calls?.[0];
    if (c?.function.name === 'fs_write' && String(c.function.arguments.path).includes(`teste${i}`)) toolOk++;
  }
  results.toolCalling = { successRate: toolOk / runs, medianMs: median(toolMs) };
  if (embedModel) {
    const t = performance.now();
    await ollama.embed(embedModel, ['memória de teste do JARVIS']);
    results.embedding = { model: embedModel, ms: Math.round(performance.now() - t) };
  }
  return results;
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)]! : null;
};

