'use client';
import { useMemo, useState } from 'react';
import { AppWindow, FolderOpen, Globe, TerminalSquare, Camera, MousePointerClick, Pause, Play, Square, CheckCircle2, XCircle, Loader2, Plus, Trash2, ArrowUp, ShieldAlert, History } from 'lucide-react';
import { useJarvis, useAsync, type ActiveTask } from '@/lib/store';
import { useChat } from '@/lib/chat';
import { Badge, Button, Input, Toggle, Empty, Meter, cx, fmtTime } from '@/components/ui';
import { Markdown } from '@/components/Markdown';

type Perms = { roots: { id: string; path: string; access: string; remote: boolean }[]; apps: { id: string; name: string; execPath: string; canClose: boolean; remote: boolean }[]; grants: Record<string, string[]> };

export function DesktopView() {
  const { api, tasks, notify, refreshTick } = useJarvis();
  const chat = useChat();
  const perms = useAsync(() => api.req<Perms>('/api/permissions'), [api, refreshTick]);
  const recent = useAsync(() => api.tasks(15), [api, refreshTick]);
  const [text, setText] = useState('');

  const live = useMemo(() => Object.values(tasks).sort((a, b) => b.updatedAt - a.updatedAt), [tasks]);
  const current = live.find((t) => !['completed', 'failed', 'cancelled'].includes(t.state)) ?? live[0];
  const reply = current?.conversationId === chat.conversationId ? [...chat.messages].reverse().find((m) => m.role === 'assistant') : undefined;

  const ask = async () => {
    if (!text.trim()) return;
    const t = text;
    setText('');
    await chat.open(null);
    await chat.send(t, undefined, undefined, { local: true });
  };
  const grant = async (scope: string, on: boolean) => {
    try { await api.req('/api/permissions/scopes', { method: 'POST', json: { scope, origin: 'local', enabled: on } }); await perms.reload(); }
    catch (e) { notify('err', (e as Error).message); }
  };
  const g = new Set(perms.data?.grants.local ?? []);

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div className="space-y-5 min-w-0">
        {/* Pedir uma tarefa */}
        <section className="surface-raised rounded-2xl p-4">
          <h2 className="font-display text-[15px]">O que o Jarvis deve fazer no computador?</h2>
          <p className="text-[12.5px] text-dim mt-0.5">Ex.: “abra o Bloco de Notas e escreva a lista de compras”, “organize os PDFs da pasta Downloads por mês”.</p>
          <div className="mt-3 flex items-end gap-2">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(); } }} aria-label="Tarefa para o computador"
              className="flex-1 resize-none rounded-xl bg-black/30 border border-line px-3 py-2.5 text-[14px] outline-none focus:border-orange/50" placeholder="Descreva a tarefa…" />
            <button aria-label="Executar" onClick={ask} disabled={!text.trim() || chat.busy} className="press grid place-items-center size-11 rounded-xl bg-gradient-to-b from-orange to-[#e85d00] text-black disabled:opacity-30"><ArrowUp className="size-5" /></button>
          </div>
        </section>

        {/* Execução ao vivo */}
        <section className="surface rounded-2xl p-4" aria-live="polite">
          {!current ? <Empty icon={<History className="size-7" />} title="Nenhuma tarefa em execução">Quando o Jarvis trabalhar no computador, você acompanha aqui cada etapa.</Empty> : <Execution t={current} reply={reply?.content} />}
        </section>

        <section className="surface rounded-2xl p-4">
          <h3 className="font-display text-[14px] mb-2">Tarefas recentes</h3>
          {!recent.data?.length ? <p className="text-[12.5px] text-dim">Nenhuma ainda.</p> : (
            <ul className="divide-y divide-[var(--color-line)]">
              {recent.data.slice(0, 8).map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2 text-[12.5px]">
                  {t.state === 'completed' ? <CheckCircle2 className="size-4 text-ok" /> : t.state === 'failed' ? <XCircle className="size-4 text-err" /> : t.state === 'cancelled' ? <Square className="size-4 text-dim" /> : <Loader2 className="size-4 animate-spin text-orange" />}
                  <span className="truncate flex-1">{t.goal}</span>
                  <span className="text-dim text-[11px] whitespace-nowrap">{fmtTime(t.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Permissões */}
      <div className="space-y-3 min-w-0">
        <h2 className="font-display text-[15px] px-1">Permissões</h2>
        <p className="text-[12.5px] text-dim px-1 -mt-2">Dentro do que você liberar, o Jarvis trabalha sem pedir confirmação a cada passo. Exclusões, comandos destrutivos e ações sensíveis sempre pedem a sua confirmação.</p>
        <PermCard icon={AppWindow} title="Aplicativos" desc="Quais programas o Jarvis pode abrir e controlar." on={g.has('apps.launch')} onToggle={(v) => grant('apps.launch', v)}>
          <AppsEditor perms={perms.data} reload={perms.reload} />
        </PermCard>
        <PermCard icon={FolderOpen} title="Pastas" desc="Onde ele pode ler e criar arquivos." on={g.has('fs.read')} onToggle={(v) => grant('fs.read', v)}>
          <RootsEditor perms={perms.data} reload={perms.reload} />
          <label className="mt-2 flex items-center gap-2 text-[12px] text-muted"><Toggle checked={g.has('fs.write')} onChange={(v) => grant('fs.write', v)} label="Criar e editar arquivos" />Criar e editar arquivos</label>
          <label className="mt-1.5 flex items-center gap-2 text-[12px] text-muted"><Toggle checked={g.has('fs.delete')} onChange={(v) => grant('fs.delete', v)} label="Excluir arquivos" />Excluir arquivos (sempre com confirmação e backup)</label>
        </PermCard>
        <PermCard icon={MousePointerClick} title="Mouse e teclado" desc="Clicar, digitar e acionar botões dentro dos apps liberados (UI Automation do Windows)." on={g.has('input.control')} onToggle={(v) => grant('input.control', v)} />
        <PermCard icon={Globe} title="Navegador" desc="Abrir sites, ler páginas, clicar e preencher formulários no navegador do Jarvis. Senhas nunca são preenchidas." on={g.has('browser.control')} onToggle={(v) => grant('browser.control', v)} />
        <PermCard icon={TerminalSquare} title="Terminal" desc="Executar comandos (npm, git, python…) em pastas liberadas. Comandos destrutivos pedem confirmação." on={g.has('terminal.exec')} onToggle={(v) => grant('terminal.exec', v)} />
        <PermCard icon={Camera} title="Tela" desc="Capturar a tela ou uma janela para entender a interface. Um aviso aparece a cada captura." on={g.has('screen.capture')} onToggle={(v) => grant('screen.capture', v)} />
      </div>
    </div>
  );
}

function Execution({ t, reply }: { t: ActiveTask; reply?: string }) {
  const { api, notify } = useJarvis();
  const running = !['completed', 'failed', 'cancelled'].includes(t.state);
  const paused = t.state === 'paused';
  const done = t.steps.filter((s) => s.state !== 'running').length;
  const failed = t.steps.filter((s) => s.state === 'failed');
  const app = [...t.steps].reverse().find((s) => s.app)?.app;
  const cur = [...t.steps].reverse().find((s) => s.state === 'running');
  const act = (path: string) => api.req(`/api/tasks/${t.taskId}/${path}`, { method: 'POST' }).catch((e) => notify('err', e.message));
  const STATE: Record<string, [string, 'ok' | 'err' | 'warn' | 'orange' | 'neutral']> = { executing: ['Executando', 'orange'], planning: ['Planejando', 'orange'], verifying: ['Verificando', 'orange'], correcting: ['Corrigindo', 'warn'], awaiting_approval: ['Aguardando sua confirmação', 'warn'], paused: ['Pausada', 'warn'], completed: ['Concluída', 'ok'], failed: ['Falhou', 'err'], cancelled: ['Parada', 'neutral'] };
  const [label, tone] = STATE[t.state] ?? [t.state, 'neutral'];
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge tone={tone} pulse={running && !paused}>{label}</Badge>
        {app && <Badge><AppWindow className="size-3" />{app}</Badge>}
        <div className="ml-auto flex gap-1.5">
          {running && !paused && <Button size="sm" icon={<Pause className="size-3.5" />} onClick={() => act('pause')}>Pausar</Button>}
          {paused && <Button size="sm" variant="primary" icon={<Play className="size-3.5" />} onClick={() => act('resume')}>Continuar</Button>}
          {running && <Button size="sm" variant="danger" icon={<Square className="size-3.5" />} onClick={() => act('cancel')}>Parar</Button>}
        </div>
      </div>
      <h3 className="mt-3 font-display text-[16px] leading-snug">{t.goal ?? 'Tarefa'}</h3>
      {cur && <p className="mt-1 text-[12.5px] text-orange-soft flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" />Agora: {cur.tool} {cur.description}</p>}
      {t.steps.length > 0 && <div className="mt-3"><Meter value={done} max={Math.max(t.steps.length, 1)} tone={failed.length ? 'err' : 'orange'} /><div className="mt-1 text-[11px] text-dim">{done} de {t.steps.length} ações concluídas</div></div>}
      <ol className="mt-3 space-y-1.5">
        {t.steps.map((s) => (
          <li key={s.index} className="flex items-start gap-2 text-[12.5px]">
            {s.state === 'running' ? <Loader2 className="size-4 mt-0.5 animate-spin text-orange shrink-0" /> : s.state === 'done' ? <CheckCircle2 className="size-4 mt-0.5 text-ok shrink-0" /> : <XCircle className="size-4 mt-0.5 text-err shrink-0" />}
            <div className="min-w-0"><span className="font-mono text-orange-soft">{s.tool}</span> <span className={cx('break-words', s.state === 'failed' ? 'text-err' : 'text-muted')}>{s.description}</span></div>
          </li>
        ))}
      </ol>
      {!running && reply && <div className="mt-4 border-t border-line pt-3 text-[13px]"><div className="label-tech mb-1">Resultado</div><Markdown text={reply} /></div>}
    </div>
  );
}

function PermCard({ icon: Icon, title, desc, on, onToggle, children }: { icon: typeof AppWindow; title: string; desc: string; on: boolean; onToggle: (v: boolean) => void; children?: React.ReactNode }) {
  return (
    <section className={cx('surface rounded-2xl p-4 transition-colors', on && '!border-orange/20')}>
      <div className="flex items-start gap-3">
        <span className={cx('grid place-items-center size-9 rounded-xl shrink-0', on ? 'bg-orange/[0.14] text-orange-glow' : 'bg-white/[0.04] text-dim')}><Icon className="size-[18px]" /></span>
        <div className="flex-1 min-w-0"><div className="text-[13.5px] font-medium">{title}</div><div className="text-[12px] text-dim">{desc}</div></div>
        <Toggle checked={on} onChange={onToggle} label={title} />
      </div>
      {children && on && <div className="mt-3 pl-12">{children}</div>}
    </section>
  );
}

function AppsEditor({ perms, reload }: { perms: Perms | null; reload: () => Promise<void> }) {
  const { api, notify } = useJarvis();
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const add = async () => {
    try { await api.req('/api/permissions/apps', { method: 'POST', json: { name, execPath: path, canClose: true } }); setName(''); setPath(''); await reload(); }
    catch (e) { notify('err', (e as Error).message); }
  };
  return (
    <div className="space-y-1.5">
      {perms?.apps.map((a) => (
        <div key={a.id} className="flex items-center gap-2 text-[12.5px]">
          <span className="flex-1 truncate">{a.name}</span>
          {a.remote && <Badge>pelo celular</Badge>}
          <button aria-label={`Remover ${a.name}`} onClick={() => api.req(`/api/permissions/apps/${a.id}`, { method: 'DELETE' }).then(reload)} className="text-dim hover:text-err"><Trash2 className="size-3.5" /></button>
        </div>
      ))}
      <div className="flex gap-1.5 pt-1">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome (ex.: Excel)" className="h-8 text-[12px]" />
        <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="excel.exe ou caminho completo" className="h-8 text-[12px]" />
        <Button size="sm" icon={<Plus className="size-3.5" />} disabled={!name || !path} onClick={add}>Liberar</Button>
      </div>
    </div>
  );
}

function RootsEditor({ perms, reload }: { perms: Perms | null; reload: () => Promise<void> }) {
  const { api, notify } = useJarvis();
  const [p, setP] = useState('');
  const add = async (path: string) => {
    try { await api.req('/api/permissions/roots', { method: 'POST', json: { path, access: 'readwrite' } }); setP(''); await reload(); }
    catch (e) { notify('err', (e as Error).message); }
  };
  return (
    <div className="space-y-1.5">
      {perms?.roots.map((r) => (
        <div key={r.id} className="flex items-center gap-2 text-[12.5px]">
          <span className="flex-1 truncate font-mono text-[11.5px]" title={r.path}>{r.path}</span>
          <Badge tone={r.access === 'readwrite' ? 'orange' : 'neutral'}>{r.access === 'readwrite' ? 'ler e escrever' : 'só ler'}</Badge>
          <button aria-label={`Remover ${r.path}`} onClick={() => api.req(`/api/permissions/roots/${r.id}`, { method: 'DELETE' }).then(reload)} className="text-dim hover:text-err"><Trash2 className="size-3.5" /></button>
        </div>
      ))}
      <div className="flex gap-1.5 pt-1">
        <Input value={p} onChange={(e) => setP(e.target.value)} placeholder="C:\Users\voce\Documentos\Projetos" className="h-8 text-[12px]" />
        <Button size="sm" icon={<Plus className="size-3.5" />} disabled={!p} onClick={() => add(p)}>Liberar</Button>
      </div>
      <p className="text-[11px] text-dim flex items-center gap-1"><ShieldAlert className="size-3" />Raízes de disco (C:\) não são aceitas; libere pastas específicas ou a sua pasta de usuário.</p>
    </div>
  );
}
