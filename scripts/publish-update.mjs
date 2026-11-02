#!/usr/bin/env node
// Publica uma versão para a atualização automática do app (servida pelo site na Vercel).
// Uso: node scripts/publish-update.mjs --version 0.2.8 --exe <instalador.exe> --sig <instalador.exe.sig> --notes "..."
// Gera updates/latest.json + updates/JARVIS-ULTRA_<versão>_x64-setup.exe (remove instaladores antigos).
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const { version, exe, sig, notes = '' } = args;
if (!version || !exe || !sig) { console.error('uso: --version X --exe arquivo.exe --sig arquivo.exe.sig [--notes texto]'); process.exit(1); }
const SITE = process.env.UPDATE_SITE ?? 'https://jarvis-ultra-iota.vercel.app';
const dir = path.resolve('updates');
fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(dir)) if (f.endsWith('.exe')) fs.rmSync(path.join(dir, f));
const name = `JARVIS-ULTRA_${version}_x64-setup.exe`;
fs.copyFileSync(exe, path.join(dir, name));
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: { 'windows-x86_64': { signature: fs.readFileSync(sig, 'utf8').trim(), url: `${SITE}/updates/${name}` } },
};
fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`publicado ${name} (${(fs.statSync(path.join(dir, name)).size / 1e6).toFixed(1)} MB) em updates/`);
