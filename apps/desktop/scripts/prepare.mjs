// Prepara os recursos do app desktop: core empacotado, UI estática e node.exe oficial.
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..', '..', '..');
const tauri = path.resolve(here, '..', 'src-tauri');
const target = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : 'x86_64-pc-windows-msvc';
const NODE_VERSION = process.env.JARVIS_NODE_VERSION ?? '22.22.0';
const sh = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });

console.log('› core');
sh('node scripts/build.mjs', path.join(root, 'services', 'jarvis-core'));
console.log('› interface');
sh('pnpm --filter @jarvis/web build');

const res = path.join(tauri, 'resources');
fs.rmSync(res, { recursive: true, force: true });
fs.cpSync(path.join(root, 'services', 'jarvis-core', 'dist'), path.join(res, 'core'), { recursive: true, filter: (p) => !p.endsWith('.map') });
fs.cpSync(path.join(root, 'apps', 'web', 'out'), path.join(res, 'ui'), { recursive: true });

console.log(`› node.exe ${NODE_VERSION} (${target})`);
const bin = path.join(tauri, 'binaries', `node-${target}.exe`);
if (!fs.existsSync(bin)) {
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((l) => l.endsWith(' win-x64/node.exe'))?.split(/\s+/)[0];
  const buf = Buffer.from(await (await fetch(`${base}/win-x64/node.exe`)).arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (!expected || got !== expected) throw new Error(`SHA-256 do node.exe não confere (esperado ${expected}, obtido ${got})`);
  fs.writeFileSync(bin, buf);
  console.log(`  verificado sha256 ${got.slice(0, 16)}…`);
}
console.log('recursos prontos em', res);
