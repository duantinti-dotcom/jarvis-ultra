import dns from 'node:dns/promises';
import net from 'node:net';
import type { Tool } from '../types.js';
import { untrusted } from './untrusted.js';

/** Bloqueia destinos internos (localhost, rede privada, metadados de nuvem) — proteção SSRF. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`URL inválida: ${raw}`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Somente http/https.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('Destino interno bloqueado.');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  for (const ip of addrs) if (isPrivateIp(ip)) throw new Error(`Destino em rede privada bloqueado (${ip}).`);
  return u;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export function htmlToText(html: string): { title: string; text: string; links: { text: string; href: string }[] } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const links: { text: string; href: string }[] = [];
  html.replace(/<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, t: string) => {
    if (links.length < 60) links.push({ href, text: decode(t.replace(/<[^>]+>/g, '')).trim().slice(0, 120) });
    return '';
  });
  const text = decode(
    html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|h\d|li|tr|br|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { title: decode(title), text, links };
}

function decode(s: string) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
}

export const webTools: Tool[] = [
  {
    manifest: {
      name: 'web.fetch', version: '1.0.0', category: 'research', permissions: ['net.fetch'], risk: 'low', reversible: true, timeoutMs: 30_000, requires: [],
      description: 'Baixa uma página pública da internet e devolve o texto legível. O conteúdo é tratado como informação externa não confiável.',
      parameters: { type: 'object', properties: { url: { type: 'string' }, maxChars: { type: 'integer', default: 20000 } }, required: ['url'] },
      returns: 'Título, texto e links da página',
    },
    async run(a, ctx) {
      let url = await assertPublicUrl(String(a.url));
      let res: Response | null = null;
      for (let hop = 0; hop < 5; hop++) {
        res = await fetch(url, { redirect: 'manual', signal: ctx.signal, headers: { 'user-agent': 'Mozilla/5.0 JARVIS-ULTRA/0.1', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' } });
        const loc = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && loc) {
          url = await assertPublicUrl(new URL(loc, url).toString());
          continue;
        }
        break;
      }
      if (!res) return { ok: false, error: 'sem resposta' };
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} em ${url}` };
      const type = res.headers.get('content-type') ?? '';
      const body = (await res.text()).slice(0, 3_000_000);
      const parsed = type.includes('html') ? htmlToText(body) : { title: '', text: body, links: [] };
      return { ok: true, data: { url: url.toString(), status: res.status, title: parsed.title, links: parsed.links.slice(0, 30), ...untrusted(url.hostname, parsed.text, Number(a.maxChars ?? 20000)) } };
    },
  },
  {
    manifest: {
      name: 'web.search', version: '1.0.0', category: 'research', permissions: ['net.fetch'], risk: 'low', reversible: true, timeoutMs: 30_000, requires: [],
      description: 'Pesquisa na internet (DuckDuckGo) e retorna os primeiros resultados com título, link e resumo.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', default: 8 } }, required: ['query'] },
      returns: 'Lista de resultados',
    },
    async run(a, ctx) {
      const res = await fetch('https://html.duckduckgo.com/html/', {
        method: 'POST', signal: ctx.signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 JARVIS-ULTRA/0.1' },
        body: new URLSearchParams({ q: String(a.query), kl: 'br-pt' }),
      });
      if (!res.ok) return { ok: false, error: `Busca indisponível (HTTP ${res.status})` };
      const html = await res.text();
      const results: { title: string; url: string; snippet: string }[] = [];
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && results.length < Number(a.limit ?? 8)) {
        let href = m[1]!;
        const uddg = href.match(/uddg=([^&]+)/);
        if (uddg) href = decodeURIComponent(uddg[1]!);
        results.push({ url: href, title: htmlToText(m[2]!).text, snippet: htmlToText(m[3]!).text });
      }
      if (!results.length) return { ok: false, error: 'Nenhum resultado (ou o provedor de busca bloqueou a consulta).' };
      return { ok: true, data: { query: a.query, results, ...untrusted('duckduckgo', results.map((r) => `${r.title}\n${r.url}\n${r.snippet}`).join('\n\n')) } };
    },
  },
];
