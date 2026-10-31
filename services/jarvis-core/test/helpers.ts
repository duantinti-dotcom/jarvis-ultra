import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Core } from '../src/core.js';

process.env.JARVIS_QUIET = '1';
process.env.JARVIS_NO_SEED = '1';

export function tmpDir(name: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jarvis-${name}-`));
}

/** Core real com banco isolado; Ollama aponta para porta inexistente salvo em testes de LLM. */
export async function testCore(opts: { ollama?: string } = {}) {
  const dataDir = tmpDir('data');
  const work = tmpDir('work');
  const core = new Core({ dataDir, ollamaUrl: opts.ollama ?? 'http://127.0.0.1:9' });
  core.db.setSetting('model.preload', false);
  await core.init();
  core.perms.addRoot(work, 'readwrite', false);
  return { core, dataDir, work };
}
