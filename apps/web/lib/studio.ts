/** Utilidades da Lume Code (sites): leitura dos arquivos na resposta, preview e .zip. */

/** Briefing de design que a Lume define antes de escrever o código. */
export type Brief = {
  negocio?: string; objetivo?: string; publico?: string; direcao?: string; referencias?: string[]; paginas?: string[];
  paleta?: Record<string, string>; tipografia?: { titulos?: string; texto?: string }; imagens?: string; componentes?: string[];
};

export type Segment =
  | { kind: 'brief'; brief: Brief | null; done: boolean }

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
      // briefing de design (```json lume-brief)
      if (/lume-brief/i.test(info)) {
        flush();
        let brief: Brief | null = null;
        if (done) { try { brief = JSON.parse(body.join('\n')) as Brief; } catch { brief = null; } }
        out.push({ kind: 'brief', brief, done });
        i = j;
        continue;
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

const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 10"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#e8e6e1"/><stop offset="1" stop-color="#d6d3cc"/></linearGradient></defs><rect width="16" height="10" fill="url(#g)"/></svg>').replace(/'/g, '%27');

/** Ponte injetada no preview: erros/console, navegação entre páginas, métricas de verificação e imagens geradas em tempo de execução. */
const BRIDGE = `<script>(function(){
var mem=function(){var d={};return{getItem:function(k){return k in d?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}};
['localStorage','sessionStorage'].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});
var send=function(t,m,x){try{parent.postMessage({__jarvis:1,type:t,msg:String(m).slice(0,600),data:x},'*')}catch(e){}};
var str=function(a){return [].slice.call(a).map(function(v){try{return typeof v==='object'?JSON.stringify(v):String(v)}catch(e){return String(v)}}).join(' ')};
window.addEventListener('error',function(e){if(e.target&&e.target.tagName)return;send('error',(e.message||'erro')+(e.lineno?' (linha '+e.lineno+')':''))},true);
window.addEventListener('unhandledrejection',function(e){send('error','Promise rejeitada: '+(e.reason&&e.reason.message||e.reason))});
['error','warn','log'].forEach(function(k){var o=console[k];console[k]=function(){send(k==='error'?'error':'console',(k==='log'?'':'['+k+'] ')+str(arguments));o.apply(console,arguments)}});
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href');
if(h&&/^[\\w./-]+\\.html(#.*)?$/.test(h)&&!/^https?:/.test(h)){e.preventDefault();send('nav',h.split('#')[0])}});
window.__lumeNav={go:function(v){var s=String(v);if(/^(mailto|tel|https?):/i.test(s)||s.indexOf('//')===0){location.href=s;return}if(s.charAt(0)==='#'){location.hash=s;return}
var name=s.split('#')[0].split('?')[0].split('/').pop()||'index.html';send('nav',/\\.html?$/i.test(name)?name:name+'.html')},set href(v){this.go(v)},get href(){return location.href}};
var PH='${PLACEHOLDER}';
function fix(img){var s=img.getAttribute('src')||'';if(s.indexOf('lume-image:')===0){img.setAttribute('data-lume-ref',s.slice(13));img.setAttribute('src',PH);send('img-request',s.slice(13))}}
new MutationObserver(function(ms){ms.forEach(function(m){if(m.type==='attributes')fix(m.target);m.addedNodes&&m.addedNodes.forEach(function(n){if(n.tagName==='IMG')fix(n);n.querySelectorAll&&n.querySelectorAll('img').forEach(fix)})})}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['src']});
window.addEventListener('message',function(e){var d=e.data||{};if(d.__lume==='img'){document.querySelectorAll('img[data-lume-ref]').forEach(function(i){if(i.getAttribute('data-lume-ref')===d.ref)i.setAttribute('src',d.url)})}});
function metrics(){var imgs=[].slice.call(document.images);var broken=imgs.filter(function(i){var s=i.getAttribute('src')||'';return i.complete&&i.naturalWidth===0&&s&&s.indexOf('data:')!==0}).map(function(i){return i.getAttribute('src').slice(0,120)});
var wide=[];if(document.documentElement.scrollWidth>innerWidth+1){[].slice.call(document.body.querySelectorAll('*')).forEach(function(el){var r=el.getBoundingClientRect();if(r.right>innerWidth+1&&r.width>0&&wide.length<5)wide.push((el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(el.className&&typeof el.className==='string'?'.'+el.className.trim().split(/\\s+/).slice(0,2).join('.'):''))+' ('+Math.round(r.right)+'px)')})}
send('metrics','',{width:innerWidth,overflow:Math.max(0,document.documentElement.scrollWidth-innerWidth),wide:wide,images:imgs.length,broken:broken,h1:document.querySelectorAll('h1').length,title:document.title})}
addEventListener('load',function(){setTimeout(metrics,1500)});
// teste de fumaça (só na verificação): preenche e envia cada formulário, como uma pessoa faria; os erros voltam com o nome do formulário
var smoking=null;var oldSend=send;send=function(t,m,x){oldSend(t,t==='error'&&smoking?'ao enviar o formulário '+smoking+': '+m:m,x)};
function val(el){var t=(el.type||'').toLowerCase();var d=new Date(Date.now()+864e5);
if(t==='email')return 'teste@exemplo.com';if(t==='password')return 'Teste@1234';if(t==='number'||t==='range')return el.min||'1';if(t==='date')return d.toISOString().slice(0,10);
if(t==='time')return '10:00';if(t==='datetime-local')return d.toISOString().slice(0,10)+'T10:00';if(t==='tel')return '11999990000';if(t==='url')return 'https://exemplo.com';if(t==='color')return '#336699';
if(el.tagName==='TEXTAREA')return 'Mensagem de teste da verificação automática.';return 'Teste'}
function smoke(){var forms=[].slice.call(document.forms,0,6);var n=0;
window.addEventListener('submit',function(e){e.preventDefault()});
forms.forEach(function(f){smoking='"'+(f.id||f.getAttribute('name')||('nº '+(++n)))+'"';
try{[].slice.call(f.elements).forEach(function(el){var t=(el.type||'').toLowerCase();if(el.disabled||t==='hidden'||t==='file'||t==='submit'||t==='button'||t==='reset')return;
if(t==='checkbox')el.checked=true;else if(t==='radio'){if(!f.querySelector('input[type=radio][name="'+el.name+'"]:checked'))el.checked=true}
else if(el.tagName==='SELECT'){var o=[].slice.call(el.options).filter(function(o){return o.value})[0];if(o)el.value=o.value}else el.value=val(el);
el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))});
if(f.requestSubmit)f.requestSubmit();else f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))}catch(err){send('error',err&&err.message||err)}});
setTimeout(function(){smoking=null;send('smoke','',{forms:forms.length})},300)}
window.addEventListener('message',function(e){if((e.data||{}).__lume==='smoke')smoke()});
})();<\/script>`;


/** Referências de imagem por IA usadas no projeto (lume-image://descrição?w=&h=). */
export type ImageRef = { ref: string; prompt: string; w: number; h: number };
const IMG_RE = /lume-image:\/\/([^"'`)<>\n]+)/g;
export function findImageRefs(files: Record<string, string>): ImageRef[] {
  const seen = new Map<string, ImageRef>();
  for (const [n, c] of Object.entries(files)) {
    if (!/\.(html?|css|m?js|json)$/i.test(n) || c.startsWith('data:')) continue;
    for (const m of c.matchAll(IMG_RE)) {
      const ref = m[1]!.trim();
      if (!ref || ref.includes('${') || seen.has(ref)) continue;
      const [desc, q = ''] = ref.split('?');
      const params = new URLSearchParams(q);
      seen.set(ref, { ref, prompt: decodeURIComponent(desc!.replace(/\+/g, ' ')).trim(), w: Number(params.get('w')) || 1024, h: Number(params.get('h')) || 768 });
    }
  }
  return [...seen.values()];
}
/** Troca as referências já geradas pelas URLs reais nos arquivos do projeto. */
export function applyImages(files: Record<string, string>, urls: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, c] of Object.entries(files)) {
    out[n] = c.startsWith('data:') ? c : c.replace(IMG_RE, (all, ref: string) => urls[ref.trim()] ?? all);
  }
  return out;
}

const navRewrite = (code: string) => code
  .replace(/(^|[^\w$.])(?:(?:window|document|self|top)\.)?location(?:\.href)?\s*=(?!=)/g, '$1__lumeNav.href=')
  .replace(/(^|[^\w$.])(?:(?:window|document|self|top)\.)?location\.(?:assign|replace)\s*\(/g, '$1__lumeNav.go(');

/** Monta um documento único (CSS/JS/imagens do projeto embutidos) para o iframe isolado. */
export function buildPreview(files: Record<string, string>, page = 'index.html', images: Record<string, string> = {}): string {
  let html = files[page] ?? files['index.html'] ?? Object.entries(files).find(([n]) => n.endsWith('.html'))?.[1];
  if (html == null) {
    const css = Object.entries(files).filter(([n]) => n.endsWith('.css')).map(([, c]) => c).join('\n');
    const js = Object.entries(files).filter(([n]) => /\.m?js$/.test(n)).map(([, c]) => c).join('\n');
    html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><script>${js}<\/script></body></html>`;
  }
  html = html.replace(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/gi, (m, href: string) => {
    const c = files[rel(href)];
    return c != null && /stylesheet/i.test(m) ? `<style data-file="${esc(rel(href))}">\n${c}\n</style>` : m;
  });
  // Scripts embutidos perdem o "defer": os que eram defer/async vão para o fim do <body>, na mesma ordem,
  // para rodarem só depois do HTML existir (como no navegador de verdade).
  const deferred: string[] = [];
  html = html.replace(/<script\b([^>]*)\bsrc=["']([^"']+\.m?js)["']([^>]*)>\s*<\/script>/gi, (m, a: string, src: string, b: string) => {
    const c = files[rel(src)];
    if (c == null) return m;
    const attrs = a + b;
    const type = /type=["']module["']/i.test(attrs) ? ' type="module"' : '';
    const tag = `<script${type} data-file="${esc(rel(src))}">\n${c.replace(/<\/script/gi, '<\\/script')}\n</script>`;
    if (!type && /\b(defer|async)\b/i.test(attrs)) { deferred.push(tag); return ''; }
    return tag;
  });
  // navegação por script vira troca de página do projeto (num iframe isolado, "pagina.html" abriria o próprio Lume)
  html = html.replace(/(<script\b(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/gi, (_m, a: string, code: string, c: string) => a + navRewrite(code) + c);
  deferred.forEach((t, i) => { deferred[i] = t.replace(/^(<script\b[^>]*>)([\s\S]*)(<\/script>)$/, (_m, a: string, code: string, c: string) => a + navRewrite(code) + c); });
  if (deferred.length) html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${deferred.join('\n')}\n</body>`) : html + deferred.join('\n');
  // arquivos do projeto (svg/json/txt e imagens enviadas pelo usuário) referenciados por src/href/url()
  const asset = (p: string) => { const c = files[rel(p)]; return c == null ? null : c.startsWith('data:') ? c : /\.(svg|json|txt)$/i.test(p) ? toDataUrl(p, c) : null; };
  html = html.replace(/\b(src|href|poster)=["']([^"':]+\.(svg|json|txt|png|jpe?g|webp|gif|avif))["']/gi, (m, attr: string, p: string) => { const d = asset(p); return d ? `${attr}="${d}"` : m; });
  html = html.replace(/url\(\s*["']?([^"')]+\.(svg|png|jpe?g|webp|gif|avif))["']?\s*\)/gi, (m, p: string) => { const d = asset(p); return d && !/^(https?:|data:)/.test(p) ? `url("${d}")` : m; });
  // imagens por IA: já geradas viram URL; as que faltam ficam com um fundo neutro até ficarem prontas
  html = html.replace(IMG_RE, (_all, ref: string) => images[ref.trim()] ?? PLACEHOLDER);
  const bridge = BRIDGE;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => `${h}${bridge}`) : bridge + html;
}

/** Converte a linha de um erro no documento do preview em arquivo:linha do projeto + o trecho do código. */
export function locateLine(doc: string, line: number, page: string): string | null {
  const lines = doc.split('\n');
  const text = lines[line - 1];
  if (text == null) return null;
  let k = line - 2;
  while (k >= 0 && !/<script\b[^>]*data-file="[^"]+"[^>]*>\s*$/.test(lines[k]!) && !/<\/script>/i.test(lines[k]!)) k--;
  const m = k >= 0 ? /data-file="([^"]+)"/.exec(lines[k]!) : null;
  const where = m ? `${m[1]}:${line - 1 - k}` : page;
  const snippet = text.trim().slice(0, 140);
  return snippet ? `${where} — ${snippet}` : where;
}

/** Problemas que dá para ver sem executar: arquivos referenciados que não existem e nomes declarados duas vezes. */
export function staticProblems(files: Record<string, string>): string[] {
  const out: string[] = [];
  const names = new Set(Object.keys(files));
  for (const [n, c] of Object.entries(files)) {
    if (!/\.html?$/i.test(n)) continue;
    for (const m of c.matchAll(/\b(?:src|href)=["']([^"'#?]+)["']/gi)) {
      const p = m[1]!;
      if (/^(https?:|data:|mailto:|tel:|javascript:|lume-image:|\/\/|#)/i.test(p) || p.includes('${')) continue;
      if (!names.has(rel(p))) out.push(`${n}: aponta para "${p}", que não existe no projeto`);
    }
    // import/export num script comum é SyntaxError: a página inteira para de funcionar
    for (const m of c.matchAll(/<script\b([^>]*)\bsrc=["']([^"']+\.m?js)["'][^>]*>/gi)) {
      const f = rel(m[2]!);
      if (names.has(f) && !/type=["']module/i.test(m[0]) && /^\s*(?:import\s[\s\S]*?from\s|import\s*["']|export\s)/m.test(files[f]!))
        out.push(`${f} usa import/export, mas ${n} o carrega como script comum (sem type="module"): dá SyntaxError e nada roda. Reescreva sem import/export: dados como variáveis globais em data.js, carregado antes dos outros scripts`);
    }
    // a mesma função/variável declarada em dois scripts da mesma página quebra a página inteira
    const scripts = [...c.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.m?js)["']/gi)].map((m) => rel(m[1]!)).filter((x) => names.has(x) && !/type=["']module/.test(c));
    const seen = new Map<string, string>();
    for (const f of scripts) {
      for (const m of files[f]!.matchAll(/^(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/gm)) {
        const prev = seen.get(m[1]!);
        if (prev && prev !== f) out.push(`${n}: "${m[1]}" é declarado em ${prev} e em ${f} (erro de declaração duplicada)`);
        else seen.set(m[1]!, f);
      }
    }
  }
  out.push(...coherenceProblems(files));
  return [...new Set(out)].slice(0, 12);
}

const inlineJs = (html: string) => [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');

/** Coerência entre páginas: nomes usados mas definidos em arquivo não carregado, e painel que grava dados que o site não lê. */
function coherenceProblems(files: Record<string, string>): string[] {
  const out: string[] = [];
  const js = Object.keys(files).filter((n) => /\.m?js$/.test(n) && !files[n]!.startsWith('data:'));
  const decl = (f: string) => [...files[f]!.matchAll(/^(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]{3,})/gm)].map((m) => m[1]!);
  const pages = Object.keys(files).filter((n) => /\.html?$/i.test(n));
  const loaded = (page: string) => [...files[page]!.matchAll(/<script\b[^>]*\bsrc=["']([^"']+\.m?js)["']/gi)].map((m) => rel(m[1]!)).filter((x) => x in files);
  const keysOf = (srcs: string[], op: 'get' | 'set', extra = '') => {
    const code = srcs.map((f) => files[f]!).join('\n') + '\n' + extra;
    const consts = new Map([...code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`]([^'"`]+)['"`]/g)].map((m) => [m[1]!, m[2]!]));
    const re = op === 'get' ? /localStorage\.getItem\(\s*([^)]+?)\s*\)/g : /localStorage\.setItem\(\s*([^,]+?)\s*,/g;
    return new Set([...code.matchAll(re)].map((m) => { const k = m[1]!.trim(); return /^['"`]/.test(k) ? k.slice(1, -1) : consts.get(k) ?? ''; }).filter(Boolean));
  };
  for (const page of pages) {
    const srcs = loaded(page);
    // tudo que é declarado no código carregado (inclusive dentro de funções) conta como definido aqui
    const here = new Set(srcs.flatMap((f) => [...files[f]!.matchAll(/\b(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!)));
    // só código de verdade: JS carregado + <script> da página, sem textos entre aspas (ids como "admin-login-form" não contam)
    const code = (srcs.map((f) => files[f]!).join('\n') + '\n' + inlineJs(files[page]!)).replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
    for (const f of js.filter((x) => !srcs.includes(x))) {
      for (const name of decl(f)) {
        if (!here.has(name) && new RegExp(`(^|[^\\w$.-])${name.replace(/\$/g, '\\$')}\\b(?!-)`).test(code)) { out.push(`${page} usa "${name}", definido em ${f}, mas não carrega ${f} (vai dar erro "${name} is not defined")`); break; }
      }
    }
  }
  const admin = pages.find((p) => /admin|painel|gerenci/i.test(p));
  const others = pages.filter((p) => p !== admin);
  if (admin && others.length) {
    // o painel precisa gravar em alguma chave que ALGUMA página do site lê
    const writes = keysOf(loaded(admin), 'set', inlineJs(files[admin]!));
    const reads = new Set(others.flatMap((p) => [...keysOf(loaded(p), 'get', inlineJs(files[p]!))]));
    if (writes.size && reads.size && ![...writes].some((k) => reads.has(k))) out.push(`${admin} grava os dados em ${[...writes].map((k) => `"${k}"`).join(', ')}, mas o site (${others.join(', ')}) lê ${[...reads].map((k) => `"${k}"`).join(', ')}: o que se edita no painel não aparece no site`);
  }
  return out;
}

/** Imagem enviada pelo usuário: reduz para no máximo 1600px e vira um arquivo do projeto (assets/…). */
export async function imageToAsset(file: File): Promise<{ name: string; dataUrl: string; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  const png = /png|svg|gif/.test(file.type) && file.size < 400_000;
  const dataUrl = canvas.toDataURL(png ? 'image/png' : 'image/jpeg', 0.86);
  const base = file.name.replace(/\.[^.]+$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'imagem';
  return { name: `assets/${base}.${png ? 'png' : 'jpg'}`, dataUrl, w, h };
}

/** Conteúdo enviado à IA: imagens do usuário viram uma descrição curta (não o arquivo inteiro). */
const FN_RE = /(?:\bfunction\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>))/g;
const fnNames = (src: string) => new Set([...src.matchAll(FN_RE)].map((m) => (m[1] ?? m[2])!));

/** Proteção contra regressão: funções que existiam antes de uma edição e sumiram dos arquivos JS.
 *  Sinaliza quando a função ainda é chamada em algum lugar (vai quebrar) ou quando sumiram 3 ou mais (funcionalidade perdida). */
export function lostFunctions(before: Record<string, string | null>, files: Record<string, string>): string[] {
  const out: string[] = [];
  const all = Object.entries(files).filter(([n]) => /\.(m?js|html)$/.test(n)).map(([, c]) => c).join('\n');
  for (const [name, old] of Object.entries(before)) {
    if (!old || !/\.m?js$/.test(name) || !(name in files)) continue;
    const now = fnNames(files[name]!);
    const gone = [...fnNames(old)].filter((f) => !f.includes("$") && !now.has(f) && !new RegExp(`\\b(?:function\\s+${f}\\b|${f}\\s*=)`).test(all));
    const called = gone.filter((f) => new RegExp(`\\b${f}\\s*\\(`).test(all));
    if (called.length || gone.length >= 3) out.push(`${name}: a última alteração removeu ${gone.join(', ')}${called.length ? ` (${called.join(', ')} ainda é chamada e vai dar erro)` : ''} — restaure essas funcionalidades mantendo a mudança pedida`);
  }
  return out;
}

/** Arquivos que vão para a IA. Com `focus`, só esses vão completos; os demais vão resumidos
 *  (a cota grátis por minuto soma entrada + saída: mandar tudo deixa pouco espaço para a resposta). */
export function filesForAi(files: Record<string, string>, focus?: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, c] of Object.entries(files)) {
    if (c.startsWith('data:')) out[n] = `[imagem enviada pelo usuário — use como src="${n}"]`;
    else if (focus?.length && !focus.includes(n) && c.length > 1200) {
      const decl = [...new Set([...c.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]))].slice(0, 25);
      out[n] = `[arquivo existente, ${c.split('\n').length} linhas, está correto: NÃO reenvie${decl.length ? `; declara: ${decl.join(', ')}` : ''}]`;
    } else out[n] = c;
  }
  return out;
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
    const b64 = /^data:[^;,]+;base64,/.exec(content);
    const data = b64 ? Uint8Array.from(atob(content.slice(b64[0].length)), (ch) => ch.charCodeAt(0)) : enc.encode(content);
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

/** Instruções usadas quando a Lume Code roda no modelo local do PC (sem a nuvem). */
export const LOCAL_CODE_PROMPT = `Você é a Lume Code. Crie/altere um site completo. Entregue cada arquivo INTEIRO num bloco cuja primeira linha é "\`\`\`lang nome-do-arquivo" (ex.: \`\`\`html index.html, \`\`\`css styles.css, \`\`\`js script.js). index.html referencia os outros por caminho relativo. Sem build. Design moderno, responsivo e acessível, textos em português. Explique em 1–2 frases antes dos arquivos.`;
