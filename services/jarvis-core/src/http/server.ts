import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router, HttpError, readRaw, type Ctx } from './router.js';
import type { Core } from '../core.js';
import { recentLogs, onLog, logger } from '../log.js';

const log = logger('http');

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json' };

export function loadOrCreateToken(dataDir: string) {
  const f = path.join(dataDir, 'auth-token');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('base64url'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

export function createServer(core: Core, router: Router, token: string) {
  const { config } = core;
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  const allowedOrigins = new Set([
    `http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost',
    ...(process.env.JARVIS_DEV_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000').split(',').filter(Boolean),
  ]);
  const tokenBuf = Buffer.from(token);
  const authed = (req: http.IncomingMessage, query: URLSearchParams) => {
    const h = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? query.get('token') ?? '';
    const b = Buffer.from(h);
    return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    // Proteção contra DNS rebinding: só aceita Host de loopback.
    if (!allowedHosts.has(req.headers.host ?? '')) {
      res.writeHead(421).end('host não permitido');
      return;
    }
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    } else if (origin) {
      res.writeHead(403).end('origem não permitida');
      return;
    }
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (!url.pathname.startsWith('/api/')) return serveStatic(config.uiDir, url.pathname, res);

    if (url.pathname === '/api/health') return send(res, 200, { ok: true, name: 'jarvis-core', version: core.version });
    if (url.pathname === '/api/bootstrap') {
      // Entrega o token apenas para a própria interface servida pelo core (mesma origem).
      if (req.headers['sec-fetch-site'] !== 'same-origin') return send(res, 403, { error: 'somente para a interface local' });
      return send(res, 200, { token });
    }
    if (!authed(req, url.searchParams)) return send(res, 401, { error: 'não autenticado' });

    if (url.pathname === '/api/events') return sse(core, req, res);

    const m = router.match(req.method ?? 'GET', url.pathname);
    if (!m) return send(res, 404, { error: 'rota inexistente' });
    const ctx: Ctx = {
      req, res, params: m.params, query: url.searchParams,
      body: async () => {
        const raw = await readRaw(req);
        if (!raw.length) return {};
        try {
          return JSON.parse(raw.toString('utf8'));
        } catch {
          throw new HttpError(400, 'JSON inválido');
        }
      },
      raw: (limit) => readRaw(req, limit),
    };
    try {
      const out = await m.h(ctx);
      if (res.headersSent || res.writableEnded) return;
      send(res, 200, out ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : (e as Error).name === 'PermissionError' ? 403 : (e as Error).name === 'ZodError' ? 400 : 500;
      if (status >= 500) log.error(`${req.method} ${url.pathname}: ${(e as Error).stack}`);
      if (!res.headersSent) send(res, status, { error: (e as Error).message });
      else res.end();
    }
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

function sse(core: Core, req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(`retry: 2000\n\n`);
  const write = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  write('hello', { version: core.version, at: new Date().toISOString() });
  const off = core.bus.onEvent((e) => write('core', e));
  const offLog = onLog((l) => (l.level === 'warn' || l.level === 'error') && write('log', l));
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    off();
    offLog();
    clearInterval(ping);
  });
}

function serveStatic(uiDir: string | null, pathname: string, res: http.ServerResponse) {
  if (!uiDir || !fs.existsSync(uiDir)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('JARVIS Core em execução. Interface não encontrada (defina JARVIS_UI_DIR).');
    return;
  }
  const rel = decodeURIComponent(pathname).replace(/\\/g, '/');
  let file = path.join(uiDir, path.normalize(rel).replace(/^([.][.][/\\])+/, ''));
  if (!file.startsWith(path.resolve(uiDir))) return void res.writeHead(400).end();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file)) file = path.join(uiDir, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': /\/_next\/static\//.test(file.replace(/\\/g, '/')) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://*.supabase.co wss://*.supabase.co; font-src 'self' data:",
  });
  fs.createReadStream(file).pipe(res);
}

export { recentLogs };
