// Copia o Monaco Editor para public/monaco: o editor funciona offline no app desktop
// e sem depender de CDN (a CSP do core só permite scripts da própria origem).
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const src = path.join(here, '..', 'node_modules', 'monaco-editor', 'min', 'vs');
const dest = path.join(here, '..', 'public', 'monaco', 'vs');
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(fs.realpathSync(src), dest, { recursive: true, filter: (p) => !/\.map$/.test(p) && !/[\\/]nls\.messages\.(?!pt-br)[a-z-]+\.js$/.test(p) });
console.log('monaco copiado para', dest);
