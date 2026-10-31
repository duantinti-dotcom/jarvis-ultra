'use client';
import { useState } from 'react';
import { AppWindow, FolderOpen, Camera, PlayCircle, History, OctagonX, Image as ImageIcon } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { Panel, Badge, Button, Empty, ErrorNote, fmtTime } from '@/components/ui';

type Perms = { roots: { id: string; path: string; access: string; remote: boolean }[]; apps: { id: string; name: string; execPath: string; canClose: boolean; remote: boolean }[] };
type Call = { id: string; tool: string; args: string; origin: string; ok: number; error: string | null; duration_ms: number; created_at: string };

export function DesktopView() {
  const { api, notify, chat } = useJarvis();
  const perms = useAsync(() => api.req<Perms>('/api/permissions'), [api]);
  const running = useAsync(() => api.req<{ data?: { processes: { pid: number; name: string; title: string }[] } }>('/api/tools/invoke', { method: 'POST', json: { tool: 'apps.running', args: { limit: 30 } } }), [api], 15_000);
  const calls = useAsync(() => api.req<Call[]>('/api/tool-calls?limit=40'), [api, chat.reloadList], 5000);
  const [capture, setCapture] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const invoke = async (tool: string, args: Record<string, unknown>, label: string) => {
    setBusy(label);
    try {
      const r = await api.req<{ ok: boolean; error?: string; data?: { path?: string }; verification?: { detail: string } }>('/api/tools/invoke', { method: 'POST', json: { tool, args } });
      if (!r.ok) throw new Error(r.error);
      notify('ok', `${label}: ${r.verification?.detail ?? 'ok'}`);
      return r;
    } catch (e) {
      notify('err', `${label}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      void calls.reload();
    }
  };

  return (
    <div className="p-3 sm:p-5 max-w-[1400px] mx-auto grid gap-4 lg:grid-cols-2">
      <Panel title="Aplicativos autorizados" icon={<AppWindow className="size-4" />} actions={<a href="#/security" className="text-[11.5px] text-muted hover:text-fg">gerenciar</a>}>
        <ErrorNote error={perms.error} />
        {!perms.data?.apps.length ? <Empty title="Nenhum aplicativo autorizado">Adicione na Central de Segurança.</Empty> : (
          <ul className="grid sm:grid-cols-2 gap-2">
            {perms.data.apps.map((a) => (
              <li key={a.id} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2">
                <div className="min-w-0 flex-1"><div className="text-[13px] truncate">{a.name}</div><div className="text-[10.5px] text-dim font-mono truncate">{a.execPath}</div></div>
                <Button size="sm" icon={<PlayCircle className="size-3.5" />} loading={busy === a.name} onClick={() => invoke('apps.launch', { name: a.name }, a.name)}>Abrir</Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Pastas permitidas" icon={<FolderOpen className="size-4" />}>
        <ul className="space-y-1.5">
          {perms.data?.roots.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-[12.5px]"><FolderOpen className="size-3.5 text-orange" /><span className="font-mono truncate flex-1">{r.path}</span><Badge tone={r.access === 'readwrite' ? 'orange' : 'neutral'}>{r.access === 'readwrite' ? 'leitura/escrita' : 'leitura'}</Badge>{r.remote && <Badge>remoto</Badge>}</li>
          ))}
        </ul>
      </Panel>
      <Panel title="Captura autorizada" icon={<Camera className="size-4" />}>
        <p className="text-[12.5px] text-muted">Uma captura por clique. A barra superior mostra um aviso sempre que a tela é capturada. O JARVIS nunca captura continuamente.</p>
        <div className="mt-3 flex gap-2 flex-wrap">
          <Button icon={<Camera className="size-4" />} loading={busy === 'Captura'} onClick={async () => { const r = await invoke('screen.capture', {}, 'Captura'); if (r?.data?.path) setCapture(r.data.path); }}>Capturar tela</Button>
          {capture && <Button variant="ghost" icon={<ImageIcon className="size-4" />} onClick={async () => { await chat.open(null); await chat.send(`Analise a captura ${capture} e explique o que aparece na tela.`); location.hash = '#/chat'; }}>Pedir para o JARVIS explicar</Button>}
        </div>
        {capture && <p className="mt-2 text-[11px] font-mono text-dim break-all">{capture}</p>}
      </Panel>
      <Panel title="Janelas abertas agora" icon={<AppWindow className="size-4" />}>
        {running.data?.data?.processes?.length ? (
          <ul className="max-h-56 overflow-y-auto scroll-thin text-[12px] space-y-1">
            {running.data.data.processes.filter((p) => p.title || p.name).slice(0, 30).map((p) => <li key={p.pid} className="flex gap-2"><span className="text-dim tabular-nums w-14">{p.pid}</span><span className="text-muted">{p.name}</span><span className="truncate text-fg/80">{p.title}</span></li>)}
          </ul>
        ) : <p className="text-[12.5px] text-muted">{running.error ?? 'Sem dados.'}</p>}
      </Panel>
      <Panel title="Ações realizadas" icon={<History className="size-4" />} className="lg:col-span-2" actions={<Button size="sm" variant="danger" icon={<OctagonX className="size-3.5" />} onClick={() => api.emergencyStop()}>Emergência</Button>}>
        {!calls.data?.length ? <Empty title="Nenhuma ação ainda" /> : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-[12px]">
              <thead className="text-dim text-left"><tr><th className="font-normal py-1">quando</th><th className="font-normal">ferramenta</th><th className="font-normal">origem</th><th className="font-normal">resultado</th><th className="font-normal text-right">ms</th></tr></thead>
              <tbody>
                {calls.data.map((c) => (
                  <tr key={c.id} className="border-t border-line align-top">
                    <td className="py-1.5 text-dim whitespace-nowrap pr-3">{fmtTime(c.created_at)}</td>
                    <td className="font-mono text-orange-soft pr-3">{c.tool}</td>
                    <td className="pr-3">{c.origin}</td>
                    <td className="pr-3">{c.ok ? <span className="text-ok">ok</span> : <span className="text-err">{c.error?.slice(0, 90)}</span>}</td>
                    <td className="text-right tabular-nums text-dim">{c.duration_ms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
