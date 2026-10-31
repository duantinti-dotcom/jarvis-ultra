import { Core } from './core.js';
import { buildRoutes } from './http/routes.js';
import { createServer, loadOrCreateToken } from './http/server.js';
import { logger } from './log.js';

const log = logger('main');

export async function start(overrides: ConstructorParameters<typeof Core>[0] = {}) {
  const core = await new Core(overrides).init();
  const token = loadOrCreateToken(core.config.dataDir);
  const server = createServer(core, buildRoutes(core), token);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(core.config.port, core.config.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : core.config.port;
  log.info(`JARVIS Core ${core.version} ouvindo em http://${core.config.host}:${port} (dados: ${core.config.dataDir})`);
  // Linha lida pelo app desktop (Tauri) para descobrir porta e token.
  if (process.env.JARVIS_EMIT_READY === '1') process.stdout.write(`JARVIS_READY ${JSON.stringify({ port, token })}\n`);
  const stop = async () => {
    log.info('encerrando…');
    server.close();
    await core.shutdown();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return { core, server, port, token };
}

const isMain = process.argv[1] && /main\.(ts|js|mjs)$|jarvis-core(\.mjs)?$/.test(process.argv[1]);
if (isMain) {
  process.removeAllListeners('warning');
  process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });
  start().catch((e) => {
    console.error('Falha ao iniciar o JARVIS Core:', e);
    process.exit(1);
  });
}
