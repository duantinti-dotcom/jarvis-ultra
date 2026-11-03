'use client';
import { useEffect, useState } from 'react';
import { Smartphone, Link2, Unlink, ShieldOff, LogOut, KeyRound, RefreshCw } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { Panel, Badge, Button, Input, Toggle, ErrorNote, Empty, fmtAgo, fmtTime } from '@/components/ui';
import { createPairingCode, listDevices, revokeDevice, isOnline, supabase, SUPABASE_URL, SUPABASE_ANON } from '@/lib/remote';

/** Lado web: gera o código que o usuário digita no app do PC. */
export function PairingPanel({ onPaired }: { onPaired?: () => void }) {
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!code) return;
    const t = setInterval(async () => {
      const s = Math.max(0, Math.round((new Date(code.expires_at).getTime() - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setCode(null);
      const devs = await listDevices().catch(() => []);
      if (devs.some((d) => Date.now() - new Date(d.created_at).getTime() < 15 * 60_000 && !d.revoked_at)) { setCode(null); onPaired?.(); }
    }, 3000);
    return () => clearInterval(t);
  }, [code, onPaired]);
  return (
    <Panel title="Vincular um computador" icon={<Link2 className="size-4" />}>
      <ol className="text-[12.5px] text-muted list-decimal ml-4 space-y-1">
        <li>Gere um código aqui (vale 10 minutos, uso único).</li>
        <li>No PC, abra Lume → Device Center → “Vincular a este site”.</li>
        <li>Cole o endereço do relay, a chave pública e o código.</li>
      </ol>
      {code ? (
        <div className="mt-4 text-center">
          <div className="font-mono text-3xl tracking-[0.35em] text-accent glow-text select-all">{code.code}</div>
          <div className="text-[11px] text-dim mt-1">expira em {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · aguardando o PC…</div>
          <div className="mt-3 rounded-xl bg-black/40 p-2.5 text-left text-[10.5px] font-mono text-muted break-all select-all">Relay: {SUPABASE_URL}<br />Chave pública: {SUPABASE_ANON}</div>
        </div>
      ) : <Button className="mt-4 w-full" variant="primary" icon={<KeyRound className="size-4" />} onClick={async () => { try { setErr(null); setCode(await createPairingCode()); } catch (e) { setErr((e as Error).message); } }}>Gerar código de vinculação</Button>}
      <div className="mt-2"><ErrorNote error={err} /></div>
    </Panel>
  );
}

export function DevicesView() {
  const { api } = useJarvis();
  return api.mode === 'local' ? <LocalDevice /> : <RemoteDevices />;
}

function RemoteDevices() {
  const { notify } = useJarvis();
  const devs = useAsync(() => listDevices(), [], 5000);
  const [email, setEmail] = useState('');
  useEffect(() => { void supabase().auth.getUser().then((u) => setEmail(u.data.user?.email?.replace(/@u\.jarvisultra\.app$/, '') ?? '')); }, []);
  return (
    <div className="p-3 sm:p-5 max-w-[1200px] mx-auto grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Panel title="Dispositivos vinculados" icon={<Smartphone className="size-4" />} actions={<Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => devs.reload()}>Atualizar</Button>}>
        <ErrorNote error={devs.error} />
        {!devs.data?.length ? <Empty title="Nenhum computador vinculado" /> : (
          <ul className="space-y-2">
            {devs.data.map((d) => (
              <li key={d.id} className="rounded-xl border border-line p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{d.name}</span><span className="text-[11px] text-dim">{d.platform}</span>
                  <span className="ml-auto">{d.revoked_at ? <Badge tone="err">revogado</Badge> : isOnline(d) ? <Badge tone="ok" pulse>online</Badge> : <Badge>offline</Badge>}</span>
                </div>
                <div className="mt-1 text-[11.5px] text-dim">vinculado {fmtTime(d.created_at)} · última atividade {fmtAgo(d.last_seen_at)}{d.status ? ` · ${d.status.model ?? 'sem modelo'} · ${d.status.activeTasks} tarefas` : ''}</div>
                {!d.revoked_at && (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => { localStorage.setItem('jarvis.device', d.id); location.reload(); }}>Usar este</Button>
                    <Button size="sm" variant="danger" icon={<ShieldOff className="size-3.5" />} onClick={async () => { if (!confirm(`Revogar ${d.name}? Novos comandos deixarão de ser aceitos imediatamente.`)) return; try { await revokeDevice(d.id); notify('ok', 'Dispositivo revogado'); void devs.reload(); } catch (e) { notify('err', (e as Error).message); } }}>Revogar</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <div className="space-y-4">
        <Panel title="Conectar outro computador" icon={<Link2 className="size-4" />}>
          <p className="text-[12.5px] text-muted">No app Lume do computador, abra <b>Configurações → Dispositivos</b> e entre com este mesmo usuário e senha. Ele aparece aqui na hora.</p>
        </Panel>
        <Panel title="Sessão" icon={<LogOut className="size-4" />}>
          <p className="text-[12.5px] text-muted">Conectado como <b className="text-fg">{email}</b>.</p>
          <div className="mt-3 flex gap-2 flex-wrap">
            <Button size="sm" onClick={() => supabase().auth.signOut()}>Sair deste aparelho</Button>
            <Button size="sm" variant="danger" onClick={() => confirm('Encerrar todas as sessões em todos os aparelhos?') && supabase().auth.signOut({ scope: 'global' })}>Encerrar todas as sessões</Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function LocalDevice() {
  const { api, status, refreshStatus, notify } = useJarvis();
  const url = SUPABASE_URL;
  const anon = SUPABASE_ANON;
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const relay = status?.relay;
  const pair = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.req('/api/relay/login', { method: 'POST', json: { url, anonKey: anon, username: user, password: pass } });
      setPass('');
      notify('ok', 'Computador conectado ao site');
      await refreshStatus();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="p-3 sm:p-5 max-w-[1100px] mx-auto grid gap-4 md:grid-cols-2">
      <Panel title="Este computador" icon={<Smartphone className="size-4" />}>
        <div className="space-y-1.5 text-[12.5px]">
          <div className="flex justify-between"><span className="text-muted">Nome</span><span>{status?.device?.hostname}</span></div>
          <div className="flex justify-between"><span className="text-muted">Plataforma</span><span>{status?.device?.platform}</span></div>
          <div className="flex justify-between"><span className="text-muted">Core</span><span>v{status?.device?.coreVersion}</span></div>
          <div className="flex justify-between items-center"><span className="text-muted">Acesso remoto</span>
            {relay?.config ? <Toggle label="Acesso remoto" checked={relay.enabled} onChange={async (on) => { await api.req('/api/relay/enable', { method: 'POST', json: { on } }); await refreshStatus(); }} /> : <Badge>não vinculado</Badge>}
          </div>
          {relay?.config && <>
            <div className="flex justify-between"><span className="text-muted">ID do dispositivo</span><span className="font-mono text-[11px]">{relay.config.deviceId.slice(0, 8)}…</span></div>
            <div className="flex justify-between"><span className="text-muted">Vinculado em</span><span>{fmtTime(relay.config.pairedAt)}</span></div>
            <div className="flex justify-between"><span className="text-muted">Canal</span><span>{relay.connected ? <Badge tone="ok" pulse>conectado · {fmtAgo(relay.lastSyncAt)}</Badge> : <Badge tone="warn">{relay.lastError ?? 'desconectado'}</Badge>}</span></div>
          </>}
        </div>
        {relay?.config && <Button className="mt-4" variant="danger" size="sm" icon={<Unlink className="size-3.5" />} onClick={async () => { if (!confirm('Desvincular este PC do site? A credencial local será apagada.')) return; await api.req('/api/relay/unpair', { method: 'POST' }); await refreshStatus(); }}>Desvincular</Button>}
        <p className="mt-3 text-[11px] text-dim">O PC abre apenas uma conexão de saída (HTTPS) para o relay. Nenhuma porta é exposta à internet. A credencial do dispositivo fica protegida pelo Windows (DPAPI).</p>
      </Panel>
      {!relay?.config && (
        <Panel title="Conectar ao celular e ao site" icon={<Link2 className="size-4" />}>
          <p className="text-[12.5px] text-muted">Entre com o mesmo usuário e senha do site. Pronto: o site e o celular passam a ver este computador. A senha é usada só agora e não fica salva.</p>
          <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); void pair(); }}>
            <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="Usuário" autoComplete="username" autoCapitalize="none" aria-label="Usuário" />
            <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Senha" autoComplete="current-password" aria-label="Senha" />
            <ErrorNote error={err} />
            <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={!user || pass.length < 8 || !url || !anon}>Conectar</Button>
          </form>
          {(!url || !anon) && <p className="mt-2 text-[11.5px] text-err">Esta versão do app não tem o endereço do relay configurado.</p>}
        </Panel>
      )}
    </div>
  );
}
