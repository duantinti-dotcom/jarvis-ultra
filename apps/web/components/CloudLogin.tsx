'use client';
import { useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { cloudLogin } from '@/lib/cloudBridge';

/** App do PC: entra na conta Jarvis para usar a IA da nuvem no Jarvis Code. */
export function CloudLogin({ onDone, onLocal, title = 'Entre para criar sites', text = 'O Jarvis Code usa a IA da nuvem (a mesma do site), que cria sites completos. Entre com seu usuário e senha do Jarvis — só uma vez.' }: { onDone: () => void; onLocal?: () => void; title?: string; text?: string }) {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await cloudLogin(u, p); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="enter pt-4 max-w-sm">
      <div className="size-11 rounded-2xl grid place-items-center bg-gradient-to-br from-orange to-amber text-black"><Sparkles className="size-5" /></div>
      <h2 className="mt-4 font-display text-[20px]">{title}</h2>
      <p className="mt-1.5 text-[13px] text-muted">{text}</p>
      <div className="mt-4 space-y-2">
        <input value={u} onChange={(e) => setU(e.target.value)} placeholder="Usuário" autoComplete="username" className="w-full h-10 rounded-lg bg-black/30 border border-line px-3 text-[13px] outline-none focus:border-orange/50" />
        <input value={p} onChange={(e) => setP(e.target.value)} type="password" placeholder="Senha" autoComplete="current-password" onKeyDown={(e) => e.key === 'Enter' && void go()} className="w-full h-10 rounded-lg bg-black/30 border border-line px-3 text-[13px] outline-none focus:border-orange/50" />
        {err && <div className="text-[12px] text-err">{err}</div>}
        <button onClick={() => void go()} disabled={!u.trim() || !p || busy} className="press w-full h-10 rounded-lg bg-gradient-to-b from-orange to-[#e85d00] text-black text-[13px] font-medium disabled:opacity-40 flex items-center justify-center gap-2">{busy && <Loader2 className="size-4 animate-spin" />}Entrar</button>
        {onLocal && <button onClick={onLocal} className="w-full text-[11.5px] text-dim hover:text-muted">Usar o modelo do PC mesmo assim (mais fraco para sites)</button>}
      </div>
    </div>
  );
}
