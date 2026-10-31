import fs from 'node:fs';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';
export type LogEntry = { ts: string; level: Level; scope: string; msg: string; data?: unknown };

const RING_SIZE = 500;
const ring: LogEntry[] = [];
let stream: fs.WriteStream | null = null;
const listeners = new Set<(e: LogEntry) => void>();

export function initLogFile(logDir: string) {
  const file = path.join(logDir, `core-${new Date().toISOString().slice(0, 10)}.log`);
  stream = fs.createWriteStream(file, { flags: 'a' });
}

export function onLog(fn: (e: LogEntry) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function recentLogs(limit = 200): LogEntry[] {
  return ring.slice(-limit);
}

function write(level: Level, scope: string, msg: string, data?: unknown) {
  const entry: LogEntry = { ts: new Date().toISOString(), level, scope, msg, ...(data === undefined ? {} : { data: redact(data) }) };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  const line = JSON.stringify(entry);
  stream?.write(line + '\n');
  if (process.env.JARVIS_QUIET !== '1' && (level !== 'debug' || process.env.JARVIS_DEBUG)) {
    (level === 'error' ? console.error : console.log)(`[${entry.ts.slice(11, 19)}] ${level.toUpperCase().padEnd(5)} ${scope}: ${msg}`);
  }
  for (const l of listeners) l(entry);
}

/** Remove campos com nomes sensíveis antes de registrar. */
function redact(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = /secret|token|password|authorization|apikey|api_key/i.test(k) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

export const logger = (scope: string) => ({
  debug: (m: string, d?: unknown) => write('debug', scope, m, d),
  info: (m: string, d?: unknown) => write('info', scope, m, d),
  warn: (m: string, d?: unknown) => write('warn', scope, m, d),
  error: (m: string, d?: unknown) => write('error', scope, m, d),
});
