'use client';
import { Bot, Wrench } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { Panel, Badge, ErrorNote, fmtAgo } from '@/components/ui';

type Agent = { id: string; name: string; description: string; instructions: string; modelClass: string; model: string | null; tools: { name: string; risk: string; permissions: string[] }[]; runs: { n: number; ok: number; last: string } | null };

export function AgentsView() {
  const { api } = useJarvis();
  const agents = useAsync(() => api.req<Agent[]>('/api/agents'), [api], 15_000);
  return (
    <div className="p-3 sm:p-5 max-w-[1400px] mx-auto space-y-4">
      <p className="text-[12.5px] text-muted max-w-3xl">Os especialistas compartilham o mesmo modelo carregado (para não estourar a VRAM da GPU). Cada um recebe instruções próprias e um conjunto reduzido de ferramentas — menos ferramentas no contexto significa respostas mais rápidas e escolhas mais precisas. O roteador escolhe o especialista por regras rápidas ou pelo classificador de intenção.</p>
      <ErrorNote error={agents.error} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.data?.map((a) => (
          <Panel key={a.id} title={a.name} icon={<Bot className="size-4" />} actions={<Badge tone="orange">{a.modelClass}</Badge>}>
            <p className="text-[12.5px] text-muted">{a.description}</p>
            <p className="mt-2 text-[11.5px] text-dim italic">{a.instructions}</p>
            <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
              <Badge>{a.model?.replace(/:latest$/, '') ?? 'sem modelo'}</Badge>
              {a.runs ? <Badge tone={a.runs.ok / a.runs.n > 0.8 ? 'ok' : 'warn'}>{a.runs.ok}/{a.runs.n} etapas ok · {fmtAgo(a.runs.last)}</Badge> : <Badge>sem execuções</Badge>}
            </div>
            {!!a.tools.length && (
              <div className="mt-3">
                <div className="label-tech mb-1.5 flex items-center gap-1"><Wrench className="size-3" />Ferramentas</div>
                <div className="flex flex-wrap gap-1">
                  {a.tools.map((t) => <span key={t.name} title={t.permissions.join(', ')} className={`rounded-md border px-1.5 py-0.5 font-mono text-[10.5px] ${t.risk === 'high' ? 'border-err/30 text-err' : t.risk === 'medium' ? 'border-warn/30 text-warn' : 'border-line text-muted'}`}>{t.name}</span>)}
                </div>
              </div>
            )}
          </Panel>
        ))}
      </div>
    </div>
  );
}
