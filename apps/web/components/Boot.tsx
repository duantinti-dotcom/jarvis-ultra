'use client';
import { useEffect, useState } from 'react';
import { discoverLocal, createLocalApi } from '@/lib/local';
import { remoteConfigured, supabase, listDevices, createRemoteApi, isOnline } from '@/lib/remote';
import type { JarvisApi, Device } from '@/lib/types';
import { JarvisProvider } from '@/lib/store';
import { Shell } from './Shell';
import { JarvisCore } from './JarvisCore';
import { Button, Input, ErrorNote, Badge, fmtAgo } from './ui';
import { PairingPanel } from '@/views/Devices';

type BootState =
  | { kind: 'loading' }
  | { kind: 'ready'; api: JarvisApi; device?: Device }
  | { kind: 'login' }
  | { kind: 'pick'; devices: Device[] }
  | { kind: 'unconfigured' };

export function Boot() {
  const [st, setSt] = useState<BootState>({ kind: 'loading' });

  const resolveRemote = async () => {
    const { data } = await supabase().auth.getSession();
    if (!data.session) return setSt({ kind: 'login' });
    const devices = (await listDevices()).filter((d) => !d.revoked_at);
    const saved = localStorage.getItem('jarvis.device');
    const chosen = devices.find((d) => d.id === saved) ?? (devices.length === 1 ? devices[0] : undefined);
    if (chosen) setSt({ kind: 'ready', api: createRemoteApi(chosen.id), device: chosen });
    else setSt({ kind: 'pick', devices });
  };

  useEffect(() => {
    (async () => {
      const local = await discoverLocal();
      if (local) return setSt({ kind: 'ready', api: createLocalApi(local.coreUrl, local.token) });
      if (!remoteConfigured()) return setSt({ kind: 'unconfigured' });
      await resolveRemote().catch(() => setSt({ kind: 'login' }));
      supabase().auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') setSt({ kind: 'login' }); });
    })();
  }, []);

  if (st.kind === 'ready') return <JarvisProvider api={st.api}><Shell device={st.device} /></JarvisProvider>;
  return (
    <main className="h-dvh overflow-y-auto scroll-thin">
      <div className="min-h-full flex flex-col items-center justify-center px-4 py-10">
        <JarvisCore state={st.kind === 'loading' ? 'thinking' : 'idle'} size={220} />
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-[0.2em] glow-text">JARVIS<span className="text-orange"> ULTRA</span></h1>
        <p className="label-tech mt-2">Orange Neural Interface</p>
        <div className="mt-8 w-full max-w-md">
          {st.kind === 'loading' && <p className="text-center text-muted text-sm">Conectando…</p>}
          {st.kind === 'login' && <Login onDone={() => resolveRemote()} />}
          {st.kind === 'pick' && <Pick devices={st.devices} onPick={(d) => { localStorage.setItem('jarvis.device', d.id); setSt({ kind: 'ready', api: createRemoteApi(d.id), device: d }); }} onRefresh={resolveRemote} />}
          {st.kind === 'unconfigured' && (
            <div className="glass rounded-2xl p-5 text-sm text-muted space-y-2">
              <p className="text-fg font-medium">Nenhum JARVIS Core encontrado.</p>
              <p>No computador, abra o aplicativo <b>JARVIS ULTRA</b>. Para usar pelo celular, este site precisa das variáveis <code>NEXT_PUBLIC_SUPABASE_URL</code> e <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> (veja docs/installation).</p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

/** Usuário vira um e-mail técnico interno (nunca recebe mensagens). */
export const usernameToEmail = (u: string) => `${u.trim().toLowerCase()}@u.jarvisultra.app`;

function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const sb = supabase();
    try {
      if (mode === 'up') {
        const r = await sb.rpc('jarvis_register', { p_username: username, p_password: password });
        if (r.error) throw new Error(r.error.message);
      }
      const r = await sb.auth.signInWithPassword({ email: usernameToEmail(username), password });
      if (r.error) throw new Error(r.error.message === 'Invalid login credentials' ? 'Usuário ou senha incorretos.' : r.error.message);
      onDone();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="glass rounded-2xl p-5 space-y-3">
      <div className="font-display text-lg">{mode === 'in' ? 'Entrar' : 'Criar conta'}</div>
      <Input required autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="Usuário" value={username} onChange={(e) => setUsername(e.target.value)} aria-label="Usuário" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,29}" title="3 a 30 letras, números, ponto, hífen ou sublinhado" />
      <Input type="password" required minLength={8} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} placeholder="Senha (mín. 8 caracteres)" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Senha" />
      <ErrorNote error={err} />
      <Button type="submit" variant="primary" className="w-full" loading={busy}>{mode === 'in' ? 'Entrar' : 'Criar conta'}</Button>
      <button type="button" className="w-full text-center text-[12.5px] text-muted hover:text-fg" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
        {mode === 'in' ? 'Não tem conta? Criar agora' : 'Já tenho conta'}
      </button>
    </form>
  );
}

function Pick({ devices, onPick, onRefresh }: { devices: Device[]; onPick: (d: Device) => void; onRefresh: () => void }) {
  if (!devices.length) return (
    <div className="space-y-3">
      <PairingPanel onPaired={onRefresh} />
      <Button variant="ghost" className="w-full" onClick={() => supabase().auth.signOut()}>Sair</Button>
    </div>
  );
  return (
    <div className="glass rounded-2xl p-4 space-y-2">
      <div className="font-display text-base mb-1">Escolha o computador</div>
      {devices.map((d) => (
        <button key={d.id} onClick={() => onPick(d)} className="w-full flex items-center gap-3 rounded-xl border border-line px-3 py-2.5 hover:border-orange/40 text-left">
          <span className="font-medium">{d.name}</span>
          <span className="text-dim text-xs">{d.platform}</span>
          <span className="ml-auto">{isOnline(d) ? <Badge tone="ok" pulse>online</Badge> : <Badge>offline · {fmtAgo(d.last_seen_at)}</Badge>}</span>
        </button>
      ))}
    </div>
  );
}
