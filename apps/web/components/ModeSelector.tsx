'use client';
import { Zap, Scale, Brain } from 'lucide-react';
import type { ReasoningMode } from '@/lib/types';
import { cx } from './ui';

export const MODE_INFO: Record<ReasoningMode, { label: string; icon: typeof Zap; desc: string }> = {
  fast: { label: 'Rápido', icon: Zap, desc: 'Menor latência: sem classificador, memória por palavras-chave, modelo mais leve instalado e respostas mais curtas.' },
  balanced: { label: 'Equilibrado', icon: Scale, desc: 'Roteamento inteligente, memória semântica e ferramentas. Ideal para o dia a dia e programação.' },
  deep: { label: 'Profundo', icon: Brain, desc: 'Sempre planeja antes de agir, usa o maior modelo que cabe na memória, ativa raciocínio estendido quando o modelo suporta e audita o resultado.' },
};

export function ModeSelector({ value, onChange, compact }: { value: ReasoningMode; onChange: (m: ReasoningMode) => void; compact?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Nível de raciocínio" className="inline-flex items-center rounded-lg bg-white/[0.04] p-0.5 border border-line">
      {(Object.keys(MODE_INFO) as ReasoningMode[]).map((m) => {
        const I = MODE_INFO[m].icon;
        const on = value === m;
        return (
          <button key={m} role="radio" aria-checked={on} title={MODE_INFO[m].desc} onClick={() => onChange(m)}
            className={cx('press flex items-center gap-1.5 rounded-md h-7 text-[12px]', compact ? 'px-2' : 'px-2.5', on ? 'bg-gradient-to-b from-accent/25 to-accent/10 text-fg shadow-[inset_0_0_0_1px_rgba(52,211,153,0.35)]' : 'text-dim hover:text-muted')}>
            <I className={cx('size-3.5', on && 'text-accent-glow')} />
            {!compact && MODE_INFO[m].label}
          </button>
        );
      })}
    </div>
  );
}
