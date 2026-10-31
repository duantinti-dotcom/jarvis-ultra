// Gera dist/jarvis-core.mjs (bundle único) + dependências que não podem ser empacotadas.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const dist = path.join(root, '..', 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, '..', 'src', 'main.ts')],
  outfile: path.join(dist, 'jarvis-core.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  sourcemap: 'linked',
  legalComments: 'none',
  // playwright-core resolve arquivos próprios em tempo de execução: vai como pasta.
  external: ['playwright-core', 'node:sqlite'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

// Copia playwright-core (sem navegadores: o JARVIS usa o Edge/Chrome já instalado).
const pw = path.dirname(require.resolve('playwright-core/package.json'));
fs.cpSync(fs.realpathSync(pw), path.join(dist, 'node_modules', 'playwright-core'), { recursive: true, dereference: true });
fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ name: 'jarvis-core-dist', type: 'module', private: true }));
const size = (p) => fs.statSync(p).size;
console.log(`core: ${(size(path.join(dist, 'jarvis-core.mjs')) / 1e6).toFixed(1)} MB`);
