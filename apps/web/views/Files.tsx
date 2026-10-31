'use client';
import { useState } from 'react';
import { Folder, FileText, ChevronRight, Code2, MessageSquare, FolderPlus, Clock, Briefcase, Trash2, ArrowUp } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { useChat } from '@/lib/chat';
import { Button, Input, Empty, Select, fmtAgo, fmtBytes } from '@/components/ui';

type Entry = { name: string; path: string; type: string; size: number; modified: string };
type Project = { id: string; name: string; path: string | null; description: string | null; updated_at: string };

export function FilesView() {
  const { api, notify } = useJarvis();
  const chat = useChat();
  const perms = useAsync(() => api.req<{ roots: { path: string; access: string }[] }>('/api/permissions'), [api]);
  const [dir, setDir] = useState<string>('');
  const cwd = dir || perms.data?.roots[0]?.path || '';
  const list = useAsync(() => (cwd ? api.req<{ ok: boolean; error?: string; data?: { entries: Entry[] } }>('/api/tools/invoke', { method: 'POST', json: { tool: 'fs.list', args: { path: cwd, limit: 500 } } }) : Promise.resolve(null)), [api, cwd]);
  const recent = useAsync(() => api.req<{ data?: { files: { path: string; modified: string; size: number }[] } }>('/api/tools/invoke', { method: 'POST', json: { tool: 'fs.recent', args: { hours: 72, limit: 12 } } }), [api]);
  const projects = useAsync(() => api.req<Project[]>('/api/projects'), [api]);
  const [pname, setPname] = useState('');

  const root = perms.data?.roots.find((r) => cwd.toLowerCase().startsWith(r.path.toLowerCase()));
  const crumbs = root ? [root.path, ...cwd.slice(root.path.length).split(/[\\/]/).filter(Boolean)] : [];
  const entries = (list.data?.data?.entries ?? []).sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name));
  const askAbout = async (p: string, q: string) => { await chat.open(null); location.hash = '#/chat'; await chat.send(`${q}: ${p}`); };
  const openInCode = (p: string) => { try { localStorage.setItem('jarvis.code.project', p); } catch {} location.hash = '#/code'; };

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="surface rounded-2xl min-w-0">
        <div className="flex items-center gap-2 px-4 h-12 border-b border-line">
          {perms.data && perms.data.roots.length > 1 && <Select value={root?.path ?? ''} onChange={(v) => setDir(v)} options={perms.data.roots.map((r) => ({ value: r.path, label: r.path.split(/[\\/]/).pop() || r.path }))} className="h-8" />}
          <nav className="flex items-center gap-1 text-[12.5px] min-w-0 overflow-x-auto scroll-thin" aria-label="Caminho">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1 whitespace-nowrap">
                {i > 0 && <ChevronRight className="size-3 text-dim" />}
                <button className="hover:text-fg text-muted" onClick={() => setDir(root!.path + (i ? '/' + crumbs.slice(1, i + 1).join('/') : ''))}>{i === 0 ? (c.split(/[\\/]/).pop() || c) : c}</button>
              </span>
            ))}
          </nav>
          {cwd !== root?.path && root && <button aria-label="Subir uma pasta" className="ml-auto p-1.5 text-dim hover:text-fg" onClick={() => setDir(cwd.replace(/[\\/][^\\/]+$/, ''))}><ArrowUp className="size-4" /></button>}
        </div>
        {!perms.data?.roots.length ? <Empty title="Nenhuma pasta liberada">Libere pastas em Desktop Control → Permissões.</Empty> : list.data && !list.data.ok ? <div className="p-4 text-err text-[13px]">{list.data.error}</div> : (
          <ul className="divide-y divide-[var(--color-line)]">
            {entries.map((e) => (
              <li key={e.path} className="group flex items-center gap-3 px-4 h-11 hover:bg-white/[0.02]">
                {e.type === 'dir' ? <Folder className="size-4 text-amber/80" /> : <FileText className="size-4 text-dim" />}
                <button className="flex-1 min-w-0 truncate text-left text-[13px]" onClick={() => (e.type === 'dir' ? setDir(e.path) : askAbout(e.path, 'Leia e resuma o arquivo'))}>{e.name}</button>
                <span className="hidden sm:block text-[11px] text-dim w-20 text-right">{e.type === 'dir' ? '' : fmtBytes(e.size)}</span>
                <span className="hidden md:block text-[11px] text-dim w-24 text-right">{fmtAgo(e.modified)}</span>
                <div className="opacity-0 group-hover:opacity-100 flex gap-1">
                  {e.type === 'dir' && <button title="Abrir no Jarvis Code" onClick={() => openInCode(e.path)} className="p-1.5 text-dim hover:text-orange-soft"><Code2 className="size-3.5" /></button>}
                  <button title="Perguntar ao Jarvis" onClick={() => askAbout(e.path, e.type === 'dir' ? 'Analise esta pasta e me diga o que ela contém' : 'Leia e resuma o arquivo')} className="p-1.5 text-dim hover:text-orange-soft"><MessageSquare className="size-3.5" /></button>
                </div>
              </li>
            ))}
            {!entries.length && !list.loading && <li className="px-4 py-8 text-center text-[12.5px] text-dim">Pasta vazia.</li>}
          </ul>
        )}
      </section>

      <div className="space-y-5">
        <section className="surface rounded-2xl p-4">
          <h3 className="font-display text-[14px] flex items-center gap-2"><Briefcase className="size-4 text-orange-glow" />Projetos</h3>
          <ul className="mt-2 space-y-1">
            {projects.data?.map((p) => (
              <li key={p.id} className="group flex items-center gap-2 text-[12.5px] py-1">
                <button className="flex-1 truncate text-left hover:text-fg" onClick={() => p.path && openInCode(p.path)} title={p.path ?? ''}>{p.name}</button>
                {p.path && <button title="Abrir no Code" onClick={() => openInCode(p.path!)} className="text-dim hover:text-orange-soft"><Code2 className="size-3.5" /></button>}
                <button title="Remover" onClick={() => api.req(`/api/projects/${p.id}`, { method: 'DELETE' }).then(() => projects.reload())} className="opacity-0 group-hover:opacity-100 text-dim hover:text-err"><Trash2 className="size-3.5" /></button>
              </li>
            ))}
            {!projects.data?.length && <li className="text-[12px] text-dim">Registre um projeto para o Jarvis lembrar dele nas conversas.</li>}
          </ul>
          <div className="mt-2 flex gap-1.5">
            <Input value={pname} onChange={(e) => setPname(e.target.value)} placeholder="Nome do projeto" className="h-8 text-[12px]" />
            <Button size="sm" icon={<FolderPlus className="size-3.5" />} disabled={!pname.trim()} onClick={async () => { const r = await api.req<{ ok: boolean; error?: string }>('/api/projects', { method: 'POST', json: { name: pname, path: cwd } }); if (!r.ok) notify('err', r.error ?? 'falha'); setPname(''); await projects.reload(); }}>Pasta atual</Button>
          </div>
        </section>
        <section className="surface rounded-2xl p-4">
          <h3 className="font-display text-[14px] flex items-center gap-2"><Clock className="size-4 text-orange-glow" />Modificados recentemente</h3>
          <ul className="mt-2 space-y-1.5">
            {recent.data?.data?.files.map((f) => (
              <li key={f.path} className="text-[12px]"><button onClick={() => askAbout(f.path, 'Leia e resuma o arquivo')} className="w-full text-left truncate hover:text-fg text-muted" title={f.path}>{f.path.split(/[\\/]/).pop()}</button><div className="text-[10.5px] text-dim">{fmtAgo(f.modified)}</div></li>
            ))}
            {!recent.data?.data?.files.length && <li className="text-[12px] text-dim">Nada nos últimos 3 dias.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
