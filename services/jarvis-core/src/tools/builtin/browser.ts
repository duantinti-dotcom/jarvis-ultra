import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import type { Tool, ToolContext } from '../types.js';
import { untrusted } from './untrusted.js';
import { assertPublicUrl } from './web.js';
import { newId } from '../../util/ids.js';

let ctxPromise: Promise<BrowserContext> | null = null;
let page: Page | null = null;

function candidateExecutables(): string[] {
  const env = process.env;
  const list = [
    env.JARVIS_BROWSER_PATH,
    process.platform === 'win32' ? path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe') : undefined,
    process.platform === 'win32' ? path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe') : undefined,
    process.platform === 'win32' ? path.join(env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe') : undefined,
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ];
  return list.filter((p): p is string => !!p);
}

export function findBrowser(): string | null {
  for (const c of candidateExecutables()) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return c;
      if (st.isDirectory()) {
        // Diretório de navegadores do Playwright: procura o executável do chromium.
        const sub = fs.readdirSync(c).find((d) => d.startsWith('chromium-'));
        const exe = sub ? path.join(c, sub, 'chrome-linux', 'chrome') : null;
        if (exe && fs.existsSync(exe)) return exe;
      }
    } catch {}
  }
  return null;
}

async function getPage(tc: ToolContext): Promise<Page> {
  if (!ctxPromise) {
    const exe = findBrowser();
    if (!exe) throw new Error('Nenhum navegador Chromium/Edge/Chrome encontrado. Defina JARVIS_BROWSER_PATH.');
    const { chromium } = await import('playwright-core');
    const headless = process.env.JARVIS_BROWSER_HEADLESS === '1';
    // Perfil persistente: logins feitos pelo usuário nesta janela continuam valendo.
    ctxPromise = chromium.launchPersistentContext(path.join(tc.config.dataDir, 'browser-profile'), {
      executablePath: exe, headless, viewport: { width: 1280, height: 860 }, locale: 'pt-BR',
      args: process.platform === 'linux' ? ['--no-sandbox'] : [],
    });
    ctxPromise.then((c) => c.on('close', () => { ctxPromise = null; page = null; })).catch(() => { ctxPromise = null; });
  }
  const c = await ctxPromise;
  if (!page || page.isClosed()) page = c.pages()[0] ?? (await c.newPage());
  return page;
}

async function pageState(p: Page, max = 15000) {
  const text = await p.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  return { url: p.url(), title: await p.title().catch(() => ''), ...untrusted(new URL(p.url()).hostname || 'pagina', text, max) };
}

export async function closeBrowser() {
  const c = await ctxPromise?.catch(() => null);
  ctxPromise = null;
  page = null;
  await c?.close().catch(() => {});
}

const base = { version: '1.0.0', category: 'browser' as const, requires: ['chromium'], reversible: true };

export const browserTools: Tool[] = [
  {
    manifest: { ...base, name: 'browser.open', permissions: ['browser.control'], risk: 'low', timeoutMs: 45_000,
      description: 'Abre uma página no navegador controlado pelo JARVIS (janela visível, com perfil próprio onde o usuário pode fazer login) e retorna o texto visível.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, returns: 'URL final, título e texto da página' },
    async available() {
      return findBrowser() ? { ok: true } : { ok: false, reason: 'Nenhum navegador Chromium encontrado' };
    },
    async run(a, ctx) {
      const raw = /^https?:\/\//.test(String(a.url)) ? String(a.url) : `https://${a.url}`;
      await assertPublicUrl(raw);
      const p = await getPage(ctx);
      const resp = await p.goto(raw, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return { ok: true, data: { status: resp?.status() ?? null, ...(await pageState(p)) } };
    },
    async verify(a, out) {
      const d = out.data as { url: string };
      return d.url && d.url !== 'about:blank' ? { ok: true, detail: `página carregada: ${d.url}` } : { ok: false, detail: 'página não carregou' };
    },
  },
  {
    manifest: { ...base, name: 'browser.read', permissions: ['browser.control'], risk: 'low', timeoutMs: 20_000,
      description: 'Lê a página atual do navegador: texto visível e a árvore de acessibilidade (botões, links, campos) para planejar interações.',
      parameters: { type: 'object', properties: { includeTree: { type: 'boolean', default: true } } }, returns: 'Texto e elementos interativos' },
    async run(a, ctx) {
      const p = await getPage(ctx);
      const tree = a.includeTree !== false ? await p.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => '') : '';
      return { ok: true, data: { ...(await pageState(p, 10000)), elements: untrusted('arvore-acessibilidade', tree, 12000).content } };
    },
  },
  {
    manifest: { ...base, name: 'browser.click', permissions: ['browser.control'], risk: 'medium', timeoutMs: 20_000,
      description: 'Clica em um elemento da página atual localizado por papel e nome acessível (ex.: role=button, name="Entrar") ou por texto visível.',
      parameters: { type: 'object', properties: { role: { type: 'string', description: 'button, link, checkbox, tab, menuitem...' }, name: { type: 'string' }, text: { type: 'string' } } }, returns: 'Nova URL e título' },
    async run(a, ctx) {
      const p = await getPage(ctx);
      const loc = a.role ? p.getByRole(String(a.role) as Parameters<Page['getByRole']>[0], a.name ? { name: String(a.name) } : {}) : a.text ? p.getByText(String(a.text), { exact: false }) : null;
      if (!loc) return { ok: false, error: 'Informe role+name ou text.' };
      const count = await loc.count();
      if (count === 0) return { ok: false, error: 'Elemento não encontrado na página.' };
      await loc.first().click({ timeout: 10_000 });
      await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      return { ok: true, data: { matched: count, url: p.url(), title: await p.title() } };
    },
  },
  {
    manifest: { ...base, name: 'browser.fill', permissions: ['browser.control'], risk: 'medium', timeoutMs: 20_000,
      description: 'Preenche um campo de formulário da página atual, localizado pelo rótulo ou placeholder. Não preenche campos de senha.',
      parameters: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, submit: { type: 'boolean', default: false } }, required: ['label', 'value'] }, returns: 'Campo preenchido' },
    async run(a, ctx) {
      const p = await getPage(ctx);
      let loc = p.getByLabel(String(a.label));
      if ((await loc.count()) === 0) loc = p.getByPlaceholder(String(a.label));
      if ((await loc.count()) === 0) return { ok: false, error: `Campo "${a.label}" não encontrado.` };
      const type = await loc.first().getAttribute('type');
      if (type === 'password') return { ok: false, error: 'Por segurança o JARVIS não preenche campos de senha. Digite-a você mesmo.' };
      await loc.first().fill(String(a.value));
      if (a.submit) await loc.first().press('Enter');
      return { ok: true, data: { label: a.label, submitted: !!a.submit, url: p.url() } };
    },
    async verify(a, out, ctx) {
      if ((out.data as { submitted: boolean }).submitted) return { ok: true, detail: 'enviado; verifique o resultado com browser.read' };
      const p = await getPage(ctx);
      let loc = p.getByLabel(String(a.label));
      if ((await loc.count()) === 0) loc = p.getByPlaceholder(String(a.label));
      const v = await loc.first().inputValue().catch(() => null);
      return v === String(a.value) ? { ok: true, detail: 'valor conferido no campo' } : { ok: false, detail: 'valor do campo difere' };
    },
  },
  {
    manifest: { ...base, name: 'browser.screenshot', permissions: ['browser.control'], risk: 'low', timeoutMs: 20_000,
      description: 'Captura a página atual do navegador do JARVIS em PNG (para análise visual).',
      parameters: { type: 'object', properties: {} }, returns: 'Caminho da imagem' },
    async run(_a, ctx) {
      const p = await getPage(ctx);
      const dir = path.join(ctx.config.dataDir, 'captures');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${newId('web')}.png`);
      await p.screenshot({ path: file });
      return { ok: true, data: { path: file, url: p.url() } };
    },
    async verify(_a, out) {
      return fs.existsSync((out.data as { path: string }).path) ? { ok: true, detail: 'imagem salva' } : { ok: false, detail: 'imagem não encontrada' };
    },
  },
];
