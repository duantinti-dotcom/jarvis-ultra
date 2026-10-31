'use client';
import { useEffect, useState } from 'react';
import { FlaskConical, Sparkles, Play, ShieldCheck, X, Package, RotateCcw, Lightbulb } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { Panel, Badge, Button, Textarea, Empty, ErrorNote, Toggle, fmtTime, cx } from '@/components/ui';

type Exp = { id: string; title: string; problem: string; proposal: string | null; status: string; files: Record<string, string>; testOutput: string | null; testPassed: boolean | null; report: string | null; diff: string | null; updatedAt: string };
type Plugin = { name: string; version: string; enabled: boolean; sha256: string; versions: { version: string; status: string; created_at: string }[] };
type Improve = { summary: Record<string, unknown>; proposals: { id: string; severity: string; area: string; finding: string; suggestion: string; labPrompt?: string }[]; topErrors: { tool: string; error: string; n: number }[] };

const TONE: Record<string, 'ok' | 'err' | 'warn' | 'orange' | 'neutral'> = { passed: 'ok', installed: 'ok', failed: 'err', rejected: 'neutral', testing: 'orange', generating: 'orange' };

export function LabView() {
  const { api, notify } = useJarvis();
  const exps = useAsync(() => api.req<Exp[]>('/api/lab'), [api], 5000);
  const plugins = useAsync(() => api.req<Plugin[]>('/api/plugins'), [api]);
  const improve = useAsync(() => api.req<Improve>('/api/improve'), [api]);
  const [sel, setSel] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const [gen, setGen] = useState(false);
  const [file, setFile] = useState('index.mjs');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const exp = exps.data?.find((e) => e.id === sel) ?? null;
  useEffect(() => { if (exp) setDraft(exp.files); }, [exp?.id, exp?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); if (ok) notify('ok', ok); } catch (e) { notify('err', (e as Error).message); }
    void exps.reload(); void plugins.reload();
  };
  const generate = async (p = problem) => {
    if (p.trim().length < 10) return notify('warn', 'Descreva a ferramenta com mais detalhes.');
    setGen(true);
    await run(async () => { const e = await api.req<Exp>('/api/lab/generate', { method: 'POST', json: { problem: p } }); setSel(e.id); });
    setGen(false);
  };

  return (
    <div className="p-3 sm:p-5 max-w-[1500px] mx-auto grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
      <div className="space-y-4">
        <Panel title="Nova ferramenta" icon={<Sparkles className="size-4" />}>
          <Textarea rows={4} value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="Ex.: uma ferramenta que converte uma lista de valores em reais para dólares usando uma taxa informada, com arredondamento em 2 casas." />
          <Button className="mt-2 w-full" variant="primary" loading={gen} icon={<FlaskConical className="size-4" />} onClick={() => generate()}>Gerar e testar em sandbox</Button>
          <p className="mt-2 text-[11px] text-dim">O código é gerado pelo modelo local, passa por análise estática e roda testes num processo isolado sem acesso aos seus arquivos. Nada é instalado sem sua aprovação.</p>
        </Panel>
        <Panel title="Experimentos" icon={<FlaskConical className="size-4" />} bodyClass="p-2">
          {!exps.data?.length ? <Empty title="Nenhum experimento" /> : exps.data.map((e) => (
            <button key={e.id} onClick={() => setSel(e.id)} className={cx('w-full text-left rounded-xl px-3 py-2 flex items-center gap-2', sel === e.id ? 'bg-orange/10' : 'hover:bg-white/[0.04]')}>
              <div className="min-w-0 flex-1"><div className="text-[12.5px] truncate font-mono">{e.title}</div><div className="text-[10.5px] text-dim">{fmtTime(e.updatedAt)}</div></div>
              <Badge tone={TONE[e.status] ?? 'neutral'} pulse={e.status === 'testing' || e.status === 'generating'}>{e.status}</Badge>
            </button>
          ))}
        </Panel>
        <Panel title="Plugins instalados" icon={<Package className="size-4" />}>
          {!plugins.data?.length ? <p className="text-[12.5px] text-muted">Nenhum plugin.</p> : plugins.data.map((p) => (
            <div key={p.name} className="py-2 border-b border-line last:border-0">
              <div className="flex items-center gap-2"><span className="font-mono text-[12.5px] flex-1 truncate">{p.name}</span><Badge>v{p.version}</Badge><Toggle label="Ativo" checked={p.enabled} onChange={(on) => run(() => api.req(`/api/plugins/${p.name}/${on ? 'enable' : 'disable'}`, { method: 'POST' }))} /></div>
              <div className="mt-1 flex items-center gap-2 text-[10.5px] text-dim font-mono">sha256 {p.sha256.slice(0, 12)}… · {p.versions.length} versões
                {p.versions.length > 1 && <button className="ml-auto inline-flex items-center gap-1 text-muted hover:text-fg" onClick={() => run(() => api.req(`/api/plugins/${p.name}/rollback`, { method: 'POST' }), 'Versão anterior restaurada')}><RotateCcw className="size-3" />rollback</button>}
              </div>
            </div>
          ))}
        </Panel>
      </div>

      <div className="space-y-4 min-w-0">
        {exp ? (
          <Panel title={exp.title} icon={<FlaskConical className="size-4" />} actions={
            <div className="flex gap-2">
              <Button size="sm" icon={<Play className="size-3.5" />} onClick={() => run(() => api.req(`/api/lab/${exp.id}/files`, { method: 'PUT', json: { files: draft } }), 'Testes executados')} disabled={exp.status === 'installed'}>Salvar e testar</Button>
              <Button size="sm" variant="primary" icon={<ShieldCheck className="size-3.5" />} disabled={exp.status !== 'passed'} onClick={() => confirm(`Instalar ${exp.title}? Ele poderá ser usado pelo JARVIS com as permissões declaradas no manifesto.`) && run(() => api.req(`/api/lab/${exp.id}/approve`, { method: 'POST' }), 'Plugin aprovado e instalado')}>Aprovar instalação</Button>
              {exp.status !== 'installed' && <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => run(() => api.req(`/api/lab/${exp.id}/reject`, { method: 'POST' }))}>Rejeitar</Button>}
            </div>
          }>
            <p className="text-[12.5px] text-muted">{exp.problem}</p>
            {exp.report && <p className={cx('mt-2 text-[12.5px]', exp.testPassed ? 'text-ok' : 'text-warn')}>{exp.report}</p>}
            <div className="mt-3 flex gap-1 border-b border-line">
              {Object.keys(draft).map((f) => <button key={f} onClick={() => setFile(f)} className={cx('px-3 h-8 text-[12px] font-mono rounded-t-lg', file === f ? 'bg-white/[0.06] text-orange-soft' : 'text-dim hover:text-fg')}>{f}</button>)}
            </div>
            <textarea spellCheck={false} value={draft[file] ?? ''} onChange={(e) => setDraft({ ...draft, [file]: e.target.value })} readOnly={exp.status === 'installed'}
              className="w-full h-80 mt-0 rounded-b-xl bg-[#0a0d12] border border-line border-t-0 p-3 font-mono text-[12px] leading-relaxed outline-none scroll-thin" aria-label={`Editor ${file}`} />
            <div className="grid gap-3 lg:grid-cols-2 mt-3">
              <div><div className="label-tech mb-1">Saída dos testes</div><pre className="h-48 overflow-auto scroll-thin rounded-xl bg-black/40 p-2.5 text-[11px] font-mono text-muted whitespace-pre-wrap">{exp.testOutput ?? '—'}</pre></div>
              <div><div className="label-tech mb-1">Comparação de alterações</div><pre className="h-48 overflow-auto scroll-thin rounded-xl bg-black/40 p-2.5 text-[11px] font-mono whitespace-pre">{exp.diff ? exp.diff.split('\n').filter((l) => !l.startsWith('  ')).slice(0, 300).map((l, i) => <div key={i} className={l.startsWith('+') ? 'text-ok' : l.startsWith('-') ? 'text-err' : ''}>{l}</div>) : 'Sem alterações manuais.'}</pre></div>
            </div>
          </Panel>
        ) : <Panel><Empty icon={<FlaskConical className="size-8" />} title="Selecione ou crie um experimento">O LAB é o ambiente de evolução do JARVIS: gerar, testar, comparar e aprovar novas ferramentas.</Empty></Panel>}

        <Panel title="Melhoria contínua — análise das execuções reais" icon={<Lightbulb className="size-4" />}>
          <ErrorNote error={improve.error} />
          {improve.data && (
            <>
              <div className="flex flex-wrap gap-2 text-[11.5px]">
                {Object.entries(improve.data.summary).filter(([, v]) => typeof v !== 'object').map(([k, v]) => <Badge key={k}>{k}: {String(v ?? '—')}</Badge>)}
              </div>
              <ul className="mt-3 space-y-2">
                {improve.data.proposals.map((p) => (
                  <li key={p.id} className="rounded-xl border border-line p-3">
                    <div className="flex items-center gap-2"><Badge tone={p.severity === 'critical' ? 'err' : p.severity === 'warn' ? 'warn' : 'neutral'}>{p.area}</Badge><span className="text-[12.5px]">{p.finding}</span></div>
                    <p className="mt-1 text-[12px] text-muted">{p.suggestion}</p>
                    {p.labPrompt && <Button size="sm" variant="ghost" className="mt-1" icon={<Sparkles className="size-3.5" />} onClick={() => generate(p.labPrompt)}>Criar melhoria no LAB</Button>}
                  </li>
                ))}
                {!improve.data.proposals.length && <li className="text-[12.5px] text-muted">Sem problemas recorrentes detectados nas últimas 2 semanas.</li>}
              </ul>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
