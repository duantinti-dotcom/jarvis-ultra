import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { powershell } from '../util/proc.js';

/**
 * Protege o segredo do dispositivo em repouso. No Windows usa DPAPI (vinculado
 * ao usuário do Windows). Em outros sistemas usa AES-256-GCM com chave local
 * em arquivo com permissão 0600.
 */
export async function protect(plain: string, dataDir: string): Promise<string> {
  if (process.platform === 'win32') {
    const b64 = Buffer.from(plain, 'utf8').toString('base64');
    const r = await powershell(`Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('${b64}'), $null, 'CurrentUser'))`);
    if (r.code === 0 && r.stdout.trim()) return `dpapi:${r.stdout.trim()}`;
  }
  const key = localKey(dataDir);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `aes:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

export async function unprotect(stored: string, dataDir: string): Promise<string> {
  if (stored.startsWith('dpapi:')) {
    const r = await powershell(`Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${stored.slice(6)}'), $null, 'CurrentUser'))`);
    if (r.code !== 0) throw new Error('Falha ao descriptografar a credencial do dispositivo (DPAPI).');
    return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
  }
  if (stored.startsWith('aes:')) {
    const raw = Buffer.from(stored.slice(4), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', localKey(dataDir), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }
  throw new Error('Formato de credencial desconhecido.');
}

function localKey(dataDir: string) {
  const f = path.join(dataDir, '.device-key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32), { mode: 0o600 });
  return fs.readFileSync(f);
}
