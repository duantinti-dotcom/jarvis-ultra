'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, CornerDownLeft, MessageSquare, Zap } from 'lucide-react';
import { useJarvis } from '@/lib/store';
import { useChat } from '@/lib/chat';
import type { ConversationSummary } from '@/lib/types';
import { VIEWS } from './Shell';
import { cx } from './ui';

type Item = { id: string; label: string; hint?: string; group: string; icon?: React.ReactNode; run: () => void };

/** Paleta de comandos e busca global (Ctrl+K): telas, ações e conversas. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { api, notify } = useJarvis();
  const chat = useChat();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [hits, setHits] = useState<{ conversationId: string; conversationTitle: string; content: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); api.conversations().then(setConvs).catch(() => {}); }, [api]);
  useEffect(() => {
    if (q.trim().length < 3 || api.mode !== 'local') return setHits([]);
    const t = setTimeout(() => api.req<{ conversationId: string; conversationTitle: string; content: string }[]>(`/api/conversations/search?q=${encodeURIComponent(q)}`).then((r) => setHits(r.slice(0, 6))).catch(() => {}), 180);
    return () => clearTimeout(t);
  }, [q, api]);

  const go = (hash: string) => () => { location.hash = hash; onClose(); };
  const items = useMemo<Item[]>(() => {
    const base: Item[] = [
      { id: 'new', label: 'Nova conversa', hint: 'Ctrl Shift O', group: 'Ações', icon: <MessageSquare className="size-4" />, run: () => { void chat.open(null); go('#/chat')(); } },
      { id: 'voice', label: 'Falar com Lume', hint: 'Ctrl Shift V', group: 'Ações', icon: <Zap className="size-4" />, run: go('#/voice?auto=1') },
      { id: 'm-fast', label: 'Modo de raciocínio: Rápido', group: 'Ações', run: () => { chat.setMode('fast'); notify('ok', 'Modo Rápido'); onClose(); } },
      { id: 'm-bal', label: 'Modo de raciocínio: Equilibrado', group: 'Ações', run: () => { chat.setMode('balanced'); notify('ok', 'Modo Equilibrado'); onClose(); } },
      { id: 'm-deep', label: 'Modo de raciocínio: Profundo', group: 'Ações', run: () => { chat.setMode('deep'); notify('ok', 'Modo Profundo'); onClose(); } },
      { id: 'stop', label: 'Parada de emergência', group: 'Ações', run: () => { void api.emergencyStop(); onClose(); } },
      ...VIEWS.map((v) => ({ id: `v-${v.id}`, label: v.label, hint: v.hint, group: 'Ir para', icon: <v.icon className="size-4" />, run: go(`#/${v.id}`) })),
      ...convs.slice(0, 40).map((c) => ({ id: `c-${c.id}`, label: c.title, hint: c.pinned ? 'fixada' : undefined, group: 'Conversas', icon: <MessageSquare className="size-4" />, run: () => { void chat.open(c.id); go('#/chat')(); } })),
      ...hits.map((h, i) => ({ id: `h-${i}`, label: h.conversationTitle, hint: h.content.slice(0, 80), group: 'Encontrado nas mensagens', run: () => { void chat.open(h.conversationId); go('#/chat')(); } })),
    ];
    const n = q.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (!n) return base.filter((i) => i.group !== 'Conversas' || base.indexOf(i) < 22);
    return base.filter((i) => i.group === 'Encontrado nas mensagens' || (i.label + ' ' + (i.hint ?? '')).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(n));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, convs, hits, chat]);
  useEffect(() => setSel(0), [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    if (e.key === 'Enter') items[sel]?.run();
  };
  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm grid place-items-start pt-[12vh] px-3" onClick={onClose}>
      <div role="dialog" aria-label="Paleta de comandos" className="w-full max-w-xl mx-auto surface-raised rounded-2xl overflow-hidden animate-fade-up" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="flex items-center gap-2 px-4 h-12 border-b border-line">
          <Search className="size-4 text-dim" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar conversas, telas e ações…" className="flex-1 bg-transparent outline-none text-[14px] placeholder:text-dim" aria-label="Buscar" />
          <kbd className="font-mono text-[10px] text-dim border border-line rounded px-1">Esc</kbd>
        </div>
        <ul className="max-h-[52vh] overflow-y-auto scroll-thin p-1.5" role="listbox">
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? (lastGroup = it.group) : null;
            return (
              <li key={it.id}>
                {header && <div className="px-2.5 pt-2.5 pb-1 label-tech">{header}</div>}
                <button role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={it.run}
                  className={cx('w-full flex items-center gap-2.5 rounded-lg px-2.5 h-9 text-left text-[13px]', i === sel ? 'bg-accent/[0.12] text-fg' : 'text-muted')}>
                  <span className="text-dim">{it.icon}</span>
                  <span className="truncate">{it.label}</span>
                  {it.hint && <span className="ml-auto pl-3 truncate text-[11px] text-dim max-w-[45%]">{it.hint}</span>}
                  {i === sel && <CornerDownLeft className="size-3.5 text-dim shrink-0" />}
                </button>
              </li>
            );
          })}
          {!items.length && <li className="px-3 py-6 text-center text-[13px] text-dim">Nada encontrado.</li>}
        </ul>
      </div>
    </div>
  );
}
