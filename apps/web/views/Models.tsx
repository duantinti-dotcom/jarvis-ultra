'use client';
import { useState } from 'react';
import { Cpu, Download, Play, Square, Trash2, Gauge, Check } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { Panel, Badge, Button, Input, Empty, ErrorNote, Meter, fmtBytes, cx, fmtTime } from '@/components/ui';

type ModelView = { name: string; size: number; paramsB: number; capabilities: string[]; estimatedMemoryGb: number; kind: string; details: { quantization_level?: string; family?: string }; loaded: { size_vram: number; size: number } | null };
type Data = { installed: ModelView[]; catalog: { name: string; profile: string; sizeGb: number; purpose: string }[]; profiles: Record<string, { label: string; maxParamsB: number; numCtx: number; description: string }>; profile: string; override: string | null; suggestion: { profile: string; reason: string } | null; budgetGb: number; benchmarks: { model: string; value: string; created_at: string }[] };

export function ModelsView() {
  const { api, notify, refreshStatus } = useJarvis();
  const d = useAsync(() => api.req<Data>('/api/models'), [api], 10_000);
  const [pull, setPull] = useState('');
  const [progress, setProgress] = useState<{ model: string; pct: number; status: string } | null>(null);
  const [bench, setBench] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) notify('ok', ok); } catch (e) { notify('err', (e as Error).message); }
    void d.reload(); void refreshStatus();
  };
  const doPull = async (model: string) => {
    setProgress({ model, pct: 0, status: 'iniciando' });
    try {
      const r = await fetch(`${api.coreUrl}/api/models/pull`, { method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines.filter(Boolean)) {
          const p = JSON.parse(l);
          if (p.error) throw new Error(p.error);
          setProgress({ model, status: p.status, pct: p.total ? Math.round((p.completed / p.total) * 100) : 0 });
        }
      }
      notify('ok', `${model} instalado`);
    } catch (e) {
      notify('err', `Falha ao instalar ${model}: ${(e as Error).message}`);
    } finally {
      setProgress(null);
      void d.reload();
    }
  };

  if (d.error) return <div className="p-5"><ErrorNote error={`${d.error} — verifique se o Ollama está instalado e em execução.`} /></div>;
  const data = d.data;
  return (
    <div className="p-3 sm:p-5 max-w-[1400px] mx-auto space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        {data && Object.entries(data.profiles).map(([k, p]) => (
          <button key={k} onClick={() => act(() => api.req('/api/models/profile', { method: 'POST', json: { profile: k } }), `Perfil ${k} ativo`)}
            className={cx('glass glass-hover rounded-2xl p-4 text-left', data.profile === k && '!border-orange/60 shadow-[0_0_40px_-18px_#ff6a00]')}>
            <div className="flex items-center gap-2"><span className="font-display font-semibold tracking-widest">{p.label}</span>{data.profile === k && <Check className="size-4 text-orange" />}{data.suggestion?.profile === k && <Badge tone="orange" className="ml-auto">sugerido</Badge>}</div>
            <p className="mt-1.5 text-[12px] text-muted">{p.description}</p>
            <p className="mt-2 text-[10.5px] font-mono text-dim">até {p.maxParamsB}B · contexto {p.numCtx}</p>
          </button>
        ))}
      </div>
      {data?.suggestion && <p className="text-[12px] text-dim">Sugestão para seu hardware: <b className="text-orange-soft">{data.suggestion.profile}</b> — {data.suggestion.reason} Memória disponível agora para modelos: ~{data.budgetGb.toFixed(1)} GB.</p>}

      <Panel title="Modelos instalados" icon={<Cpu className="size-4" />}>
        {!data?.installed.length ? <Empty title="Nenhum modelo instalado">Instale um modelo do catálogo abaixo.</Empty> : (
          <div className="overflow-x-auto scroll-thin">
            <table className="w-full text-[12.5px]">
              <thead className="text-dim text-left"><tr><th className="font-normal py-1.5">modelo</th><th className="font-normal">tamanho</th><th className="font-normal">memória est.</th><th className="font-normal">capacidades</th><th className="font-normal">estado</th><th /></tr></thead>
              <tbody>
                {data.installed.map((m) => (
                  <tr key={m.name} className="border-t border-line">
                    <td className="py-2 pr-3"><div className="font-mono text-orange-soft">{m.name}</div><div className="text-[10.5px] text-dim">{m.paramsB}B · {m.details.quantization_level ?? ''} · {m.details.family}</div></td>
                    <td className="pr-3 tabular-nums">{fmtBytes(m.size)}</td>
                    <td className="pr-3 tabular-nums">{m.estimatedMemoryGb} GB</td>
                    <td className="pr-3"><div className="flex flex-wrap gap-1">{m.capabilities.filter((c) => c !== 'completion').map((c) => <Badge key={c}>{c}</Badge>)}</div></td>
                    <td className="pr-3">{m.loaded ? <Badge tone="ok" pulse>carregado · {fmtBytes(m.loaded.size_vram)} VRAM</Badge> : <Badge>em disco</Badge>}{data.override === m.name && <Badge tone="orange" className="ml-1">fixado</Badge>}</td>
                    <td className="text-right whitespace-nowrap space-x-1">
                      {m.kind !== 'embedding' && <Button size="sm" variant="ghost" onClick={() => act(() => api.req('/api/models/override', { method: 'POST', json: { model: data.override === m.name ? null : m.name } }))}>{data.override === m.name ? 'Automático' : 'Usar este'}</Button>}
                      {m.loaded ? <Button size="sm" variant="ghost" icon={<Square className="size-3" />} onClick={() => act(() => api.req('/api/models/unload', { method: 'POST', json: { model: m.name } }))}>Descarregar</Button>
                        : <Button size="sm" variant="ghost" icon={<Play className="size-3" />} onClick={() => act(async () => { const r = await api.req<{ loadMs: number }>('/api/models/load', { method: 'POST', json: { model: m.name } }); notify('ok', `Carregado em ${r.loadMs} ms`); })}>Carregar</Button>}
                      {m.kind !== 'embedding' && <Button size="sm" variant="ghost" icon={<Gauge className="size-3" />} loading={bench === m.name} onClick={async () => { setBench(m.name); await act(() => api.req('/api/models/benchmark', { method: 'POST', json: { model: m.name, runs: 2 } }), 'Benchmark concluído'); setBench(null); }}>Benchmark</Button>}
                      <Button size="sm" variant="ghost" className="hover:!text-err" icon={<Trash2 className="size-3" />} onClick={() => confirm(`Remover ${m.name} do disco?`) && act(() => api.req(`/api/models/${encodeURIComponent(m.name)}`, { method: 'DELETE' }))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Instalar modelos" icon={<Download className="size-4" />}>
          {progress && <div className="mb-3"><div className="text-[12px] mb-1">{progress.model} — {progress.status} {progress.pct ? `${progress.pct}%` : ''}</div><Meter value={progress.pct} /></div>}
          <ul className="space-y-2">
            {data?.catalog.map((c) => {
              const has = data.installed.some((m) => m.name.startsWith(c.name));
              return (
                <li key={c.name} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2">
                  <div className="min-w-0 flex-1"><div className="font-mono text-[12.5px]">{c.name}</div><div className="text-[11px] text-dim">{c.purpose} · ~{c.sizeGb} GB · {c.profile}</div></div>
                  {has ? <Badge tone="ok">instalado</Badge> : <Button size="sm" disabled={!!progress} icon={<Download className="size-3.5" />} onClick={() => doPull(c.name)}>Instalar</Button>}
                </li>
              );
            })}
          </ul>
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (pull.trim()) void doPull(pull.trim()); }}>
            <Input value={pull} onChange={(e) => setPull(e.target.value)} placeholder="Outro modelo do Ollama (ex.: llama3.2:3b)" className="h-9" />
            <Button type="submit" size="sm" disabled={!!progress}>Instalar</Button>
          </form>
        </Panel>
        <Panel title="Benchmarks medidos" icon={<Gauge className="size-4" />}>
          {!data?.benchmarks.length ? <p className="text-[12.5px] text-muted">Rode um benchmark para medir carga, TTFT, tokens/s e tool calling neste computador.</p> : (
            <table className="w-full text-[11.5px] font-mono">
              <thead className="text-dim"><tr><th className="text-left font-normal">modelo</th><th className="font-normal">carga</th><th className="font-normal">TTFT</th><th className="font-normal">tok/s</th><th className="font-normal">tools</th><th className="font-normal">quando</th></tr></thead>
              <tbody>
                {data.benchmarks.map((b, i) => {
                  const v = JSON.parse(b.value);
                  return <tr key={i} className="text-center border-t border-line"><td className="text-left py-1">{v.model}</td><td>{v.coldLoadMs} ms</td><td>{v.ttftMsMedian} ms</td><td>{v.tokensPerSecondMedian}</td><td>{Math.round(v.toolCalling.successRate * 100)}%</td><td className="text-dim">{fmtTime(b.created_at)}</td></tr>;
                })}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
