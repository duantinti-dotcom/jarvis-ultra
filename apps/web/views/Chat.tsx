'use client';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search, Paperclip, ArrowUp, Square, Volume2, CheckCircle2, XCircle, Loader2, Trash2, Pin, PinOff, Copy, Check, RefreshCw, Pencil, Gauge, X, Code2, AudioLines, MonitorCog, FolderKanban } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { useChat, type LiveMessage, type Stage } from '@/lib/chat';
import { Markdown } from '@/components/Markdown';
import { ModeSelector, MODE_INFO } from '@/components/ModeSelector';
import { JarvisCore } from '@/components/JarvisCore';
import { Input, cx, fmtAgo } from '@/components/ui';
import { speakable, ptVoices } from '@/lib/voice';
import type { ConversationSummary } from '@/lib/types';

export function ChatView() {
  const { api, notify, refreshTick } = useJarvis();
  const chat = useChat();
  const [q, setQ] = useState('');
  const list = useAsync(() => api.conversations(), [api, refreshTick]);
  const endRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (location.hash.includes('new=1')) { history.replaceState(null, '', '#/chat'); void chat.open(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Rolagem automática só se o usuário estiver no fim (não "puxa" quem está lendo acima).
  useEffect(() => { if (stick.current) endRef.current?.scrollIntoView({ block: 'end' }); }, [chat.messages]);

  const filtered = useMemo(() => (list.data ?? []).filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase())), [list.data, q]);
  const pinned = filtered.filter((c) => c.pinned);
  const recent = filtered.filter((c) => !c.pinned);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await list.reload(); } catch (e) { notify('err', (e as Error).message); } };

  const lastAssistantId = [...chat.messages].reverse().find((m) => m.role === 'assistant')?.id;

  return (
    <div className="h-full flex">
      <aside className="hidden md:flex w-[248px] shrink-0 flex-col border-r border-line">
        <div className="p-3 space-y-2">
          <button onClick={() => chat.open(null)} className="press w-full flex items-center justify-center gap-2 rounded-lg h-9 text-[13px] font-medium bg-gradient-to-b from-orange to-[#e85d00] text-black hover:brightness-110">
            <Plus className="size-4" />Nova conversa
          </button>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-dim" />
            <Input placeholder="Filtrar conversas" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8 h-8 text-[12.5px]" aria-label="Filtrar conversas" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin px-2 pb-3">
          {pinned.length > 0 && <Group title="Fixadas" items={pinned} />}
          <Group title="Recentes" items={recent} />
          {!filtered.length && <p className="px-3 py-4 text-[12px] text-dim">{list.loading ? 'Carregando…' : 'Nenhuma conversa ainda.'}</p>}
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <div ref={scroller} className="flex-1 overflow-y-auto scroll-thin" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
          {!chat.messages.length ? <Home /> : (
            <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
              {chat.messages.map((m) => <Message key={m.id} m={m} canRegenerate={m.id === lastAssistantId && !chat.busy} />)}
              {chat.busy && !chat.messages.some((m) => m.streaming && m.content) && <StageLine stage={chat.stage} />}
              <div ref={endRef} />
            </div>
          )}
        </div>
        <Composer />
      </div>
    </div>
  );

  function Group({ title, items }: { title: string; items: ConversationSummary[] }) {
    if (!items.length) return null;
    return (
      <div className="mb-2">
        <div className="px-2.5 pt-2 pb-1 label-tech">{title}</div>
        {items.map((c) => (
          <div key={c.id} className={cx('group flex items-center rounded-lg', chat.conversationId === c.id ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]')}>
            <button onClick={() => chat.open(c.id)} className="flex-1 min-w-0 text-left px-2.5 py-1.5">
              <div className="text-[12.5px] truncate">{c.title}</div>
              <div className="text-[10.5px] text-dim">{fmtAgo(c.updatedAt)}{c.origin === 'remote' ? ' · celular' : ''}</div>
            </button>
            {api.mode === 'local' && (
              <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 flex pr-1">
                <button aria-label={c.pinned ? 'Desafixar' : 'Fixar'} onClick={() => act(() => api.req(`/api/conversations/${c.id}/pin`, { method: 'POST', json: { pinned: !c.pinned } }))} className="p-1.5 text-dim hover:text-orange-soft">{c.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}</button>
                <button aria-label="Excluir conversa" onClick={() => confirm('Excluir esta conversa?') && act(async () => { await api.req(`/api/conversations/${c.id}`, { method: 'DELETE' }); if (chat.conversationId === c.id) await chat.open(null); })} className="p-1.5 text-dim hover:text-err"><Trash2 className="size-3.5" /></button>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }
}

function Home() {
  const { status, visual, conn } = useJarvis();
  const chat = useChat();
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const tools = [
    { href: '#/code', icon: Code2, title: 'Jarvis Code', text: 'Programe num projeto do seu PC' },
    { href: '#/voice?auto=1', icon: AudioLines, title: 'Falar com Jarvis', text: 'Conversa por voz em tempo real' },
    { href: '#/desktop', icon: MonitorCog, title: 'Desktop Control', text: 'Tarefas reais no Windows' },
    { href: '#/files', icon: FolderKanban, title: 'Arquivos', text: 'Pastas liberadas e projetos' },
  ];
  const suggestions = ['Como está meu computador agora?', 'Quais arquivos mudaram hoje nas minhas pastas?', 'Crie uma planilha de tarefas da semana', 'Do que estávamos falando ontem?'];
  return (
    <div className="min-h-full flex flex-col items-center justify-center px-4 py-10">
      <JarvisCore state={conn === 'online' ? visual : 'offline'} size={168} />
      <h2 className="mt-2 font-display text-[26px] sm:text-[30px] font-semibold tracking-tight text-center">{greet}. <span className="accent-text">Como posso ajudar?</span></h2>
      <p className="mt-2 text-[13px] text-dim text-center">{status?.device?.model ? `Modelo local ${status.device.model.replace(/:latest$/, '')} · modo ${MODE_INFO[chat.mode].label}` : conn === 'online' ? 'Nenhum modelo instalado — veja Configurações → Modelos' : 'Conectando ao Jarvis…'}</p>
      <div className="mt-7 grid grid-cols-2 lg:grid-cols-4 gap-2.5 w-full max-w-3xl">
        {tools.map((t) => (
          <a key={t.title} href={t.href} className="press surface rounded-xl p-3.5 hover:border-orange/30 hover:bg-white/[0.03] group">
            <t.icon className="size-[18px] text-orange-glow" />
            <div className="mt-2.5 text-[13px] font-medium">{t.title}</div>
            <div className="text-[11.5px] text-dim mt-0.5">{t.text}</div>
          </a>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap justify-center gap-2 max-w-3xl">
        {suggestions.map((s) => <button key={s} onClick={() => chat.send(s)} className="press rounded-full border border-line px-3 h-8 text-[12px] text-muted hover:text-fg hover:border-orange/35">{s}</button>)}
      </div>
    </div>
  );
}

function StageLine({ stage }: { stage: Stage }) {
  const text = stage.kind === 'tool' ? `Usando ${stage.tool}` : stage.kind === 'writing' ? 'Escrevendo' : 'Pensando';
  return (
    <div className="flex items-center gap-2.5 text-[12.5px] text-muted animate-fade-up" role="status">
      <span className="size-5 rounded-full bg-gradient-to-br from-orange to-amber shadow-[0_0_14px_rgba(255,109,10,.7)] animate-pulse-soft" />
      <span className="font-medium text-fg/90">{text}</span>
      <span className="typing" aria-hidden><span /><span /><span /></span>
    </div>
  );
}

function Composer() {
  const { api, notify } = useJarvis();
  const chat = useChat();
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { taRef.current?.focus(); }, [chat.conversationId]);

  const send = async () => {
    if ((!text.trim() && !images.length) || chat.busy) return;
    const t = text, im = images;
    setText('');
    setImages([]);
    await chat.send(t, im.length ? im : undefined);
  };
  const attach = async (f: File) => {
    setUploading(true);
    try {
      if (f.type.startsWith('image/')) {
        if (f.size > 8_000_000) throw new Error('Imagem muito grande (máx. 8 MB).');
        const data = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });
        setImages((im) => [...im, data].slice(0, 4));
      } else if (api.mode === 'local') {
        const r = await fetch(`${api.coreUrl}/api/files/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { authorization: `Bearer ${api.token}` }, body: f });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setText((t) => `${t}${t ? '\n' : ''}[Arquivo anexado: ${j.path}]\n`);
      } else {
        if (f.size > 200_000) throw new Error('Pelo site, anexe arquivos de texto até 200 KB.');
        const body = (await f.text()).slice(0, 200_000);
        setText((t) => `${t}${t ? '\n' : ''}Conteúdo de ${f.name}:\n"""\n${body}\n"""\n`);
      }
    } catch (e) {
      notify('err', (e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  return (
    <div className="px-3 sm:px-6 pb-4 pt-2">
      <div className="max-w-3xl mx-auto surface-raised rounded-2xl focus-within:border-orange/35 transition-colors"
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void attach(f); }}>
        {images.length > 0 && (
          <div className="flex gap-2 px-3 pt-3">
            {images.map((src, i) => (
              <div key={i} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={`anexo ${i + 1}`} className="size-14 rounded-lg object-cover border border-line" />
                <button aria-label="Remover imagem" onClick={() => setImages((im) => im.filter((_, k) => k !== i))} className="absolute -top-1.5 -right-1.5 grid place-items-center size-5 rounded-full bg-raised border border-line"><X className="size-3" /></button>
              </div>
            ))}
          </div>
        )}
        <textarea ref={taRef} rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Mensagem para o Jarvis…" aria-label="Mensagem"
          onPaste={(e) => { const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); void attach(f); } }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          className="w-full max-h-56 min-h-12 resize-none bg-transparent px-4 pt-3 pb-1 text-[14.5px] outline-none focus-visible:outline-none placeholder:text-dim field-sizing-content" />
        <div className="flex items-center gap-2 px-2 pb-2">
          <input ref={fileRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(f); e.target.value = ''; }} />
          <button aria-label="Anexar arquivo ou imagem" title="Anexar arquivo ou imagem (ou arraste/cole)" onClick={() => fileRef.current?.click()} className="press grid place-items-center size-8 rounded-lg text-muted hover:text-fg hover:bg-white/5">
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
          </button>
          <ModeSelector value={chat.mode} onChange={chat.setMode} />
          <div className="ml-auto">
            {chat.busy ? (
              <button aria-label="Parar geração" title="Parar (Esc)" onClick={chat.cancel} className="press grid place-items-center size-9 rounded-xl bg-white/10 hover:bg-white/15"><Square className="size-3.5 fill-current" /></button>
            ) : (
              <button aria-label="Enviar" onClick={send} disabled={!text.trim() && !images.length} className="press grid place-items-center size-9 rounded-xl bg-gradient-to-b from-orange to-[#e85d00] text-black disabled:opacity-25"><ArrowUp className="size-[18px]" /></button>
            )}
          </div>
        </div>
      </div>
      <p className="max-w-3xl mx-auto mt-1.5 text-center text-[10.5px] text-dim">O Jarvis roda localmente no seu PC e verifica as ações que executa. Mesmo assim, confira informações importantes.</p>
    </div>
  );
}

const Message = memo(function Message({ m, canRegenerate }: { m: LiveMessage; canRegenerate: boolean }) {
  const chat = useChat();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [copied, setCopied] = useState(false);
  const [showTiming, setShowTiming] = useState(false);
  useEffect(() => {
    if (!m.streaming) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && chat.cancel();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [m.streaming, chat]);

  if (m.role === 'user') {
    return (
      <div className="group flex flex-col items-end animate-fade-up">
        {m.images?.length ? <div className="flex gap-2 mb-1.5">{m.images.map((src, i) => /* eslint-disable-next-line @next/next/no-img-element */ <img key={i} src={src} alt="imagem enviada" className="h-28 rounded-xl border border-line object-cover" />)}</div> : null}
        {editing ? (
          <div className="w-full max-w-[85%] surface rounded-2xl p-2">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="w-full bg-transparent outline-none text-[14px] p-2 min-h-16 field-sizing-content" autoFocus />
            <div className="flex gap-2 justify-end">
              <button className="press px-3 h-8 rounded-lg text-[12.5px] text-muted hover:text-fg" onClick={() => setEditing(false)}>Cancelar</button>
              <button className="press px-3 h-8 rounded-lg text-[12.5px] bg-orange text-black" onClick={() => { setEditing(false); if (m.seq) void chat.edit(m.seq, draft); }}>Enviar edição</button>
            </div>
          </div>
        ) : m.content ? (
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-white/[0.06] border border-line px-4 py-2.5 text-[14.5px] whitespace-pre-wrap break-words">{m.content}</div>
        ) : null}
        {!editing && m.seq && !chat.busy && (
          <button onClick={() => { setDraft(m.content); setEditing(true); }} className="mt-1 opacity-0 group-hover:opacity-100 focus:opacity-100 flex items-center gap-1 text-[11px] text-dim hover:text-fg"><Pencil className="size-3" />Editar</button>
        )}
      </div>
    );
  }
  const metrics = m.metrics;
  const timing = metrics?.timing;
  return (
    <div className="group animate-fade-up">
      <div className="flex items-center gap-2 mb-2">
        <span className="size-[18px] rounded-full bg-gradient-to-br from-orange to-amber shadow-[0_0_12px_rgba(255,109,10,.55)]" />
        <span className="font-display text-[12.5px] font-semibold tracking-wider">JARVIS</span>
        {metrics?.mode && <span className="text-[10.5px] text-dim">· {MODE_INFO[metrics.mode].label}</span>}
        {m.streaming && <Loader2 className="size-3.5 animate-spin text-orange" />}
      </div>
      {!!m.tools?.length && (
        <div className="mb-2.5 space-y-1">
          {m.tools.map((t) => (
            <div key={t.callId} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-[12px]">
              {t.running ? <Loader2 className="size-3.5 animate-spin text-orange" /> : t.ok ? <CheckCircle2 className="size-3.5 text-ok" /> : <XCircle className="size-3.5 text-err" />}
              <span className="font-mono text-orange-soft">{t.tool}</span>
              <span className="truncate text-muted">{t.running ? 'executando…' : t.summary}</span>
              {t.durationMs != null && <span className="ml-auto text-dim tabular-nums">{t.durationMs} ms</span>}
            </div>
          ))}
        </div>
      )}
      {m.content && <Markdown text={m.content} />}
      {m.error && <div className="mt-1 rounded-xl border border-err/30 bg-err/[0.07] px-3 py-2 text-[13px] text-err">{m.error}</div>}
      {!m.streaming && (m.content || m.error) && (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-dim">
          <IconBtn label={copied ? 'Copiado' : 'Copiar'} onClick={() => { void navigator.clipboard.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}</IconBtn>
          {canRegenerate && <IconBtn label="Regenerar resposta" onClick={() => chat.regenerate()}><RefreshCw className="size-3.5" /></IconBtn>}
          <IconBtn label="Ouvir" onClick={() => { const u = new SpeechSynthesisUtterance(speakable(m.content)); u.lang = 'pt-BR'; const v = ptVoices()[0]; if (v) u.voice = v; speechSynthesis.cancel(); speechSynthesis.speak(u); }}><Volume2 className="size-3.5" /></IconBtn>
          {metrics?.model && <IconBtn label="Tempos desta resposta" onClick={() => setShowTiming((v) => !v)}><Gauge className="size-3.5" /></IconBtn>}
          {metrics?.timeToFirstTokenMs != null && <span className="ml-1 font-mono text-[10.5px]">{(metrics.totalMs / 1000).toFixed(1)} s</span>}
        </div>
      )}
      {showTiming && metrics && (
        <div className="mt-2 surface rounded-xl p-3 text-[11.5px] font-mono grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1.5 animate-fade-up">
          <T label="modelo" v={metrics.model.replace(/:latest$/, '')} />
          <T label="1º token (core)" v={metrics.timeToFirstTokenMs != null ? `${metrics.timeToFirstTokenMs} ms` : '—'} />
          <T label="1º texto (aqui)" v={m.clientFirstMs != null ? `${m.clientFirstMs} ms` : '—'} />
          <T label="total" v={`${metrics.totalMs} ms`} />
          <T label="memória" v={ms(timing?.memoryMs)} />
          <T label="intenção" v={ms(timing?.intentMs)} />
          <T label="carga do modelo" v={ms(timing?.modelLoadMs)} />
          <T label="leitura do prompt" v={ms(timing?.promptEvalMs)} />
          <T label="geração" v={ms(timing?.generationMs)} />
          <T label="ferramentas" v={ms(timing?.toolsMs)} />
          <T label="backend" v={ms(timing?.backendMs)} />
          <T label="velocidade" v={metrics.tokensPerSecond ? `${metrics.tokensPerSecond} tok/s` : '—'} />
          {m.clientFirstMs != null && metrics.timeToFirstTokenMs != null && <T label="rede + interface" v={`${Math.max(0, m.clientFirstMs - metrics.timeToFirstTokenMs)} ms`} />}
        </div>
      )}
    </div>
  );
});

const ms = (v?: number) => (v == null ? '—' : `${v} ms`);
function T({ label, v }: { label: string; v: string }) {
  return <div><div className="text-dim text-[10px] uppercase tracking-wider font-sans">{label}</div><div className="text-fg/90 truncate">{v}</div></div>;
}
function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button aria-label={label} title={label} onClick={onClick} className="press grid place-items-center size-7 rounded-md hover:bg-white/[0.06] hover:text-fg">{children}</button>;
}
