'use client';
import type { CoreEvent, JarvisApi } from './types';
import { Emitter } from './events';
import { cloudChat, cloudCancel, cloudConversation, cloudTruncate } from './cloud';
import { supabase, remoteConfigured } from './remote';
import { usernameToEmail } from '@/components/Boot';

/**
 * Ponte para a IA da nuvem também no app do PC: a Lume Code usa a mesma IA do site
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
    chat: (text, cid, opts) => cloudChat(text, cid, opts?.mode, (e) => ev.emit(e), opts?.code, opts?.voice, true),
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

/**
 * App do PC: só COMANDOS de ação no computador vão para o PC ("abra o Chrome", "organize meus downloads").
 * Perguntas e conversa — mesmo citando o PC ("você consegue mexer no meu pc?") — vão para a nuvem rápida.
 */
const PC_VERB = /\b(abr[ae]|abrir|feche|fechar|execut[ae]r?|rode|rodar|inici[ae]r?|liste|listar|mostr[ae]r?|organiz[ae]r?|mova|mover|copie|copiar|renomei[ae]|renomear|apague|apagar|delete|deletar|exclua|excluir|crie (uma |a )?pasta|tire (um |uma )?(print|captura)|captur[ae]r? a tela|digit[ae]r?|clique|clicar|deslig[ae]r?|reinici[ae]r?|aument[ae]r?|diminu[ai]r?|instal[ae]r?|procur[ae]r?|encontr[ae]r?|limp[ae]r?|lembre-me|me lembre|anot[ae]r?)\b/i;
const PC_OBJ = /\b(pc|computador|notebook|arquivo|arquivos|pasta|pastas|downloads|documentos|área de trabalho|desktop|aplicativo|app|programa|janela|tela|chrome|navegador|word|excel|bloco de notas|spotify|discord|steam|volume|lixeira|lembrete)\b/i;
const QUESTION = /^\s*(como|o que|qual|quais|por que|porque)\b/i;
export function isPcAction(t: string) {
  const x = t.trim();
  if (QUESTION.test(x)) return false;
  return PC_VERB.test(x) && PC_OBJ.test(x);
}
/** @deprecated use isPcAction */
export const PC_RE = { test: isPcAction };
