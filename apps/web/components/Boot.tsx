'use client';
import { useEffect, useState } from 'react';
import { discoverLocal, createLocalApi } from '@/lib/local';
import { remoteConfigured, supabase, listDevices, createHybridApi, isOnline } from '@/lib/remote';
import type { JarvisApi, Device } from '@/lib/types';
import { JarvisProvider } from '@/lib/store';
import { Shell } from './Shell';
import { LumeMark } from './ui';
import { MessageSquare, Code2, AudioLines } from 'lucide-react';
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
    if (chosen) setSt({ kind: 'ready', api: createHybridApi(chosen.id), device: chosen });
    else if (!devices.length) setSt({ kind: 'ready', api: createHybridApi(null) });
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
  const features = [
    { icon: MessageSquare, title: 'Chat inteligente', text: 'Respostas em segundos, com raciocínio, código formatado e criação de imagens.' },
    { icon: Code2, title: 'Lume Code', text: 'Descreva um site ou app: a Lume planeja o design, escreve o código e mostra o preview.' },
    { icon: AudioLines, title: 'Voz', text: 'Converse falando, com transcrição e voz natural.' },
  ];
  return (
    <main className="h-dvh overflow-y-auto scroll-thin">
      <div className="min-h-full grid lg:grid-cols-[1.1fr_1fr]">
        <section className="flex flex-col justify-center px-6 sm:px-12 py-10 lg:py-16 border-b lg:border-b-0 lg:border-r border-line">
          <div className="flex items-center gap-3 enter"><LumeMark className="size-10" /><span className="font-display text-[22px] font-semibold tracking-tight">Lume<span className="text-accent-glow"> IA</span></span></div>
          <h1 className="enter mt-10 font-display text-[32px] sm:text-[42px] leading-[1.08] font-semibold tracking-tight max-w-xl" style={{ animationDelay: '60ms' }}>Converse, crie e publique com uma IA que <span className="text-accent-glow">entrega pronto</span>.</h1>
          <p className="enter mt-4 text-[15px] text-muted max-w-lg" style={{ animationDelay: '120ms' }}>Uma plataforma só para conversar, criar sites e apps completos com preview ao vivo e falar por voz.</p>
          <ul className="mt-10 space-y-5 max-w-lg">
            {features.map((f, i) => (
              <li key={f.title} className="enter flex gap-3.5" style={{ animationDelay: `${180 + i * 60}ms` }}>
                <span className="grid place-items-center size-9 shrink-0 rounded-lg border border-line bg-white/[0.02]"><f.icon className="size-[17px] text-accent-glow" /></span>
                <div><div className="text-[14px] font-medium">{f.title}</div><div className="text-[13px] text-dim mt-0.5">{f.text}</div></div>
              </li>
            ))}
          </ul>
        </section>
        <section className="flex flex-col justify-center px-6 sm:px-12 py-10">
          <div className="w-full max-w-sm mx-auto enter" style={{ animationDelay: '100ms' }}>
            {st.kind === 'loading' && <div className="flex items-center justify-center gap-2 text-muted text-sm"><span className="size-4 rounded-full border-2 border-accent/30 border-t-accent animate-spin" />Conectando…</div>}
            {st.kind === 'login' && <Login onDone={() => resolveRemote()} />}
            {st.kind === 'pick' && <Pick devices={st.devices} onPick={(d) => { localStorage.setItem('jarvis.device', d.id); setSt({ kind: 'ready', api: createHybridApi(d.id), device: d }); }} onRefresh={resolveRemote} />}
            {st.kind === 'unconfigured' && (
              <div className="surface-raised rounded-2xl p-5 text-sm text-muted space-y-2">
                <p className="text-fg font-medium">Nenhum núcleo encontrado.</p>
                <p>No computador, abra o aplicativo <b>Lume IA</b>. Para usar pelo navegador, este site precisa das variáveis <code>NEXT_PUBLIC_SUPABASE_URL</code> e <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>.</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

/** Usuário vira um e-mail técnico interno (nunca recebe mensagens). */
export const usernameToEmail = (u: string) => `${u.trim().toLowerCase()}@u.jarvisultra.app`;

function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'in' | 'up' | 'reset'>('in');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const sb = supabase();
    try {
      if (mode === 'up' || mode === 'reset') {
        const r = mode === 'up'
          ? await sb.rpc('jarvis_register', { p_username: username, p_password: password })
          : await sb.rpc('jarvis_reset_password', { p_username: username, p_code: code, p_new_password: password });
        if (r.error) throw new Error(r.error.message);
        const d = r.data as { ok: boolean; error?: string; recovery_code?: string };
        if (!d.ok) throw new Error(d.error ?? 'Não foi possível concluir.');
        if (d.recovery_code) setRecovery(d.recovery_code);
      }
      const r = await sb.auth.signInWithPassword({ email: usernameToEmail(username), password });
      if (r.error) throw new Error(/invalid login/i.test(r.error.message) ? 'Usuário ou senha incorretos.' : /rate|too many/i.test(r.error.message) ? 'Muitas tentativas. Aguarde alguns minutos.' : r.error.message);
      if (mode === 'in') onDone();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (recovery) {
    return (
      <div className="surface-raised rounded-2xl p-5 space-y-3">
        <div className="font-display text-lg">Guarde seu código de recuperação</div>
        <p className="text-[13px] text-muted">Ele permite redefinir sua senha sem e-mail. Anote ou salve em local seguro: ele não será mostrado de novo.</p>
        <div className="rounded-xl border border-warn/30 bg-warn/[0.06] p-3 text-center font-mono text-xl tracking-[0.2em] text-warn select-all">{recovery}</div>
        <Button variant="subtle" className="w-full" onClick={() => void navigator.clipboard.writeText(recovery)}>Copiar código</Button>
        <Button variant="primary" className="w-full" onClick={onDone}>Já guardei, entrar na Lume</Button>
      </div>
    );
  }
  const title = mode === 'in' ? 'Entrar' : mode === 'up' ? 'Criar conta' : 'Redefinir senha';
  return (
    <form onSubmit={submit} className="surface-raised rounded-2xl p-5 space-y-3">
      <div className="font-display text-lg">{title}</div>
      <Input required autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="Usuário" value={username} onChange={(e) => setUsername(e.target.value)} aria-label="Usuário" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,29}" title="3 a 30 letras, números, ponto, hífen ou sublinhado" />
      {mode === 'reset' && <Input required autoCapitalize="characters" spellCheck={false} placeholder="Código de recuperação (XXXX-XXXX-XXXX-XXXX)" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Código de recuperação" className="font-mono" />}
      <Input type="password" required minLength={8} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} placeholder={mode === 'reset' ? 'Nova senha (mín. 8)' : 'Senha (mín. 8 caracteres)'} value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Senha" />
      <ErrorNote error={err} />
      <Button type="submit" variant="primary" className="w-full" loading={busy}>{title}</Button>
      <div className="flex justify-between text-[12.5px]">
        <button type="button" className="text-muted hover:text-fg" onClick={() => { setErr(null); setMode(mode === 'in' ? 'up' : 'in'); }}>{mode === 'in' ? 'Criar conta' : 'Já tenho conta'}</button>
        {mode === 'in' && <button type="button" className="text-muted hover:text-fg" onClick={() => { setErr(null); setMode('reset'); }}>Esqueci a senha</button>}
      </div>
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
    <div className="surface-raised rounded-2xl p-4 space-y-2">
      <div className="font-display text-base mb-1">Escolha o computador</div>
      {devices.map((d) => (
        <button key={d.id} onClick={() => onPick(d)} className="w-full flex items-center gap-3 rounded-xl border border-line px-3 py-2.5 hover:border-accent/40 text-left">
          <span className="font-medium">{d.name}</span>
          <span className="text-dim text-xs">{d.platform}</span>
          <span className="ml-auto">{isOnline(d) ? <Badge tone="ok" pulse>online</Badge> : <Badge>offline · {fmtAgo(d.last_seen_at)}</Badge>}</span>
        </button>
      ))}
    </div>
  );
}
