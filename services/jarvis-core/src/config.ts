import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const CORE_VERSION = '0.2.8';

function defaultDataDir(): string {
  if (process.env.JARVIS_DATA_DIR) return path.resolve(process.env.JARVIS_DATA_DIR);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'JarvisUltra');
  }
  return path.join(os.homedir(), '.jarvis-ultra');
}

export type CoreConfig = {
  dataDir: string;
  dbPath: string;
  logDir: string;
  labDir: string;
  pluginsDir: string;
  backupsDir: string;
  host: string;
  port: number;
  ollamaUrl: string;
  /** Diretório da UI estática (apps/web/out) para servir em http://127.0.0.1:porta. */
  uiDir: string | null;
};

export function loadConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  const dataDir = overrides.dataDir ?? defaultDataDir();
  const cfg: CoreConfig = {
    dataDir,
    dbPath: path.join(dataDir, 'jarvis.db'),
    logDir: path.join(dataDir, 'logs'),
    labDir: path.join(dataDir, 'lab'),
    pluginsDir: path.join(dataDir, 'plugins'),
    backupsDir: path.join(dataDir, 'backups'),
    // Somente loopback: o core nunca escuta em interfaces externas.
    host: '127.0.0.1',
    port: Number(process.env.JARVIS_PORT ?? 7821),
    ollamaUrl: process.env.OLLAMA_HOST ? normalizeOllama(process.env.OLLAMA_HOST) : 'http://127.0.0.1:11434',
    uiDir: process.env.JARVIS_UI_DIR ?? null,
    ...overrides,
  };
  for (const d of [cfg.dataDir, cfg.logDir, cfg.labDir, cfg.pluginsDir, cfg.backupsDir]) fs.mkdirSync(d, { recursive: true });
  return cfg;
}

function normalizeOllama(v: string): string {
  const withProto = /^https?:\/\//.test(v) ? v : `http://${v}`;
  return withProto.replace(/\/+$/, '');
}
