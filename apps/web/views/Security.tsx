'use client';
import { useState } from 'react';
import { ShieldCheck, FolderPlus, Trash2, AppWindow, KeyRound, History, OctagonX, Play } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { Panel, Badge, Button, Input, Select, Toggle, ErrorNote, Empty, fmtTime, cx } from '@/components/ui';

type Perms = { roots: { id: string; path: string; access: string; remote: boolean }[]; apps: { id: string; name: string; execPath: string; canClose: boolean; remote: boolean }[]; grants: Record<string, string[]>; scopes: string[]; emergencyStop: boolean; approvalMode: string };
type Audit = { id: string; kind: string; origin: string; detail: string; created_at: string };
const SCOPE_LABEL: Record<string, string> = { 'fs.read': 'Ler arquivos', 'fs.write': 'Criar/editar arquivos', 'fs.delete': 'Excluir arquivos', 'apps.list': 'Listar apps', 'apps.launch': 'Abrir apps', 'apps.close': 'Fechar apps', 'browser.control': 'Controlar navegador', 'screen.capture': 'Capturar tela', 'system.read': 'Ler estado do PC', 'memory.read': 'Ler memórias', 'memory.write': 'Salvar memórias', 'lab.execute': 'Executar código/testes', 'net.fetch': 'Acessar internet' };

export function SecurityView() {
  const { api, notify, approvals, decide } = useJarvis();
  const local = api.mode === 'local';
  const p = useAsync(() => (local ? api.req<Perms>('/api/permissions') : Promise.resolve(null)), [api]);
  const audit = useAsync(() => (local ? api.req<Audit[]>('/api/audit?limit=80') : Promise.resolve([])), [api], 8000);
  const [root, setRoot] = useState({ path: '', access: 'read', remote: false });
  const [app, setApp] = useState({ name: '', execPath: '', canClose: false, remote: false });
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setErr(null);
    try { await fn(); if (ok) notify('ok', ok); await p.reload(); } catch (e) { setErr((e as Error).message); }
  };

  if (!local) return (
    <div className="p-3 sm:p-5 max-w-[900px] mx-auto space-y-4">
      <Panel title="Segurança pelo site" icon={<ShieldCheck className="size-4" />}>
        <p className="text-[12.5px] text-muted">Permissões, pastas e aplicativos só podem ser alterados no próprio computador. Pelo site você pode aprovar ou negar ações pendentes (risco médio), acionar a parada de emergência e revogar dispositivos no Device Center.</p>
        <Button className="mt-3" variant="danger" icon={<OctagonX className="size-4" />} onClick={() => api.emergencyStop().then(() => notify('ok', 'Parada de emergência enviada'), (e) => notify('err', e.message))}>Parada de emergência remota</Button>
      </Panel>
      <Panel title="Aprovações pendentes">
        {!approvals.length ? <p className="text-[12.5px] text-muted">Nenhuma.</p> : approvals.map((a) => (
          <div key={a.id} className="flex items-center gap-2 py-1.5"><span className="font-mono text-[12px] flex-1">{a.tool}</span><Badge tone="warn">{a.risk}</Badge><Button size="sm" variant="primary" onClick={() => decide(a.id, true)}>Aprovar</Button><Button size="sm" variant="ghost" onClick={() => decide(a.id, false)}>Negar</Button></div>
        ))}
      </Panel>
    </div>
  );

  return (
    <div className="p-3 sm:p-5 max-w-[1400px] mx-auto grid gap-4 lg:grid-cols-2">
      {(err ?? p.error) && <div className="lg:col-span-2"><ErrorNote error={err ?? p.error} /></div>}
      <Panel title="Pastas autorizadas" icon={<FolderPlus className="size-4" />}>
        <ul className="space-y-1.5">
          {p.data?.roots.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-[12.5px]"><span className="font-mono truncate flex-1">{r.path}</span><Badge tone={r.access === 'readwrite' ? 'orange' : 'neutral'}>{r.access === 'readwrite' ? 'leitura/escrita' : 'leitura'}</Badge>{r.remote && <Badge tone="warn">remoto</Badge>}
              <button aria-label={`Remover ${r.path}`} className="p-1 text-dim hover:text-err" onClick={() => act(() => api.req(`/api/permissions/roots/${r.id}`, { method: 'DELETE' }), 'Pasta removida')}><Trash2 className="size-3.5" /></button></li>
          ))}
          {!p.data?.roots.length && <li className="text-[12.5px] text-muted">Nenhuma pasta: o JARVIS não acessa arquivos.</li>}
        </ul>
        <div className="mt-3 flex flex-wrap gap-2 items-center">
          <Input value={root.path} onChange={(e) => setRoot({ ...root, path: e.target.value })} placeholder="C:\Users\voce\Projetos" className="flex-1 min-w-[200px] h-9" aria-label="Caminho da pasta" />
          <Select value={root.access} onChange={(v) => setRoot({ ...root, access: v })} options={[{ value: 'read', label: 'Somente leitura' }, { value: 'readwrite', label: 'Leitura e escrita' }]} />
          <label className="flex items-center gap-1.5 text-[12px] text-muted"><Toggle checked={root.remote} onChange={(v) => setRoot({ ...root, remote: v })} label="Permitir pelo site" />site</label>
          <Button size="sm" variant="primary" disabled={!root.path} onClick={() => act(() => api.req('/api/permissions/roots', { method: 'POST', json: root }), 'Pasta autorizada')}>Adicionar</Button>
        </div>
      </Panel>
      <Panel title="Aplicativos autorizados" icon={<AppWindow className="size-4" />}>
        <ul className="space-y-1.5">
          {p.data?.apps.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-[12.5px]"><span className="flex-1 truncate">{a.name} <span className="font-mono text-dim text-[11px]">{a.execPath}</span></span>{a.canClose && <Badge>pode fechar</Badge>}{a.remote && <Badge tone="warn">remoto</Badge>}
              <button aria-label={`Remover ${a.name}`} className="p-1 text-dim hover:text-err" onClick={() => act(() => api.req(`/api/permissions/apps/${a.id}`, { method: 'DELETE' }), 'Aplicativo removido')}><Trash2 className="size-3.5" /></button></li>
          ))}
        </ul>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Input value={app.name} onChange={(e) => setApp({ ...app, name: e.target.value })} placeholder="Nome (ex.: VS Code)" className="h-9" />
          <Input value={app.execPath} onChange={(e) => setApp({ ...app, execPath: e.target.value })} placeholder="Caminho do .exe" className="h-9" />
          <div className="flex items-center gap-4 text-[12px] text-muted">
            <label className="flex items-center gap-1.5"><Toggle checked={app.canClose} onChange={(v) => setApp({ ...app, canClose: v })} label="Pode fechar" />pode fechar</label>
            <label className="flex items-center gap-1.5"><Toggle checked={app.remote} onChange={(v) => setApp({ ...app, remote: v })} label="Pelo site" />pelo site</label>
          </div>
          <Button size="sm" variant="primary" disabled={!app.name || !app.execPath} onClick={() => act(() => api.req('/api/permissions/apps', { method: 'POST', json: app }), 'Aplicativo autorizado')}>Adicionar</Button>
        </div>
      </Panel>
      <Panel title="Permissões por origem" icon={<KeyRound className="size-4" />} className="lg:col-span-2" actions={
        <div className="flex items-center gap-2 text-[12px]"><span className="text-muted">Modo de aprovação</span><Select value={p.data?.approvalMode ?? 'balanced'} onChange={(v) => act(() => api.req('/api/settings', { method: 'POST', json: { approvalMode: v } }))} options={[{ value: 'balanced', label: 'Equilibrado' }, { value: 'strict', label: 'Estrito (aprovar tudo que altera)' }]} /></div>
      }>
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full text-[12.5px]">
            <thead className="text-dim"><tr><th className="text-left font-normal py-1">escopo</th><th className="font-normal">no PC</th><th className="font-normal">pelo site</th></tr></thead>
            <tbody>
              {p.data?.scopes.map((s) => (
                <tr key={s} className="border-t border-line">
                  <td className="py-1.5"><span>{SCOPE_LABEL[s] ?? s}</span> <span className="font-mono text-[10.5px] text-dim">{s}</span></td>
                  {(['local', 'remote'] as const).map((o) => <td key={o} className="text-center"><div className="inline-flex"><Toggle label={`${s} ${o}`} checked={!!p.data?.grants[o]?.includes(s)} onChange={(v) => act(() => api.req('/api/permissions/scopes', { method: 'POST', json: { scope: s, origin: o, enabled: v } }))} /></div></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-dim">Ações de risco alto (excluir, fechar apps, executar comandos) sempre pedem aprovação e só podem ser aprovadas neste computador. No modo equilibrado, risco médio vindo do site também pede aprovação.</p>
      </Panel>
      <Panel title="Parada de emergência" icon={<OctagonX className="size-4" />}>
        <p className="text-[12.5px] text-muted">Interrompe tarefas em execução, nega aprovações pendentes e bloqueia qualquer ferramenta até você retomar.</p>
        <div className="mt-3 flex gap-2">
          <Button variant="danger" icon={<OctagonX className="size-4" />} onClick={() => act(() => api.emergencyStop(), 'Parada acionada')}>Parar tudo agora</Button>
          {p.data?.emergencyStop && <Button icon={<Play className="size-4" />} onClick={() => act(() => api.req('/api/emergency/resume', { method: 'POST' }), 'Operação retomada')}>Retomar</Button>}
        </div>
      </Panel>
      <Panel title="Histórico de acesso e auditoria" icon={<History className="size-4" />}>
        {!audit.data?.length ? <Empty title="Sem eventos" /> : (
          <ul className="max-h-72 overflow-y-auto scroll-thin space-y-1 text-[11.5px]">
            {audit.data.map((a) => (
              <li key={a.id} className="flex gap-2"><span className="text-dim whitespace-nowrap">{fmtTime(a.created_at)}</span><span className={cx('font-mono', /denied|stop|revok/.test(a.kind) ? 'text-err' : 'text-orange-soft')}>{a.kind}</span><span className="text-dim">{a.origin}</span><span className="truncate text-muted">{a.detail}</span></li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
