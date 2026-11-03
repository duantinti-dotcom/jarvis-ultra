'use client';
import { useEffect, useState } from 'react';
import { MessageSquare, Code2, AudioLines, MonitorCog, ShieldCheck } from 'lucide-react';
import { Button, cx } from './ui';

const STEPS = [
  { icon: MessageSquare, title: 'Lume Chat', text: 'Pergunte qualquer coisa ou peça tarefas. Escolha o modo: Rápido para respostas diretas, Equilibrado para o dia a dia e Profundo para problemas difíceis.' },
  { icon: Code2, title: 'Lume Code', text: 'Abra um projeto de uma pasta liberada, edite com o editor integrado, veja diferenças, rode testes no terminal e peça ajuda à Lume no próprio projeto.' },
  { icon: AudioLines, title: 'Lume Voice', text: 'Clique em “Falar com Lume” e converse naturalmente. Você pode interromper a resposta falando. A voz natural é instalada com um clique em Configurações → Voz.' },
  { icon: MonitorCog, title: 'Desktop Control', text: 'Libere apps e pastas e acompanhe cada etapa das tarefas no Windows, com Pausar, Continuar e Parar. Ações destrutivas sempre pedem sua confirmação.' },
  { icon: ShieldCheck, title: 'Você no controle', text: 'No Security Center você vê e revoga tudo o que a Lume pode acessar. Ctrl+K abre a busca e os comandos rápidos.' },
];

export function Onboarding() {
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  useEffect(() => {
    try { if (!localStorage.getItem('jarvis.onboarded')) setOpen(true); } catch {}
    const reopen = () => { setI(0); setOpen(true); };
    window.addEventListener('jarvis:onboarding', reopen);
    return () => window.removeEventListener('jarvis:onboarding', reopen);
  }, []);
  if (!open) return null;
  const done = () => { try { localStorage.setItem('jarvis.onboarded', '1'); } catch {} setOpen(false); };
  const s = STEPS[i]!;
  const Icon = s.icon;
  return (
    <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm grid place-items-center px-4">
      <div role="dialog" aria-modal="true" aria-label="Boas-vindas à Lume" className="w-full max-w-md surface-raised rounded-2xl p-6 animate-fade-up">
        <div className="flex items-center gap-3">
          <span className="grid place-items-center size-11 rounded-xl bg-accent/[0.12] text-accent-glow"><Icon className="size-5" /></span>
          <div>
            <div className="label-tech">Passo {i + 1} de {STEPS.length}</div>
            <h2 className="font-display text-lg">{s.title}</h2>
          </div>
        </div>
        <p className="mt-4 text-[13.5px] text-muted leading-relaxed">{s.text}</p>
        <div className="mt-5 flex items-center gap-1.5">{STEPS.map((_, k) => <span key={k} className={cx('h-1 rounded-full transition-all', k === i ? 'w-6 bg-accent' : 'w-2 bg-white/15')} />)}</div>
        <div className="mt-5 flex gap-2">
          <Button variant="ghost" onClick={done}>Pular</Button>
          <Button variant="primary" className="ml-auto" onClick={() => (i < STEPS.length - 1 ? setI(i + 1) : done())}>{i < STEPS.length - 1 ? 'Próximo' : 'Começar'}</Button>
        </div>
      </div>
    </div>
  );
}
