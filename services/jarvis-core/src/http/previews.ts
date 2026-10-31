import crypto from 'node:crypto';

/**
 * Previews do Jarvis Code no app do PC. Cada preview recebe um id aleatório
 * (capacidade) e é servido com CSP "sandbox": origem opaca, sem acesso ao token
 * nem à API local, mas livre para carregar fontes/CDNs como um site de verdade.
 */
const store = new Map<string, { html: string; at: number }>();

export function putPreview(html: string): string {
  const id = crypto.randomBytes(18).toString('base64url');
  store.set(id, { html, at: Date.now() });
  while (store.size > 30) store.delete(store.keys().next().value!);
  return id;
}

export function getPreview(id: string): string | null {
  return store.get(id)?.html ?? null;
}

export const PREVIEW_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src *; img-src * data: blob:; media-src * data: blob:; font-src * data:";
