'use client';
import { useEffect, useState } from 'react';
import { Search, MessageSquare, Pin, ListChecks } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { useChat } from '@/lib/chat';
import { Input, cx, fmtAgo, Empty } from '@/components/ui';
import { TasksView } from './Tasks';

export function HistoryView() {
  const { api, refreshTick } = useJarvis();
  const chat = useChat();
  const [tab, setTab] = useState<'conversas' | 'tarefas'>('conversas');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ conversationId: string; conversationTitle: string; content: string; createdAt: string }[] | null>(null);
  const list = useAsync(() => api.conversations(), [api, refreshTick]);
  useEffect(() => {
    if (q.trim().length < 2 || api.mode !== 'local') return setHits(null);
    const t = setTimeout(() => api.req<typeof hits>(`/api/conversations/search?q=${encodeURIComponent(q)}`).then(setHits).catch(() => setHits([])), 200);
    return () => clearTimeout(t);
  }, [q, api]);
  const open = async (id: string) => { await chat.open(id); location.hash = '#/chat'; };
  const items = (list.data ?? []).filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="p-4 sm:p-6 max-w-[1200px] mx-auto">
      <div className="flex items-center gap-1 mb-4">
        {(['conversas', 'tarefas'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cx('press flex items-center gap-1.5 px-3 h-8 rounded-lg text-[13px] capitalize', tab === t ? 'bg-white/[0.07] text-fg' : 'text-dim hover:text-muted')}>{t === 'conversas' ? <MessageSquare className="size-3.5" /> : <ListChecks className="size-3.5" />}{t}</button>
        ))}
      </div>
      {tab === 'tarefas' ? <div className="-m-4 sm:-m-6"><TasksView /></div> : (
        <>
          <div className="relative max-w-xl">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-dim" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pesquisar títulos e o conteúdo de todas as conversas…" className="pl-9" aria-label="Pesquisar histórico" />
          </div>
          {hits && (
            <section className="mt-4">
              <div className="label-tech mb-2">Encontrado nas mensagens ({hits.length})</div>
              <ul className="space-y-1.5">{hits.map((h, i) => <li key={i}><button onClick={() => open(h.conversationId)} className="w-full text-left surface rounded-xl px-3.5 py-2.5 hover:border-orange/30"><div className="text-[13px] font-medium truncate">{h.conversationTitle}</div><div className="text-[12px] text-muted line-clamp-2">{h.content}</div><div className="text-[10.5px] text-dim mt-0.5">{fmtAgo(h.createdAt)}</div></button></li>)}</ul>
            </section>
          )}
          <section className="mt-5">
            <div className="label-tech mb-2">Conversas ({items.length})</div>
            {!items.length ? <Empty icon={<MessageSquare className="size-7" />} title="Nenhuma conversa">Suas conversas com o Jarvis aparecem aqui.</Empty> : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {items.map((c) => (
                  <li key={c.id}>
                    <button onClick={() => open(c.id)} className="press w-full text-left surface rounded-xl px-3.5 py-3 hover:border-orange/30">
                      <div className="flex items-center gap-2">{c.pinned && <Pin className="size-3 text-orange-soft" />}<span className="text-[13px] font-medium truncate">{c.title}</span></div>
                      <div className="text-[11px] text-dim mt-0.5">{fmtAgo(c.updatedAt)} · {c.messageCount ?? 0} mensagens{c.origin === 'remote' ? ' · pelo celular' : ''}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
