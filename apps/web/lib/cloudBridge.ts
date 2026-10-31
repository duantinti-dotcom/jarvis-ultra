'use client';
import type { CoreEvent, JarvisApi } from './types';
import { Emitter } from './events';
import { cloudChat, cloudCancel, cloudConversation, cloudTruncate } from './cloud';
import { supabase, remoteConfigured } from './remote';
import { usernameToEmail } from '@/components/Boot';

/**
 * Ponte para a IA da nuvem também no app do PC: o Jarvis Code usa a mesma IA do site
 * (que cria sites de verdade) em vez do modelo pequeno instalado no computador.
 */
let bridge: JarvisApi | null = null;
export function cloudBridge(): JarvisApi {
  if (bridge) return bridge;
  const ev = new Emitter<[CoreEvent]>();
  const part: Pick<JarvisApi, 'mode' | 'cloud' | 'subscribe' | 'chat' | 'cancelMessage' | 'conversation' | 'truncate'> = {
    conversation: cloudConversation,
    truncate: cloudTruncate,
    mode: 'remote', cloud: true,
    subscribe: (fn) => ev.on(fn),
    chat: (text, cid, opts) => cloudChat(text, cid, opts?.mode, (e) => ev.emit(e), opts?.code, opts?.voice),
    cancelMessage: async (id) => cloudCancel(id),
  };
  bridge = part as JarvisApi;
  return bridge;
}

export async function hasCloudSession(): Promise<boolean> {
  if (!remoteConfigured()) return false;
  try { return !!(await supabase().auth.getSession()).data.session; } catch { return false; }
}

export async function cloudLogin(username: string, password: string) {
  const r = await supabase().auth.signInWithPassword({ email: usernameToEmail(username), password });
  if (r.error) throw new Error(/invalid login/i.test(r.error.message) ? 'Usuário ou senha incorretos.' : r.error.message);
}

/** App do PC: pedidos que mexem no computador vão para o PC; o resto vai para a nuvem (rápida). */
export const PC_RE = /\b(abr[aei]r?|abre|feche|fechar|execut\w*|rode|rodar|inici[ae]r?|pasta|pastas|arquivo|arquivos|aplicativo|programa|janela|tela|print|captura|clique|clicar|digit\w*|deslig\w*|reinici\w*|volume|instal\w*|meu (pc|computador|notebook)|no (pc|computador)|desktop|área de trabalho|documentos|downloads|lembre|lembra|lembrete|memória|organiz\w*|planilha|word|excel|chrome|navegador)\b/i;
