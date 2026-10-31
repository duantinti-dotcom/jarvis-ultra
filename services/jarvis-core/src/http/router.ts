import type { IncomingMessage, ServerResponse } from 'node:http';

export type Ctx = { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; query: URLSearchParams; body: () => Promise<any>; raw: (limit?: number) => Promise<Buffer> };
export type Handler = (c: Ctx) => Promise<unknown> | unknown;

export class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

export class Router {
  private routes: { method: string; re: RegExp; keys: string[]; h: Handler }[] = [];
  on(method: string, pattern: string, h: Handler) {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, h });
    return this;
  }
  get = (p: string, h: Handler) => this.on('GET', p, h);
  post = (p: string, h: Handler) => this.on('POST', p, h);
  put = (p: string, h: Handler) => this.on('PUT', p, h);
  patch = (p: string, h: Handler) => this.on('PATCH', p, h);
  del = (p: string, h: Handler) => this.on('DELETE', p, h);

  match(method: string, path: string) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = path.match(r.re);
      if (m) return { h: r.h, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)])) };
    }
    return null;
  }
}

export function readRaw(req: IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Corpo da requisição muito grande.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
