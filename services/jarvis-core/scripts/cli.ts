/**
 * CLI de diagnóstico: envia uma mensagem ao core e mostra a resposta em streaming.
 *   pnpm --filter @jarvis/core cli "Como está meu computador?"
 * Aprovações pendentes são respondidas com --approve (sim) ou recusadas por padrão.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dataDir = process.env.JARVIS_DATA_DIR ?? (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? '', 'JarvisUltra') : path.join(os.homedir(), '.jarvis-ultra'));
const token = fs.readFileSync(path.join(dataDir, 'auth-token'), 'utf8').trim();
const base = `http://127.0.0.1:${process.env.JARVIS_PORT ?? 7821}`;
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const approve = process.argv.includes('--approve');
const convArg = process.argv.find((a) => a.startsWith('--conv='))?.slice(7) ?? null;
const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const es = await fetch(`${base}/api/events`, { headers: h });
const reader = es.body!.getReader();
const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: h, body: JSON.stringify({ text: args.join(' '), conversationId: convArg }) });
const { messageId, conversationId, error } = await r.json();
if (error) {
  console.error(error);
  process.exit(1);
}
console.error(`\x1b[2m[conversa ${conversationId}]\x1b[0m`);
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i: number;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const data = block.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
    if (!data || !block.includes('event: core')) continue;
    const e = JSON.parse(data);
    if (e.type === 'intent' && e.conversationId === conversationId) console.error(`\x1b[2m[intenção: ${e.kind} → ${e.agent} em ${e.ms} ms]\x1b[0m`);
    if (e.type === 'tool.start' && e.conversationId === conversationId) console.error(`\x1b[33m⚙ ${e.tool} ${JSON.stringify(e.args).slice(0, 160)}\x1b[0m`);
    if (e.type === 'tool.end' && e.conversationId === conversationId) console.error(`${e.ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${e.tool} (${e.durationMs} ms): ${e.summary.slice(0, 160)}\x1b[0m`);
    if (e.type === 'approval.request') {
      console.error(`\x1b[35m? aprovação ${e.tool} (${e.risk}) → ${approve ? 'APROVADO' : 'NEGADO'}\x1b[0m`);
      await fetch(`${base}/api/approvals/${e.approvalId}`, { method: 'POST', headers: h, body: JSON.stringify({ approve }) });
    }
    if (e.messageId !== messageId) continue;
    if (e.type === 'chat.delta') process.stdout.write(e.text);
    if (e.type === 'chat.error') console.error(`\n\x1b[31m${e.error}\x1b[0m`);
    if (e.type === 'chat.done' || e.type === 'chat.error') {
      if (e.metrics) console.error(`\n\x1b[2m[${e.metrics.model} · TTFT ${e.metrics.timeToFirstTokenMs} ms · ${e.metrics.tokensPerSecond} tok/s · total ${e.metrics.totalMs} ms · ${e.metrics.toolCalls} ferramentas]\x1b[0m`);
      process.exit(0);
    }
  }
}
