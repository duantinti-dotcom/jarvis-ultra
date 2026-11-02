/** Utilidades do Jarvis Code (sites): leitura dos arquivos na resposta, preview e .zip. */

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'file'; name: string; lang: string; content: string; done: boolean }
  | { kind: 'delete'; name: string };

const FENCE = /^\s*```+\s*([^\n]*)$/;
const CLOSE = /^\s*```+\s*$/;
const FILE_RE = /([\w.\/-]*[\w-]\.(html?|css|m?js|jsx|ts|tsx|json|svg|md|txt|xml|webmanifest))\b/i;
const LANG_FILE: Record<string, string> = { html: 'index.html', htm: 'index.html', css: 'styles.css', js: 'script.js', javascript: 'script.js', mjs: 'script.js' };

/** Nome de arquivo citado numa linha ("**index.html**", "### styles.css", "`script.js`:"...). */
function nameIn(line: string | undefined): string | null {
  if (!line || line.length > 120) return null;
  const m = FILE_RE.exec(line.replace(/[*`#>:_]/g, ' '));
  return m ? m[1]!.replace(/^\.?\//, '') : null;
}

/**
 * Divide a resposta do modelo em texto, arquivos e remoções. Tolerante: aceita
 * "```html index.html", "```html finalidade index.html", "```html:index.html",
 * o nome na linha anterior ao bloco, ou só a linguagem (html → index.html etc.).
 */
export function parseSegments(src: string): Segment[] {
  const out: Segment[] = [];
  const lines = src.split('\n');
  let text: string[] = [];
  const seen = new Set<string>();
  const flush = () => { const t = text.join('\n'); if (t.trim()) out.push({ kind: 'text', text: t }); text = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE.exec(line);
    if (f && !CLOSE.test(line)) {
      const info = f[1]!.trim();
      const lang = (/^[\w+-]+/.exec(info)?.[0] ?? '').toLowerCase();
      const body: string[] = [];
      let done = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (CLOSE.test(lines[j]!)) { done = true; break; }
        body.push(lines[j]!);
      }
      // nome: na própria cerca > na linha anterior (ignorando vazias) > comentário na 1ª linha > pela linguagem
      let k = text.length - 1;
      while (k >= 0 && !text[k]!.trim()) k--;
      const prev = k >= 0 ? text[k] : undefined;
      let name = nameIn(info.slice(lang.length)) ?? nameIn(info.includes('.') ? info : undefined) ?? nameIn(prev) ?? nameIn(/^\s*(<!--|\/\*|\/\/)/.test(body[0] ?? '') ? body[0] : undefined);
      if (name && new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.continue`).test(info + ' ' + (prev ?? ''))) name += '.continue';
      const code = ['html', 'htm', 'css', 'js', 'javascript', 'mjs'].includes(lang);
      if (!name && code) {
        const guess = LANG_FILE[lang]!;
        // um 2º bloco da mesma linguagem sem nome é exemplo/trecho, não arquivo
        if (!seen.has(guess) && (lang !== 'html' || /<(!doctype|html|head|body)/i.test(body.slice(0, 6).join('\n')))) name = guess;
      }
      // a IA às vezes escreve o nome do arquivo sozinho na 1ª linha do código
      if (body.length && /^\s*(<!--\s*|\/\*\s*|\/\/\s*)?[\w./-]+\.(html?|css|m?js)\s*(-->|\*\/)?\s*$/i.test(body[0]!)) {
        name ??= nameIn(body[0]);
        body.shift();
      }
      if (name) {
        if (prev !== undefined && nameIn(prev) === name && prev.trim().length < 80) text.splice(k, 1);
        flush();
        seen.add(name);
        out.push({ kind: 'file', name, lang, content: body.join('\n') + (done ? '\n' : ''), done });
      } else {
        text.push(line, ...body);
        if (done) text.push(lines[j]!);
      }
      i = j;
      continue;
    }
    const del = /^DELETE:\s*([\w./-]+)\s*$/.exec(line.trim());
    if (del) { flush(); out.push({ kind: 'delete', name: del[1]! }); continue; }
    text.push(line);
  }
  flush();
  return out;
}

/**
 * Aplica os arquivos completos e remoções da resposta. Blocos "nome.continue" são
 * continuação de um arquivo cortado (o provedor limitou o tamanho da resposta).
 */
export function applySegments(files: Record<string, string>, segs: Segment[], partials: Record<string, string> = {}) {
  const next = { ...files };
  const pend = { ...partials };
  const changes: { name: string; kind: 'create' | 'update' | 'delete'; lines: number }[] = [];
  for (const s of segs) {
    if (s.kind === 'file') {
      const cont = s.name.endsWith('.continue');
      const name = cont ? s.name.slice(0, -'.continue'.length) : s.name;
      const content = cont ? joinCont(pend[name] ?? '', s.content) : s.content;
      if (!s.done) { pend[name] = content; continue; }
      delete pend[name];
      changes.push({ name, kind: name in next ? 'update' : 'create', lines: content.split('\n').length - 1 });
      next[name] = content;
    } else if (s.kind === 'delete' && s.name in next) {
      delete next[s.name];
      changes.push({ name: s.name, kind: 'delete', lines: 0 });
    }
  }
  return { files: next, changes, incomplete: Object.keys(pend), partials: pend };
}

/**
 * Último recurso quando a IA não consegue terminar um arquivo: aproveita o que veio.
 * CSS/HTML funcionam parciais (fecha as chaves abertas); JS volta até o último trecho válido.
 */
export function finishPartial(name: string, content: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'css') {
    let c = content.replace(/[^}]*$/, (tail) => (/\{/.test(tail) ? tail.replace(/;?\s*[^;{}]*$/, ';') : ''));
    const open = (c.match(/\{/g)?.length ?? 0) - (c.match(/\}/g)?.length ?? 0);
    if (open > 0) c += '\n' + '}'.repeat(open);
    return c + '\n';
  }
  if (ext === 'html' || ext === 'htm') return content + '\n';
  if (ext === 'js' || ext === 'mjs') {
    const lines = content.split('\n');
    // a última linha foi cortada no meio: começa sem ela
    for (let n = lines.length - 1; n > 0 && lines.length - n < 400; n--) {
      let code = lines.slice(0, n).join('\n');
      const open = (code.match(/\{/g)?.length ?? 0) - (code.match(/\}/g)?.length ?? 0);
      if (open > 0) code += '\n' + '}'.repeat(open);
      try { new Function(code); return code + '\n'; } catch { /* tenta com menos linhas */ }
    }
    return null;
  }
  return null;
}

/** Junta a continuação removendo a sobreposição (o modelo às vezes repete o final). */
function joinCont(a: string, b: string) {
  const max = Math.min(400, a.length, b.length);
  for (let k = max; k >= 12; k--) if (a.endsWith(b.slice(0, k))) return a + b.slice(k);
  // a IA voltou alguns trechos e repetiu código já recebido: junta no ponto onde a repetição começa
  const rep = b.split('\n').find((l) => l.trim().length >= 12);
  if (rep) {
    for (let idx = a.lastIndexOf(rep); idx >= 0; idx = idx > 0 ? a.lastIndexOf(rep, idx - 1) : -1) {
      const tail = a.slice(idx);
      if (b.startsWith(tail) || b.replace(/\s+/g, ' ').startsWith(tail.replace(/\s+/g, ' ').trimEnd())) return a.slice(0, idx) + b;
    }
  }
  // a última linha ficou pela metade e o modelo a reescreveu inteira: troca a linha
  const cut = a.lastIndexOf('\n');
  const tail = a.slice(cut + 1).trim();
  const first = b.split('\n')[0]!.trim();
  if (tail && first.startsWith(tail)) return a.slice(0, cut + 1) + b;
  return a + b;
}

/** Pedido automático para continuar um arquivo cortado. */
export function continuePrompt(name: string, partial: string) {
  const lang = name.split('.').pop();
  const lines = partial.split('\n');
  return `A resposta anterior foi cortada no meio do arquivo ${name} (já recebi ${lines.length} linhas). NÃO recomece o arquivo. Continue exatamente da linha seguinte a esta:\n<<<\n${lines.slice(-6).join('\n')}\n>>>\nResponda SOMENTE com um bloco \`\`\`${lang} ${name}.continue contendo o restante, de forma enxuta (feche o que estiver aberto e termine o arquivo), e depois os demais arquivos que ainda faltarem, completos e curtos.`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const mime = (n: string) => ({ svg: 'image/svg+xml', json: 'application/json', css: 'text/css', js: 'text/javascript', txt: 'text/plain' } as Record<string, string>)[n.split('.').pop() ?? ''] ?? 'text/plain';
const toDataUrl = (n: string, c: string) => `data:${mime(n)};charset=utf-8,${encodeURIComponent(c)}`;
const rel = (p: string) => p.replace(/^\.?\//, '').split(/[?#]/)[0]!;

/** Ponte injetada no preview: erros do console e navegação entre páginas do projeto. */
const BRIDGE = `<script>(function(){
var mem=function(){var d={};return{getItem:function(k){return k in d?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}};
['localStorage','sessionStorage'].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});
var send=function(t,m){try{parent.postMessage({__jarvis:1,type:t,msg:String(m).slice(0,600)},'*')}catch(e){}};
window.addEventListener('error',function(e){send('error',(e.message||'erro')+(e.lineno?' (linha '+e.lineno+')':''))});
window.addEventListener('unhandledrejection',function(e){send('error','Promise rejeitada: '+(e.reason&&e.reason.message||e.reason))});
var ce=console.error;console.error=function(){send('error',[].slice.call(arguments).join(' '));ce.apply(console,arguments)};
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href');
if(h&&/^[\\w./-]+\\.html(#.*)?$/.test(h)&&!/^https?:/.test(h)){e.preventDefault();send('nav',h.split('#')[0])}});
})();<\/script>`;

/** Monta um documento único (CSS/JS/SVG do projeto embutidos) para o iframe isolado. */
export function buildPreview(files: Record<string, string>, page = 'index.html'): string {
  let html = files[page] ?? files['index.html'] ?? Object.entries(files).find(([n]) => n.endsWith('.html'))?.[1];
  if (html == null) {
    const css = Object.entries(files).filter(([n]) => n.endsWith('.css')).map(([, c]) => c).join('\n');
    const js = Object.entries(files).filter(([n]) => n.endsWith('.js')).map(([, c]) => c).join('\n');
    html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><script>${js}<\/script></body></html>`;
  }
  html = html.replace(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/gi, (m, href: string) => {
    const c = files[rel(href)];
    return c != null && /stylesheet/i.test(m) ? `<style data-file="${esc(rel(href))}">\n${c}\n</style>` : m;
  });
  html = html.replace(/<script\b([^>]*)\bsrc=["']([^"']+\.m?js)["']([^>]*)>\s*<\/script>/gi, (m, a: string, src: string, b: string) => {
    const c = files[rel(src)];
    if (c == null) return m;
    const type = /type=["']module["']/i.test(a + b) ? ' type="module"' : '';
    return `<script${type} data-file="${esc(rel(src))}">\n${c.replace(/<\/script/gi, '<\\/script')}\n</script>`;
  });
  // imagens/arquivos do projeto referenciados por src/href
  html = html.replace(/\b(src|href)=["']([^"':]+\.(svg|json|txt))["']/gi, (m, attr: string, p: string) => {
    const c = files[rel(p)];
    return c != null ? `${attr}="${toDataUrl(p, c)}"` : m;
  });
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => `${h}${BRIDGE}`) : BRIDGE + html;
}

// ---------------------------------------------------------------- ZIP (sem compressão)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function makeZip(files: Record<string, string>): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const [name, content] of Object.entries(files)) {
    const nb = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true); h.setUint16(28, 0, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, nb.length, true); c.setUint32(42, offset, true);
    parts.push(new Uint8Array(h.buffer), nb, data);
    central.push(new Uint8Array(c.buffer), nb);
    offset += 30 + nb.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  const count = Object.keys(files).length;
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, count, true); e.setUint16(10, count, true); e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)] as BlobPart[], { type: 'application/zip' });
}

/** Instruções usadas quando o Jarvis Code roda no modelo local do PC (sem a nuvem). */
export const LOCAL_CODE_PROMPT = `Você é o JARVIS Code. Crie/altere um site completo. Entregue cada arquivo INTEIRO num bloco cuja primeira linha é "\`\`\`lang nome-do-arquivo" (ex.: \`\`\`html index.html, \`\`\`css styles.css, \`\`\`js script.js). index.html referencia os outros por caminho relativo. Sem build. Design moderno, responsivo e acessível, textos em português. Explique em 1–2 frases antes dos arquivos.`;
