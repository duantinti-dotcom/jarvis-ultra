'use client';
import { useEffect, useRef, useState } from 'react';
import { Activity, Cpu, MemoryStick, MonitorSmartphone, Timer, Wifi } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { Panel, Stat, Meter, Badge, fmtAgo } from '@/components/ui';

type Live = { cpuPercent: number; ramUsedGb: number; ramTotalGb: number; gpus: { name: string; vramTotalMb: number | null; vramUsedMb: number | null; utilPercent: number | null }[]; jarvis: { rssMb: number; heapMb: number }; uptimeSec: number; activeTasks?: number; ollamaLoaded?: { name: string; size: number; size_vram: number }[] };

function Spark({ data, max = 100 }: { data: number[]; max?: number }) {
  const w = 240, h = 48;
  const pts = data.map((v, i) => `${(i / Math.max(1, data.length - 1)) * w},${h - (Math.min(v, max) / max) * (h - 4) - 2}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-12" preserveAspectRatio="none" aria-hidden>
      <defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ff6a00" stopOpacity=".35" /><stop offset="1" stopColor="#ff6a00" stopOpacity="0" /></linearGradient></defs>
      {data.length > 1 && <><polygon points={`0,${h} ${pts} ${w},${h}`} fill="url(#sg)" /><polyline points={pts} fill="none" stroke="#ff8c32" strokeWidth="1.6" vectorEffect="non-scaling-stroke" /></>}
    </svg>
  );
}

export function MonitorView() {
  const { api, status, conn } = useJarvis();
  const [hist, setHist] = useState<{ cpu: number[]; ram: number[]; vram: number[] }>({ cpu: [], ram: [], vram: [] });
  const live = useAsync(() => api.live() as Promise<Live | null>, [api], api.mode === 'local' ? 2000 : 6000);
  const metrics = useAsync(() => (api.mode === 'local' ? api.req<{ value: string; created_at: string }[]>('/api/metrics?kind=generation&limit=40') : Promise.resolve([])), [api], 10_000);
  const voice = useAsync(() => (api.mode === 'local' ? api.req<{ value: string }[]>('/api/metrics?kind=voice&limit=20') : Promise.resolve([])), [api], 15_000);
  const last = useRef<Live | null>(null);
  useEffect(() => {
    const d = live.data;
    if (!d || d === last.current) return;
    last.current = d;
    const g = d.gpus[0];
    setHist((h) => ({ cpu: [...h.cpu, d.cpuPercent].slice(-60), ram: [...h.ram, (d.ramUsedGb / d.ramTotalGb) * 100].slice(-60), vram: [...h.vram, g?.vramTotalMb ? ((g.vramUsedMb ?? 0) / g.vramTotalMb) * 100 : 0].slice(-60) }));
  }, [live.data]);
  const d = live.data;
  const g = d?.gpus[0];
  const gens = (metrics.data ?? []).map((m) => JSON.parse(m.value) as { timeToFirstTokenMs: number | null; tokensPerSecond: number | null; totalMs: number; model: string });
  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const vm = (voice.data ?? []).map((m) => JSON.parse(m.value) as { sttMs: number | null; firstAudioMs: number | null });

  return (
    <div className="p-3 sm:p-5 max-w-[1400px] mx-auto grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Panel title="CPU" icon={<Cpu className="size-4" />}><Stat label="uso" value={d?.cpuPercent ?? '—'} unit="%" /><Spark data={hist.cpu} /></Panel>
      <Panel title="RAM" icon={<MemoryStick className="size-4" />}><Stat label="em uso" value={d?.ramUsedGb ?? '—'} unit={`/ ${d?.ramTotalGb ?? '—'} GB`} /><Spark data={hist.ram} /></Panel>
      <Panel title="GPU / VRAM" icon={<MonitorSmartphone className="size-4" />}>
        {g ? <><Stat label={g.name} value={g.vramUsedMb ?? '—'} unit={`/ ${g.vramTotalMb ?? '—'} MB`} hint={g.utilPercent != null ? `utilização ${g.utilPercent}%` : 'utilização indisponível'} /><Spark data={hist.vram} /></> : <p className="text-[12.5px] text-muted">Nenhuma GPU detectada (nvidia-smi indisponível). A inferência roda na CPU.</p>}
      </Panel>
      <Panel title="Lume" icon={<Activity className="size-4" />}>
        <div className="grid grid-cols-2 gap-3"><Stat label="processo" value={d?.jarvis.rssMb ?? '—'} unit="MB" /><Stat label="tarefas ativas" value={d?.activeTasks ?? status?.device?.activeTasks ?? '—'} /></div>
        <div className="mt-3 text-[11.5px] text-dim">Ativo há {d ? Math.round(d.uptimeSec / 60) : '—'} min</div>
      </Panel>

      <Panel title="Latência real do modelo (últimas 40 respostas)" icon={<Timer className="size-4" />} className="md:col-span-2">
        {!gens.length ? <p className="text-[12.5px] text-muted">{api.mode === 'local' ? 'Converse com a Lume para gerar medições.' : 'Disponível no app do computador.'}</p> : (
          <>
            <div className="grid grid-cols-3 gap-4">
              <Stat label="TTFT mediano" value={med(gens.map((x) => x.timeToFirstTokenMs ?? 0).filter(Boolean)) ?? '—'} unit="ms" />
              <Stat label="tokens/s mediano" value={med(gens.map((x) => x.tokensPerSecond ?? 0).filter(Boolean)) ?? '—'} />
              <Stat label="total mediano" value={((med(gens.map((x) => x.totalMs)) ?? 0) / 1000).toFixed(1)} unit="s" />
            </div>
            <Spark data={gens.map((x) => x.timeToFirstTokenMs ?? 0).reverse()} max={Math.max(1, ...gens.map((x) => x.timeToFirstTokenMs ?? 0))} />
            {!!vm.length && <p className="mt-1 text-[11.5px] text-dim">Voz: STT mediano {med(vm.map((x) => x.sttMs ?? 0).filter(Boolean)) ?? '—'} ms · fim da fala → 1º áudio {med(vm.map((x) => x.firstAudioMs ?? 0).filter(Boolean)) ?? '—'} ms</p>}
          </>
        )}
      </Panel>
      <Panel title="Modelos na memória" icon={<Cpu className="size-4" />}>
        {d?.ollamaLoaded?.length ? d.ollamaLoaded.map((m) => (
          <div key={m.name} className="mb-2"><div className="font-mono text-[12px] text-accent-soft truncate">{m.name}</div><div className="text-[11px] text-dim">{(m.size / 1e9).toFixed(1)} GB · {m.size ? Math.round((m.size_vram / m.size) * 100) : 0}% na GPU</div><Meter value={m.size_vram} max={m.size || 1} /></div>
        )) : <p className="text-[12.5px] text-muted">Nenhum modelo carregado.</p>}
      </Panel>
      <Panel title="Conexão" icon={<Wifi className="size-4" />}>
        <div className="space-y-1.5 text-[12.5px]">
          <div className="flex justify-between"><span className="text-muted">Modo</span><Badge tone="orange">{api.mode === 'local' ? 'local' : 'remoto'}</Badge></div>
          <div className="flex justify-between"><span className="text-muted">Estado</span><Badge tone={conn === 'online' ? 'ok' : 'err'}>{conn}</Badge></div>
          {status?.relay && <div className="flex justify-between"><span className="text-muted">Relay</span><span>{status.relay.enabled ? (status.relay.connected ? `ok · ${fmtAgo(status.relay.lastSyncAt)}` : status.relay.lastError ?? 'desconectado') : 'desligado'}</span></div>}
          {api.mode === 'remote' && <div className="flex justify-between"><span className="text-muted">Último sinal do PC</span><span>{fmtAgo(status?.lastSeen)}</span></div>}
        </div>
      </Panel>
    </div>
  );
}
