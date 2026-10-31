import type { Db } from '../db/index.js';
import { protect, unprotect } from '../relay/secret.js';

/**
 * Cofre de credenciais (chaves de API). No Windows usa DPAPI (ligado ao usuário
 * do Windows); nos demais sistemas, AES-256-GCM com chave local. O valor nunca
 * sai do core: a API só informa se a credencial existe.
 */
export class Credentials {
  constructor(private db: Db, private dataDir: string) {}

  static readonly ALLOWED = ['elevenlabs.apiKey'] as const;

  async set(name: string, value: string) {
    if (!(Credentials.ALLOWED as readonly string[]).includes(name)) throw new Error('Credencial desconhecida.');
    if (!value.trim()) throw new Error('Valor vazio.');
    this.db.setSetting(`cred.${name}`, { value: await protect(value.trim(), this.dataDir), updatedAt: new Date().toISOString() });
  }

  async get(name: string): Promise<string | null> {
    const row = this.db.getSetting<{ value: string } | null>(`cred.${name}`, null);
    return row ? unprotect(row.value, this.dataDir) : null;
  }

  remove(name: string) {
    this.db.setSetting(`cred.${name}`, null);
  }

  status() {
    return Credentials.ALLOWED.map((name) => {
      const row = this.db.getSetting<{ value: string; updatedAt: string } | null>(`cred.${name}`, null);
      return { name, configured: !!row, protection: row ? (row.value.startsWith('dpapi:') ? 'Windows DPAPI' : 'AES-256-GCM local') : null, updatedAt: row?.updatedAt ?? null };
    });
  }
}
