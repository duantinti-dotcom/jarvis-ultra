'use client';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Loader2, Sparkles, FolderGit2 } from 'lucide-react';
import { useJarvis } from '@/lib/store';
import { cx } from '@/components/ui';

const loading = () => <div className="h-full grid place-items-center"><Loader2 className="size-5 animate-spin text-accent" /></div>;
const StudioView = dynamic(() => import('./Studio').then((m) => m.StudioView), { loading, ssr: false });
const CodeView = dynamic(() => import('./Code').then((m) => m.CodeView), { loading, ssr: false });

/** Lume Code: estúdio de sites (site e app) + projetos do PC (só no app desktop). */
export function CodeHub() {
  const { api } = useJarvis();
  const local = api.mode === 'local';
  const [tab, setTab] = useState<'studio' | 'pc'>('studio');
  useEffect(() => { try { if (local && localStorage.getItem('jarvis.code.tab') === 'pc') setTab('pc'); } catch {} }, [local]);
  const pick = (t: 'studio' | 'pc') => { setTab(t); try { localStorage.setItem('jarvis.code.tab', t); } catch {} };
  if (!local) return <StudioView />;
  return (
    <div className="h-full flex flex-col">
      <div className="h-10 shrink-0 flex items-center gap-1 px-3 border-b border-line">
        {([['studio', 'Criar sites', Sparkles], ['pc', 'Projetos do PC', FolderGit2]] as const).map(([id, label, I]) => (
          <button key={id} onClick={() => pick(id)} className={cx('press flex items-center gap-1.5 px-3 h-7 rounded-md text-[12px]', tab === id ? 'bg-white/[0.08] text-fg' : 'text-dim hover:text-muted')}><I className="size-3.5" />{label}</button>
        ))}
      </div>
      <div className="flex-1 min-h-0">{tab === 'studio' ? <StudioView /> : <CodeView />}</div>
    </div>
  );
}
