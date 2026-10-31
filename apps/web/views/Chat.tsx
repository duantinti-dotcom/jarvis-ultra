'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search, Paperclip, ArrowUp, Square, Volume2, Wrench, CheckCircle2, XCircle, Loader2, Trash2, MessageSquare } from 'lucide-react';
import { useJarvis, useAsync, type LiveMessage } from '@/lib/store';
import { Markdown } from '@/components/Markdown';
import { Button, Input, cx, fmtAgo, Empty } from '@/components/ui';
import { speakable, ptVoices } from '@/lib/voice';

export function ChatView() {
  const { api, chat, notify } = useJarvis();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [uploading, setUploading] = useState(false);
  const list = useAsync(() => api.conversations(), [api, chat.reloadList]);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [chat.messages]);

  const filtered = useMemo(() => (list.data ?? []).filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase())), [list.data, q]);

  const send = async () => {
    const t = text.trim();
    if (!t || chat.busy) return;
    setText('');
    await chat.send(t);
  };

  const attach = async (f: File) => {
    setUploading(true);
    try {
      if (api.mode === 'local') {
        const r = await fetch(`${api.coreUrl}/api/files/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { authorization: `Bearer ${api.token}` }, body: f });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setText((t) => `${t}${t ? '\n' : ''}[Arquivo anexado: ${j.path}]\n`);
      } else {
        if (f.size > 200_000 || !/^text\/|json|csv|xml/.test(f.type || 'text/plain')) throw new Error('Pelo site, anexe apenas arquivos de texto até 200 KB.');
        const body = (await f.text()).slice(0, 200_000);
        setText((t) => `${t}${t ? '\n' : ''}Conteúdo do arquivo ${f.name}:\n"""\n${body}\n"""\n`);
      }
    } catch (e) {
      notify('err', (e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id: string) => {
    if (api.mode !== 'local') return;
    await api.req(`/api/conversations/${id}`, { method: 'DELETE' });
    if (chat.conversationId === id) await chat.open(null);
    void list.reload();
  };

  return (
    <div className="h-full flex">
      <aside className="hidden md:flex w-[260px] shrink-0 flex-col border-r border-line bg-black/10">
        <div className="p-3 space-y-2">
          <Button variant="primary" className="w-full" icon={<Plus className="size-4" />} onClick={() => chat.open(null)}>Nova conversa</Button>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-dim" />
            <Input placeholder="Buscar conversas" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8 h-9" aria-label="Buscar conversas" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin px-2 pb-3 space-y-0.5">
          {filtered.map((c) => (
            <div key={c.id} className={cx('group flex items-center rounded-xl', chat.conversationId === c.id ? 'bg-orange/[0.1]' : 'hover:bg-white/[0.04]')}>
              <button onClick={() => chat.open(c.id)} className="flex-1 min-w-0 text-left px-3 py-2">
                <div className="text-[12.5px] truncate">{c.title}</div>
                <div className="text-[10.5px] text-dim">{fmtAgo(c.updatedAt)}{c.origin === 'remote' ? ' · remoto' : ''}</div>
              </button>
              {api.mode === 'local' && <button aria-label="Excluir conversa" onClick={() => remove(c.id)} className="opacity-0 group-hover:opacity-100 p-2 text-dim hover:text-err"><Trash2 className="size-3.5" /></button>}
            </div>
          ))}
          {!filtered.length && <p className="px-3 py-4 text-[12px] text-dim">Sem conversas.</p>}
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="max-w-3xl mx-auto px-3 sm:px-6 py-6 space-y-5">
            {!chat.messages.length && <Empty icon={<MessageSquare className="size-8" />} title="Converse com o JARVIS">Pergunte, peça análises ou ações no computador. Ações de risco pedem sua aprovação.</Empty>}
            {chat.messages.map((m) => <Message key={m.id} m={m} />)}
            <div ref={endRef} />
          </div>
        </div>
        <div className="border-t border-line bg-black/20 p-3">
          <div className="max-w-3xl mx-auto glass rounded-2xl flex items-end gap-1 p-1.5">
            <input ref={fileRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(f); e.target.value = ''; }} />
            <button aria-label="Anexar arquivo" onClick={() => fileRef.current?.click()} className="grid place-items-center size-10 rounded-xl text-muted hover:text-fg hover:bg-white/5">
              {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
            </button>
            <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Mensagem para o JARVIS…" aria-label="Mensagem"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              className="flex-1 max-h-48 min-h-10 resize-none bg-transparent px-2 py-2.5 text-[14px] outline-none placeholder:text-dim field-sizing-content" />
            {chat.busy ? (
              <button aria-label="Parar" onClick={chat.cancel} className="grid place-items-center size-10 rounded-xl bg-white/10 hover:bg-white/15"><Square className="size-4" /></button>
            ) : (
              <button aria-label="Enviar" onClick={send} disabled={!text.trim()} className="grid place-items-center size-10 rounded-xl bg-orange text-black disabled:opacity-30 hover:bg-orange-glow"><ArrowUp className="size-5" /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Message({ m }: { m: LiveMessage }) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end animate-fade-up">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-orange/[0.12] border border-orange/20 px-4 py-2.5 text-[14px] whitespace-pre-wrap break-words">{m.content}</div>
      </div>
    );
  }
  const metrics = m.metrics as { model?: string; timeToFirstTokenMs?: number | null; tokensPerSecond?: number | null; totalMs?: number; toolCalls?: number } | null;
  return (
    <div className="animate-fade-up">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="size-5 rounded-full bg-gradient-to-br from-orange to-orange-soft shadow-[0_0_12px_#ff6a00]" />
        <span className="font-display text-[12.5px] font-semibold tracking-wider">JARVIS</span>
        {m.streaming && <Loader2 className="size-3.5 animate-spin text-orange" />}
      </div>
      {!!m.tools?.length && (
        <div className="mb-2 space-y-1">
          {m.tools.map((t) => (
            <div key={t.callId} className="flex items-center gap-2 rounded-lg border border-line bg-black/25 px-2.5 py-1.5 text-[12px]">
              {t.running ? <Loader2 className="size-3.5 animate-spin text-orange" /> : t.ok ? <CheckCircle2 className="size-3.5 text-ok" /> : <XCircle className="size-3.5 text-err" />}
              <Wrench className="size-3 text-dim" />
              <span className="font-mono text-orange-soft">{t.tool}</span>
              <span className="truncate text-muted">{t.running ? JSON.stringify(t.args ?? {}).slice(0, 90) : t.summary}</span>
              {t.durationMs != null && <span className="ml-auto text-dim tabular-nums">{t.durationMs} ms</span>}
            </div>
          ))}
        </div>
      )}
      {m.content && <Markdown text={m.content} />}
      {m.error && <div className="mt-1 rounded-xl border border-err/30 bg-err/[0.07] px-3 py-2 text-[13px] text-err">⚠️ {m.error}</div>}
      {!m.streaming && metrics?.model && (
        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[10.5px] font-mono text-dim">
          <span>{metrics.model.replace(/:latest$/, '')}</span>
          {metrics.timeToFirstTokenMs != null && <span>TTFT {metrics.timeToFirstTokenMs} ms</span>}
          {metrics.tokensPerSecond != null && <span>{metrics.tokensPerSecond} tok/s</span>}
          {metrics.totalMs != null && <span>total {(metrics.totalMs / 1000).toFixed(1)} s</span>}
          {!!metrics.toolCalls && <span>{metrics.toolCalls} ferramentas</span>}
          <button aria-label="Ouvir resposta" className="hover:text-fg" onClick={() => { const u = new SpeechSynthesisUtterance(speakable(m.content)); u.lang = 'pt-BR'; const v = ptVoices()[0]; if (v) u.voice = v; speechSynthesis.cancel(); speechSynthesis.speak(u); }}>
            <Volume2 className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
