/**
 * Benchmark reprodutível do motor local:
 *   pnpm bench -- --model qwen3:4b-instruct-2507-q4_K_M --runs 3
 */
import { OllamaClient } from '../brain/ollama.js';
import { runBenchmark } from './run.js';

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ollama = new OllamaClient(process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434');
const tags = await ollama.tags();
const model = arg('model') ?? tags.find((t) => !/embed|bert/i.test(t.name + (t.details?.family ?? '')))?.name;
if (!model) {
  console.error('Nenhum modelo instalado no Ollama.');
  process.exit(1);
}
const embed = tags.find((t) => /embed|bert/i.test(t.name + (t.details?.family ?? '')))?.name ?? null;
console.log(JSON.stringify(await runBenchmark(ollama, model, Number(arg('runs') ?? 3), embed), null, 2));
