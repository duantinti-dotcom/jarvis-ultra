'use client';
import { useState } from 'react';
import { Database, Search, Download, Trash2, Pencil, Plus, Check, Cloud, History, ShieldCheck } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { Panel, Badge, Button, Input, Textarea, Select, Toggle, Empty, ErrorNote, fmtTime, cx } from '@/components/ui';
import type { Memory } from '@jarvis/contracts';

const CATS: Record<string, string> = { personal: 'Pessoal', project: 'Projetos', operational: 'Operacional', semantic: 'Semântica', episodic: 'Episódica', procedural: 'Procedural' };
type M = Memory & { supersededBy?: string | null; score?: number };

export function MemoryView() {
  const { api, notify } = useJarvis();
  const local = api.mode === 'local';
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState('');
  const [editing, setEditing] = useState<M | null>(null);
  const [adding, setAdding] = useState(false);
  const mems = useAsync<M[]>(() => (local ? api.req<M[]>(`/api/memory?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(cat ? { category: cat } : {}) })}`) : api.memories(query || undefined) as Promise<M[]>), [api, query, cat]);
  const cats = useAsync(() => (local ? api.req<{ disabled: string[] }>('/api/memory-categories') : Promise.resolve({ disabled: [] as string[] })), [api]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) notify('ok', ok); await mems.reload(); } catch (e) { notify('err', (e as Error).message); }
  };
  const exportAll = async () => {
    const data = await api.req('/api/memory-export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `jarvis-memorias-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };

  return (
    <div className="p-3 sm:p-5 max-w-[1300px] mx-auto grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className="space-y-4">
        <Panel title="Categorias" icon={<Database className="size-4" />} bodyClass="p-2">
          <button onClick={() => setCat('')} className={cx('w-full text-left px-3 h-9 rounded-lg text-[13px]', !cat ? 'bg-orange/10 text-fg' : 'text-muted hover:bg-white/5')}>Todas</button>
          {Object.entries(CATS).map(([k, v]) => (
            <div key={k} className={cx('flex items-center rounded-lg pr-2', cat === k ? 'bg-orange/10' : 'hover:bg-white/5')}>
              <button onClick={() => setCat(k)} className={cx('flex-1 text-left px-3 h-9 text-[13px]', cat === k ? 'text-fg' : 'text-muted')}>{v}</button>
              {local && <Toggle label={`Ativar ${v}`} checked={!cats.data?.disabled.includes(k)} onChange={(on) => act(() => api.req('/api/memory-categories', { method: 'POST', json: { category: k, enabled: on } }).then(() => cats.reload()))} />}
            </div>
          ))}
        </Panel>
        {local && (
          <Panel title="Ações" bodyClass="p-3 space-y-2">
            <Button className="w-full" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Nova memória</Button>
            <Button className="w-full" icon={<Download className="size-4" />} onClick={exportAll}>Exportar (JSON)</Button>
            <Button className="w-full" variant="ghost" icon={<History className="size-4" />} onClick={() => act(() => api.req('/api/memory-reindex', { method: 'POST' }), 'Índice semântico atualizado')}>Reindexar embeddings</Button>
            <p className="text-[11px] text-dim pt-1">Ative a nuvem <Cloud className="inline size-3" /> numa memória para que ela apareça no site. As demais nunca saem do PC.</p>
          </Panel>
        )}
      </div>

      <div className="space-y-4">
        <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }} className="flex gap-2">
          <div className="relative flex-1"><Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-dim" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por significado ou palavras…" className="pl-9" aria-label="Buscar memórias" /></div>
          <Button type="submit" variant="primary">Buscar</Button>
        </form>
        {!local && <p className="text-[12px] text-dim">No site aparecem somente memórias marcadas como sincronizáveis no computador.</p>}
        {(adding || editing) && local && <Editor m={editing} onClose={() => { setAdding(false); setEditing(null); }} onSaved={() => { setAdding(false); setEditing(null); void mems.reload(); }} />}
        <ErrorNote error={mems.error} />
        {!mems.data?.length ? <Panel><Empty icon={<Database className="size-8" />} title="Nenhuma memória">Diga “lembre que…” no chat ou crie uma manualmente.</Empty></Panel> : (
          <div className="grid gap-3 md:grid-cols-2">
            {mems.data.map((m) => (
              <article key={m.id} className="glass glass-hover rounded-2xl p-4 animate-fade-up">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge tone="orange">{CATS[m.category] ?? m.category}</Badge>
                  {m.category === 'procedural' && m.confidence < 0.9 && <Badge tone="warn">candidato</Badge>}
                  {m.syncable && <Badge><Cloud className="size-3" />site</Badge>}
                  {m.score != null && <span className="label-tech">score {m.score}</span>}
                </div>
                <h3 className="mt-2 font-display text-[14.5px]">{m.title}</h3>
                <p className="mt-1 text-[12.5px] text-muted whitespace-pre-wrap line-clamp-5">{m.content}</p>
                <div className="mt-2 text-[10.5px] text-dim font-mono">origem {m.source} · {fmtTime(m.updatedAt)} · confiança {m.confidence}</div>
                {local && (
                  <div className="mt-3 flex gap-1.5 flex-wrap">
                    <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(m)}>Corrigir</Button>
                    <Button size="sm" variant="ghost" icon={<Cloud className="size-3.5" />} onClick={() => act(() => api.req(`/api/memory/${m.id}`, { method: 'PATCH', json: { syncable: !m.syncable } }))}>{m.syncable ? 'Só no PC' : 'Mostrar no site'}</Button>
                    {m.category === 'procedural' && m.confidence < 0.9 && <Button size="sm" variant="ghost" icon={<ShieldCheck className="size-3.5" />} onClick={() => act(() => api.req(`/api/memory/${m.id}/approve`, { method: 'POST' }), 'Procedimento aprovado')}>Aprovar procedimento</Button>}
                    <Button size="sm" variant="ghost" className="hover:!text-err" icon={<Trash2 className="size-3.5" />} onClick={() => confirm('Excluir esta memória permanentemente?') && act(() => api.req(`/api/memory/${m.id}`, { method: 'DELETE' }), 'Memória excluída')}>Excluir</Button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Editor({ m, onClose, onSaved }: { m: M | null; onClose: () => void; onSaved: () => void }) {
  const { api } = useJarvis();
  const [title, setTitle] = useState(m?.title ?? '');
  const [content, setContent] = useState(m?.content ?? '');
  const [category, setCategory] = useState<string>(m?.category ?? 'personal');
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      if (m) await api.req(`/api/memory/${m.id}/correct`, { method: 'POST', json: { content } });
      else await api.req('/api/memory', { method: 'POST', json: { title, content, category } });
      onSaved();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Panel title={m ? 'Corrigir memória (o histórico é preservado)' : 'Nova memória'}>
      <div className="space-y-2">
        {!m && <div className="flex gap-2"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título" /><Select value={category} onChange={setCategory} options={Object.entries(CATS).map(([value, label]) => ({ value, label }))} /></div>}
        <Textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Conteúdo" />
        <ErrorNote error={err} />
        <div className="flex gap-2"><Button variant="primary" icon={<Check className="size-4" />} onClick={save}>Salvar</Button><Button variant="ghost" onClick={onClose}>Cancelar</Button></div>
      </div>
    </Panel>
  );
}
