'use client';
import { useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert, KeyRound, Mic, MonitorSmartphone, History, OctagonX, Play, Lock, Globe, FolderOpen, AppWindow, TerminalSquare, MousePointerClick, Camera, Trash2 } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { Panel, Badge, Button, Toggle, Select, Empty, fmtTime, cx } from '@/components/ui';
import { supabase } from '@/lib/remote';

type Overview = {
  session: { core: string; boundTo: string; startedAt: string }; emergencyStop: boolean; remote: { enabled: boolean; connected: boolean; deviceId: string | null };
  roots: number; apps: number; sensitiveScopes: { inputControl: boolean; terminal: boolean; screenCapture: boolean; browser: boolean; delete: boolean };
  pendingApprovals: number; credentials: { name: string; configured: boolean; protection: string | null }[]; deniedLast24h: number; actionsLast24h: number;
};
type Perms = { grants: Record<string, string[]>; scopes: string[]; approvalMode: string };
type Audit = { id: string; kind: string; origin: string; detail: string; created_at: string };
const SCOPE: Record<string, string> = { 'fs.read': 'Ler arquivos', 'fs.write': 'Criar/editar arquivos', 'fs.delete': 'Excluir arquivos', 'apps.list': 'Ver apps abertos', 'apps.launch': 'Abrir apps', 'apps.close': 'Fechar apps', 'browser.control': 'Navegador', 'screen.capture': 'Capturar tela', 'system.read': 'Estado do PC', 'memory.read': 'Ler memórias', 'memory.write': 'Salvar memórias', 'lab.execute': 'Laboratório / testes', 'net.fetch': 'Internet', 'input.control': 'Mouse e teclado', 'terminal.exec': 'Terminal' };

function useMicPermission() {
  const [st, setSt] = useState<string>('desconhecido');
  useEffect(() => {
    navigator.permissions?.query({ name: 'microphone' as PermissionName }).then((p) => { setSt(p.state); p.onchange = () => setSt(p.state); }).catch(() => setSt('não informado pelo sistema'));
  }, []);
  return st;
}

export function SecurityView() {
  const { api, notify, approvals, decide, refreshTick } = useJarvis();
  const local = api.mode === 'local';
  const ov = useAsync(() => (local ? api.req<Overview>('/api/security/overview') : Promise.resolve(null)), [api, refreshTick], 10_000);
  const perms = useAsync(() => (local ? api.req<Perms>('/api/permissions') : Promise.resolve(null)), [api, refreshTick]);
  const audit = useAsync(() => (local ? api.req<Audit[]>('/api/audit?limit=120') : Promise.resolve([])), [api], 8000);
  const mic = useMicPermission();
  const [filter, setFilter] = useState('');
  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) notify('ok', ok); await ov.reload(); await perms.reload(); } catch (e) { notify('err', (e as Error).message); } };

  if (!local) return <RemoteSecurity mic={mic} />;
  const o = ov.data;
  const sens = o?.sensitiveScopes;
  const score = o ? [!o.emergencyStop, o.pendingApprovals === 0, o.deniedLast24h < 20, o.credentials.every((c) => !c.configured || !!c.protection)].filter(Boolean).length : 0;

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto space-y-5">
      {/* Indicadores */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Indicator icon={Lock} title="Sessão local" value="Protegida" tone="ok" detail={`Token local · só ${o?.session.boundTo ?? '127.0.0.1'}`} />
        <Indicator icon={Globe} title="Acesso remoto" value={o?.remote.enabled ? (o.remote.connected ? 'Ativo' : 'Desconectado') : 'Desligado'} tone={o?.remote.enabled ? 'warn' : 'ok'} detail={o?.remote.deviceId ? `Dispositivo ${o.remote.deviceId.slice(0, 8)}…` : 'Nenhum celular vinculado'} />
        <Indicator icon={Mic} title="Microfone" value={mic === 'granted' ? 'Permitido' : mic === 'denied' ? 'Bloqueado' : mic === 'prompt' ? 'Pergunta ao usar' : mic} tone={mic === 'denied' ? 'err' : 'neutral'} detail="Só é usado durante o Jarvis Voice" />
        <Indicator icon={History} title="Últimas 24 h" value={`${o?.actionsLast24h ?? 0} ações`} tone={o && o.deniedLast24h > 0 ? 'warn' : 'neutral'} detail={`${o?.deniedLast24h ?? 0} bloqueadas por permissão · ${score}/4 verificações ok`} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="space-y-5 min-w-0">
          <Panel title="O que o Jarvis pode fazer neste PC" icon={<ShieldCheck className="size-4" />} actions={
            <div className="flex items-center gap-2 text-[12px]"><span className="text-dim hidden sm:inline">Confirmações</span>
              <Select value={perms.data?.approvalMode ?? 'balanced'} onChange={(v) => act(() => api.req('/api/settings', { method: 'POST', json: { approvalMode: v } }), 'Política atualizada')} options={[{ value: 'balanced', label: 'Só ações sensíveis' }, { value: 'strict', label: 'Toda alteração' }]} /></div>
          }>
            <div className="grid sm:grid-cols-2 gap-x-6">
              {perms.data?.scopes.map((s) => (
                <div key={s} className="flex items-center gap-3 py-2 border-b border-line">
                  <span className="flex-1 text-[13px]">{SCOPE[s] ?? s}<span className="ml-2 font-mono text-[10px] text-dim">{s}</span></span>
                  <span className="text-[10px] text-dim">PC</span>
                  <Toggle label={`${s} no PC`} checked={!!perms.data?.grants.local?.includes(s)} onChange={(v) => act(() => api.req('/api/permissions/scopes', { method: 'POST', json: { scope: s, origin: 'local', enabled: v } }))} />
                  <span className="text-[10px] text-dim">celular</span>
                  <Toggle label={`${s} pelo celular`} checked={!!perms.data?.grants.remote?.includes(s)} onChange={(v) => act(() => api.req('/api/permissions/scopes', { method: 'POST', json: { scope: s, origin: 'remote', enabled: v } }))} />
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11.5px] text-dim">Exclusões, fechar apps, comandos destrutivos e qualquer ação de risco alto sempre pedem confirmação, e só podem ser confirmados neste computador.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a href="#/desktop"><Button size="sm" icon={<FolderOpen className="size-3.5" />}>{o?.roots ?? 0} pastas liberadas</Button></a>
              <a href="#/desktop"><Button size="sm" icon={<AppWindow className="size-3.5" />}>{o?.apps ?? 0} apps liberados</Button></a>
              {sens?.terminal && <Badge tone="warn"><TerminalSquare className="size-3" />terminal liberado</Badge>}
              {sens?.inputControl && <Badge tone="warn"><MousePointerClick className="size-3" />mouse e teclado liberados</Badge>}
              {sens?.screenCapture && <Badge><Camera className="size-3" />captura de tela liberada</Badge>}
            </div>
          </Panel>

          <Panel title="Histórico de atividades e acessos" icon={<History className="size-4" />} actions={<input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar…" className="h-7 w-36 rounded-md bg-black/30 border border-line px-2 text-[12px] outline-none" aria-label="Filtrar log" />}>
            {!audit.data?.length ? <Empty title="Sem eventos ainda" /> : (
              <ul className="max-h-80 overflow-y-auto scroll-thin divide-y divide-[var(--color-line)] text-[12px]">
                {audit.data.filter((a) => !filter || (a.kind + a.detail).toLowerCase().includes(filter.toLowerCase())).map((a) => (
                  <li key={a.id} className="flex gap-3 py-1.5">
                    <span className="text-dim whitespace-nowrap w-24">{fmtTime(a.created_at)}</span>
                    <span className={cx('font-mono whitespace-nowrap', /denied|stop|revok|remove/.test(a.kind) ? 'text-err' : /grant|add|set|pair/.test(a.kind) ? 'text-amber' : 'text-orange-soft')}>{a.kind}</span>
                    <span className="text-dim">{a.origin === 'remote' ? 'celular' : a.origin === 'local' ? 'PC' : a.origin}</span>
                    <span className="truncate text-muted">{a.detail === '{}' ? '' : a.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-5 min-w-0">
          <Panel title="Controle imediato" icon={<OctagonX className="size-4" />}>
            <p className="text-[12.5px] text-muted">A parada de emergência interrompe todas as tarefas, nega confirmações pendentes e bloqueia qualquer ação até você retomar.</p>
            <div className="mt-3 flex gap-2 flex-wrap">
              <Button variant="danger" icon={<OctagonX className="size-4" />} onClick={() => act(() => api.emergencyStop(), 'Parada acionada')}>Parar tudo agora</Button>
              {o?.emergencyStop && <Button icon={<Play className="size-4" />} onClick={() => act(() => api.req('/api/emergency/resume', { method: 'POST' }), 'Operação retomada')}>Retomar</Button>}
              {o?.remote.enabled && <Button variant="ghost" icon={<Globe className="size-4" />} onClick={() => act(() => api.req('/api/relay/enable', { method: 'POST', json: { on: false } }), 'Acesso remoto desligado')}>Desligar acesso remoto</Button>}
            </div>
          </Panel>
          <Panel title={`Confirmações pendentes (${approvals.length})`} icon={<ShieldAlert className="size-4" />}>
            {!approvals.length ? <p className="text-[12.5px] text-dim">Nada aguardando você.</p> : approvals.map((a) => (
              <div key={a.id} className="flex items-center gap-2 py-1.5"><span className="font-mono text-[12px] flex-1 truncate">{a.tool}</span><Badge tone="warn">{a.risk}</Badge><Button size="sm" variant="primary" onClick={() => decide(a.id, true)}>Permitir</Button><Button size="sm" variant="ghost" onClick={() => decide(a.id, false)}>Negar</Button></div>
            ))}
          </Panel>
          <Panel title="Credenciais protegidas" icon={<KeyRound className="size-4" />}>
            <p className="text-[12px] text-dim">Chaves de API ficam criptografadas pelo Windows (DPAPI) e nunca voltam para a interface.</p>
            <ul className="mt-2 space-y-1.5">
              {o?.credentials.map((c) => (
                <li key={c.name} className="flex items-center gap-2 text-[12.5px]">
                  <span className="flex-1 font-mono">{c.name}</span>
                  {c.configured ? <Badge tone="ok"><Lock className="size-3" />{c.protection}</Badge> : <Badge>não configurada</Badge>}
                  {c.configured && <button aria-label={`Remover ${c.name}`} onClick={() => confirm('Remover esta chave?') && act(() => api.req(`/api/credentials/${c.name}`, { method: 'DELETE' }), 'Chave removida')} className="text-dim hover:text-err"><Trash2 className="size-3.5" /></button>}
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Dispositivos e privacidade" icon={<MonitorSmartphone className="size-4" />}>
            <ul className="text-[12.5px] text-muted space-y-1.5">
              <li>• Conteúdo de pastas nunca é enviado para a nuvem. Pelo celular só aparecem conversas iniciadas lá e memórias que você marcar.</li>
              <li>• O PC abre apenas uma conexão de saída (HTTPS) com o relay; nenhuma porta é exposta.</li>
              <li>• Capturas de tela só acontecem por pedido, com aviso visível.</li>
            </ul>
            <div className="mt-3 flex gap-2"><a href="#/settings/devices"><Button size="sm">Gerenciar dispositivos</Button></a><a href="#/settings/memory"><Button size="sm" variant="ghost">Privacidade da memória</Button></a></div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Indicator({ icon: Icon, title, value, detail, tone }: { icon: typeof Lock; title: string; value: string; detail: string; tone: 'ok' | 'warn' | 'err' | 'neutral' }) {
  return (
    <div className="surface rounded-2xl p-4">
      <div className="flex items-center gap-2 text-[12px] text-dim"><Icon className="size-3.5" />{title}</div>
      <div className={cx('mt-2 font-display text-[20px] font-semibold', tone === 'ok' && 'text-ok', tone === 'warn' && 'text-amber', tone === 'err' && 'text-err')}>{value}</div>
      <div className="text-[11.5px] text-dim mt-0.5 truncate">{detail}</div>
    </div>
  );
}

function RemoteSecurity({ mic }: { mic: string }) {
  const { api, notify, approvals, decide } = useJarvis();
  const [user, setUser] = useState<{ name: string; last: string | null } | null>(null);
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => { void supabase().auth.getUser().then((u) => setUser({ name: u.data.user?.email?.replace(/@u\.jarvisultra\.app$/, '') ?? '', last: u.data.user?.last_sign_in_at ?? null })); }, []);
  return (
    <div className="p-4 sm:p-6 max-w-[900px] mx-auto space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Indicator icon={Lock} title="Sessão" value={user?.name || '—'} tone="ok" detail={`Último acesso ${user?.last ? fmtTime(user.last) : '—'}`} />
        <Indicator icon={Mic} title="Microfone" value={mic === 'granted' ? 'Permitido' : mic === 'denied' ? 'Bloqueado' : 'Pergunta ao usar'} tone={mic === 'denied' ? 'err' : 'neutral'} detail="Usado só no Jarvis Voice" />
        <Indicator icon={ShieldAlert} title="Confirmações" value={String(approvals.length)} tone={approvals.length ? 'warn' : 'neutral'} detail="Ações aguardando você" />
      </div>
      <Panel title="Controle" icon={<OctagonX className="size-4" />}>
        <p className="text-[12.5px] text-muted">Permissões, pastas e apps só podem ser alterados no próprio computador. Daqui você pode parar tudo, confirmar ações de risco médio e encerrar sessões.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="danger" icon={<OctagonX className="size-4" />} onClick={() => api.emergencyStop().then(() => notify('ok', 'Parada enviada'), (e) => notify('err', e.message))}>Parada de emergência</Button>
          <Button onClick={() => confirm('Sair de todos os aparelhos?') && supabase().auth.signOut({ scope: 'global' })}>Encerrar todas as sessões</Button>
          <Button variant="ghost" icon={<KeyRound className="size-4" />} onClick={async () => { const r = await supabase().rpc('jarvis_new_recovery_code'); if (r.error) notify('err', r.error.message); else setCode((r.data as { recovery_code: string }).recovery_code); }}>Gerar novo código de recuperação</Button>
        </div>
        {code && <div className="mt-3 rounded-xl border border-amber/30 bg-amber/[0.06] p-3 text-[13px]">Guarde este código: ele permite redefinir sua senha e não será mostrado de novo.<div className="mt-1.5 font-mono text-lg tracking-[0.2em] text-amber select-all">{code}</div></div>}
      </Panel>
      {approvals.length > 0 && <Panel title="Confirmações pendentes">{approvals.map((a) => <div key={a.id} className="flex items-center gap-2 py-1.5"><span className="font-mono text-[12px] flex-1">{a.tool}</span><Badge tone="warn">{a.risk}</Badge><Button size="sm" variant="primary" onClick={() => decide(a.id, true)}>Permitir</Button><Button size="sm" variant="ghost" onClick={() => decide(a.id, false)}>Negar</Button></div>)}</Panel>}
    </div>
  );
}
