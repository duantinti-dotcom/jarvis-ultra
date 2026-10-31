'use client';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Panel({ title, icon, actions, children, className, bodyClass }: { title?: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cx('glass rounded-2xl animate-fade-up min-w-0', className)}>
      {title && (
        <header className="flex items-center gap-2 px-4 pt-3.5 pb-2.5 border-b border-line">
          {icon && <span className="text-orange">{icon}</span>}
          <h2 className="font-display text-[13.5px] font-semibold tracking-wide text-fg/95">{title}</h2>
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={cx('p-4', bodyClass)}>{children}</div>
    </section>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'subtle'; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode };
export function Button({ variant = 'subtle', size = 'md', loading, icon, className, children, disabled, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all duration-150 select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange disabled:opacity-45 disabled:cursor-not-allowed active:scale-[0.98]',
        size === 'sm' ? 'h-8 px-3 text-[12.5px]' : 'h-10 px-4 text-[13.5px]',
        variant === 'primary' && 'bg-gradient-to-b from-orange to-[#e85d00] text-black hover:brightness-110 shadow-[0_8px_24px_-10px_rgba(255,109,10,0.8)]',
        variant === 'subtle' && 'bg-white/[0.05] border border-line hover:border-line-strong hover:bg-white/[0.08] text-fg',
        variant === 'ghost' && 'text-muted hover:text-fg hover:bg-white/[0.05]',
        variant === 'danger' && 'bg-err/12 text-err border border-err/30 hover:bg-err/20',
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Badge({ tone = 'neutral', children, className, pulse }: { tone?: 'neutral' | 'orange' | 'ok' | 'err' | 'warn'; children: ReactNode; className?: string; pulse?: boolean }) {
  const tones = {
    neutral: 'bg-white/[0.06] text-muted border-line',
    orange: 'bg-orange/12 text-orange-soft border-orange/25',
    ok: 'bg-ok/10 text-ok border-ok/25',
    err: 'bg-err/10 text-err border-err/25',
    warn: 'bg-warn/10 text-warn border-warn/25',
  };
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', tones[tone], className)}>
      {pulse && <span className={cx('size-1.5 rounded-full animate-pulse-soft', tone === 'ok' ? 'bg-ok' : tone === 'err' ? 'bg-err' : tone === 'warn' ? 'bg-warn' : 'bg-orange')} />}
      {children}
    </span>
  );
}

export function Stat({ label, value, unit, hint, tone }: { label: string; value: ReactNode; unit?: string; hint?: ReactNode; tone?: 'ok' | 'err' | 'warn' }) {
  return (
    <div className="min-w-0">
      <div className="label-tech">{label}</div>
      <div className={cx('mt-1 font-display text-2xl font-semibold tabular-nums', tone === 'ok' && 'text-ok', tone === 'err' && 'text-err', tone === 'warn' && 'text-warn')}>
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-muted">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 text-[11.5px] text-dim truncate">{hint}</div>}
    </div>
  );
}

export function Meter({ value, max = 100, tone = 'orange' }: { value: number; max?: number; tone?: 'orange' | 'ok' | 'err' }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full transition-[width] duration-700', tone === 'orange' ? 'bg-gradient-to-r from-orange to-orange-soft' : tone === 'ok' ? 'bg-ok' : 'bg-err')} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx('relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-40', checked ? 'bg-orange/80 border-orange' : 'bg-white/[0.06] border-line-strong')}>
      <span className={cx('absolute top-0.5 size-3.5 rounded-full bg-white transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx('h-10 w-full rounded-xl bg-black/30 border border-line px-3 text-[13.5px] placeholder:text-dim outline-none focus:border-orange/60 focus:ring-2 focus:ring-orange/15 transition', props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx('w-full rounded-xl bg-black/30 border border-line px-3 py-2.5 text-[13.5px] placeholder:text-dim outline-none focus:border-orange/60 focus:ring-2 focus:ring-orange/15 transition scroll-thin', props.className)} />;
}

export function Select({ value, onChange, options, className }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={cx('h-9 rounded-xl bg-black/30 border border-line px-2.5 text-[13px] outline-none focus:border-orange/60', className)}>
      {options.map((o) => <option key={o.value} value={o.value} className="bg-surface">{o.label}</option>)}
    </select>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-6 gap-2">
      {icon && <div className="text-dim mb-1">{icon}</div>}
      <div className="font-display text-[14px] text-fg/90">{title}</div>
      {children && <div className="text-[12.5px] text-muted max-w-md">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return <div role="alert" className="rounded-xl border border-err/30 bg-err/[0.07] px-3 py-2 text-[12.5px] text-err">{error}</div>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-line-strong bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10.5px] text-muted">{children}</kbd>;
}

export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtAgo = (iso: string | null | undefined) => {
  if (!iso) return 'nunca';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'agora';
  if (s < 60) return `${s}s atrás`;
  if (s < 3600) return `${Math.round(s / 60)} min atrás`;
  if (s < 86400) return `${Math.round(s / 3600)} h atrás`;
  return `${Math.round(s / 86400)} d atrás`;
};
export const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${(n / 1e3).toFixed(0)} KB`);
