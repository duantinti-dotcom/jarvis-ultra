'use client';
import { useEffect, useRef, useState } from 'react';
import { Phone, ArrowUp, Cpu, HardDrive, ListChecks, Zap, Clock, Bell, Gauge } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { JarvisCore, LABEL } from '@/components/JarvisCore';
import { Panel, Badge, Meter, Stat, Kbd, cx, fmtAgo } from '@/components/ui';
import type { CoreEvent } from '@jarvis/contracts';
import { TaskStateBadge } from './Tasks';

const QUICK = [
  { label: 'Como está meu PC?', text: 'Como está meu computador agora?' },
  { label: 'Arquivos modificados hoje', text: 'Quais arquivos foram modificados nas últimas 24 horas nas minhas pastas?' },
  { label: 'Abrir Bloco de Notas', text: 'Abra o Bloco de Notas' },
  { label: 'Planilha de tarefas', text: 'Crie uma planilha tarefas.xlsx com colunas Tarefa, Prazo, Prioridade e Status' },
  { label: 'Do que falamos ontem?', text: 'Do que estávamos falando ontem?' },
  { label: 'Meus projetos', text: 'Quais projetos estou desenvolvendo?' },
];

export function CommandCenter() {
  const { api, status, visual, chat, conn, onEvent } = useJarvis();
  const [text, setText] = useState('');
  const [feed, setFeed] = useState<{ at: number; text: string; tone: 'ok' | 'err' | 'orange' | 'neutral' }[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const tasks = useAsync(() => api.tasks(6), [api, chat.reloadList], 10_000);
  const live = useAsync(() => api.live(), [api], 6000);

  useEffect(() => onEvent((e: CoreEvent) => {
    const push = (t: string, tone: 'ok' | 'err' | 'orange' | 'neutral') => setFeed((f) => [{ at: Date.now(), text: t, tone }, ...f].slice(0, 8));
    if (e.type === 'tool.end') push(`${e.tool} — ${e.ok ? 'ok' : e.summary.slice(0, 80)}`, e.ok ? 'ok' : 'err');
    if (e.type === 'task.update' && ['completed', 'failed', 'cancelled'].includes(e.state)) push(`Tarefa ${e.state === 'completed' ? 'concluída' : e.state === 'failed' ? 'falhou' : 'cancelada'}`, e.state === 'completed' ? 'ok' : 'err');
    if (e.type === 'approval.request') push(`Aprovação pedida: ${e.tool}`, 'orange');
    if (e.type === 'intent') push(`Intenção: ${e.kind} → ${e.agent} (${e.ms} ms)`, 'neutral');
  }), [onEvent]);

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    await chat.open(null);
    await chat.send(t);
    location.hash = '#/chat';
  };
  const lv = live.data as { cpuPercent?: number; ramUsedGb?: number; ramTotalGb?: number; gpus?: { name: string; vramUsedMb: number | null; vramTotalMb: number | null; utilPercent: number | null }[]; jarvis?: { rssMb: number } } | null;
  const gpu = lv?.gpus?.[0];

  return (
    <div className="p-3 sm:p-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,1fr)] max-w-[1500px] mx-auto">
      {/* Coluna esquerda: estado */}
      <div className="space-y-4 order-2 xl:order-1">
        <Panel title="Estado do sistema" icon={<Gauge className="size-4" />}>
          <div className="grid grid-cols-2 gap-4">
            <Stat label="CPU" value={lv?.cpuPercent ?? status?.device?.cpuPercent ?? '—'} unit="%" />
            <Stat label="RAM" value={lv?.ramUsedGb ?? status?.device?.ramUsedGb ?? '—'} unit={`/ ${lv?.ramTotalGb ?? status?.device?.ramTotalGb ?? '—'} GB`} />
          </div>
          <div className="mt-3 space-y-2">
            <Meter value={lv?.cpuPercent ?? status?.device?.cpuPercent ?? 0} />
            <Meter value={lv?.ramUsedGb ?? 0} max={lv?.ramTotalGb ?? 1} />
          </div>
          <div className="mt-4 text-[12px] text-muted space-y-1.5">
            <div className="flex items-center gap-2"><HardDrive className="size-3.5 text-dim" />GPU: {gpu ? `${gpu.name}${gpu.vramTotalMb ? ` · VRAM ${gpu.vramUsedMb ?? '?'} / ${gpu.vramTotalMb} MB` : ''}` : status?.device?.gpu ?? 'não detectada'}</div>
            <div className="flex items-center gap-2"><Zap className="size-3.5 text-dim" />JARVIS: {lv?.jarvis?.rssMb ?? '—'} MB</div>
            <div className="flex items-center gap-2"><Clock className="size-3.5 text-dim" />Ativo há {status?.device ? Math.round(status.device.uptimeSec / 60) : '—'} min</div>
          </div>
        </Panel>
        <Panel title="Modelo" icon={<Cpu className="size-4" />}>
          {status?.device?.model ? (
            <div className="space-y-2">
              <div className="font-mono text-[13px] text-orange-soft break-all">{status.device.model}</div>
              <div className="flex flex-wrap gap-1.5">
                <Badge tone={status.device.modelLoaded ? 'ok' : 'neutral'} pulse={status.device.modelLoaded}>{status.device.modelLoaded ? 'carregado' : 'sob demanda'}</Badge>
                <Badge tone="orange">{status.device.profile}</Badge>
                {status.ollama?.version && <Badge>Ollama {status.ollama.version}</Badge>}
              </div>
              {status.selectedModel?.reason && <p className="text-[11.5px] text-dim">{status.selectedModel.reason}</p>}
            </div>
          ) : <p className="text-[12.5px] text-muted">{conn === 'online' ? 'Nenhum modelo disponível. Instale um no Model Manager.' : 'Computador offline.'}</p>}
        </Panel>
      </div>

      {/* Centro: núcleo + comando */}
      <div className="order-1 xl:order-2 flex flex-col items-center">
        <div className="relative mt-2">
          <JarvisCore state={visual} size={300} />
          <div className="absolute inset-x-0 bottom-3 text-center label-tech !text-orange/80">{LABEL[visual]}</div>
        </div>
        <a href="#/voice?auto=1" className="group mt-1 inline-flex items-center gap-2.5 rounded-full border border-orange/40 bg-orange/[0.08] pl-3 pr-5 h-12 font-display font-semibold tracking-[0.14em] text-[13px] hover:bg-orange/[0.16] hover:shadow-[0_0_40px_-8px_#ff6a00] transition">
          <span className="grid place-items-center size-8 rounded-full bg-orange text-black"><Phone className="size-4" /></span>
          LIGAR PARA JARVIS
        </a>
        <div className="mt-6 w-full glass rounded-2xl p-2 focus-within:border-orange/40">
          <div className="flex items-end gap-2">
            <textarea id="command-input" ref={inputRef} rows={2} value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }}
              placeholder="Diga ao JARVIS o que fazer…" aria-label="Comando para o JARVIS"
              className="flex-1 resize-none bg-transparent px-3 py-2 text-[14.5px] outline-none placeholder:text-dim" />
            <button onClick={submit} disabled={!text.trim()} aria-label="Enviar" className="mb-1 mr-1 grid place-items-center size-10 rounded-xl bg-orange text-black disabled:opacity-30 hover:bg-orange-glow transition">
              <ArrowUp className="size-5" />
            </button>
          </div>
          <div className="flex items-center gap-2 px-3 pb-1 pt-0.5 text-[11px] text-dim"><Kbd>Enter</Kbd> enviar · <Kbd>Ctrl K</Kbd> focar · <Kbd>Ctrl Shift V</Kbd> voz</div>
        </div>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {QUICK.map((q) => (
            <button key={q.label} onClick={async () => { await chat.open(null); await chat.send(q.text); location.hash = '#/chat'; }}
              className="rounded-full border border-line bg-white/[0.03] px-3 h-8 text-[12px] text-muted hover:text-fg hover:border-orange/40 transition">{q.label}</button>
          ))}
        </div>
      </div>

      {/* Direita: tarefas + atividade */}
      <div className="space-y-4 order-3">
        <Panel title="Tarefas recentes" icon={<ListChecks className="size-4" />} actions={<a href="#/tasks" className="text-[11.5px] text-muted hover:text-fg">ver todas</a>}>
          {!tasks.data?.length ? <p className="text-[12.5px] text-muted">{conn === 'online' ? 'Nenhuma tarefa ainda.' : 'Computador offline.'}</p> : (
            <ul className="space-y-2">
              {tasks.data.map((t) => (
                <li key={t.id} className="flex items-start gap-2">
                  <TaskStateBadge state={t.state} />
                  <div className="min-w-0">
                    <div className="text-[12.5px] truncate">{t.goal}</div>
                    <div className="text-[11px] text-dim">{fmtAgo(t.updatedAt)} · {t.origin === 'remote' ? 'remoto' : 'local'}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Atividade ao vivo" icon={<Bell className="size-4" />}>
          {!feed.length ? <p className="text-[12.5px] text-muted">Os eventos do agente aparecem aqui em tempo real.</p> : (
            <ul className="space-y-1.5">
              {feed.map((f) => (
                <li key={f.at + f.text} className="flex items-center gap-2 text-[12px] animate-fade-up">
                  <span className={cx('size-1.5 rounded-full shrink-0', f.tone === 'ok' ? 'bg-ok' : f.tone === 'err' ? 'bg-err' : f.tone === 'orange' ? 'bg-orange' : 'bg-dim')} />
                  <span className="truncate text-muted">{f.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
