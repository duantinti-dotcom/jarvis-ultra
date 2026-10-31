'use client';
import { useState } from 'react';
import { ListChecks, RotateCcw, Square, ChevronRight, CheckCircle2, XCircle, Loader2, ShieldAlert } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { useChat } from '@/lib/chat';
import { Panel, Badge, Button, Empty, fmtTime, cx, ErrorNote } from '@/components/ui';
import type { Task, TaskStep } from '@jarvis/contracts';

const STATE: Record<string, { label: string; tone: 'ok' | 'err' | 'warn' | 'orange' | 'neutral' }> = {
  waiting: { label: 'Aguardando', tone: 'neutral' }, planning: { label: 'Planejando', tone: 'orange' }, awaiting_approval: { label: 'Aprovação', tone: 'warn' },
  executing: { label: 'Executando', tone: 'orange' }, verifying: { label: 'Verificando', tone: 'orange' }, correcting: { label: 'Corrigindo', tone: 'warn' },
  completed: { label: 'Concluída', tone: 'ok' }, failed: { label: 'Falhou', tone: 'err' }, cancelled: { label: 'Cancelada', tone: 'neutral' },
};
export function TaskStateBadge({ state }: { state: string }) {
  const s = STATE[state] ?? { label: state, tone: 'neutral' as const };
  return <Badge tone={s.tone} pulse={['planning', 'executing', 'verifying', 'correcting', 'awaiting_approval'].includes(state)}>{s.label}</Badge>;
}

type Detail = Task & { steps: TaskStep[]; calls: { id: string; tool: string; args: string; ok: number; error: string | null; verification: string | null; duration_ms: number; created_at: string }[] };

export function TasksView() {
  const { api, approvals, decide, notify, refreshTick } = useJarvis();
  const chat = useChat();
  const [filter, setFilter] = useState('all');
  const [sel, setSel] = useState<string | null>(null);
  const list = useAsync(() => api.tasks(100), [api, refreshTick], 4000);
  const detail = useAsync<Detail | null>(() => (sel && api.mode === 'local' ? api.req<Detail>(`/api/tasks/${sel}`) : Promise.resolve(null)), [api, sel, refreshTick], sel ? 3000 : undefined);
  const tasks = (list.data ?? []).filter((t) => filter === 'all' || (filter === 'active' ? !['completed', 'failed', 'cancelled'].includes(t.state) : t.state === filter));

  return (
    <div className="p-3 sm:p-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] max-w-[1400px] mx-auto">
      <div className="space-y-4">
        {approvals.length > 0 && (
          <Panel title={`Aprovações pendentes (${approvals.length})`} icon={<ShieldAlert className="size-4" />}>
            <ul className="space-y-2">
              {approvals.map((a) => (
                <li key={a.id} className="rounded-xl border border-warn/25 bg-warn/[0.04] p-3">
                  <div className="flex items-center gap-2"><span className="font-mono text-[12.5px] text-orange-soft">{a.tool}</span><Badge tone={a.risk === 'high' ? 'err' : 'warn'}>{a.risk}</Badge><span className="ml-auto label-tech">{a.origin}</span></div>
                  <pre className="mt-1.5 text-[11px] font-mono text-muted whitespace-pre-wrap break-all">{JSON.stringify(a.args)}</pre>
                  <div className="mt-2 flex gap-2"><Button size="sm" variant="primary" onClick={() => decide(a.id, true)}>Aprovar</Button><Button size="sm" variant="ghost" onClick={() => decide(a.id, false)}>Negar</Button></div>
                </li>
              ))}
            </ul>
          </Panel>
        )}
        <Panel title="Fila de tarefas" icon={<ListChecks className="size-4" />} actions={
          <div className="flex gap-1">{['all', 'active', 'completed', 'failed'].map((f) => <button key={f} onClick={() => setFilter(f)} className={cx('px-2 h-6 rounded-md text-[11px]', filter === f ? 'bg-orange/15 text-orange-soft' : 'text-dim hover:text-fg')}>{{ all: 'todas', active: 'ativas', completed: 'concluídas', failed: 'falhas' }[f]}</button>)}</div>
        } bodyClass="p-2">
          <ErrorNote error={list.error} />
          {!tasks.length ? <Empty title="Nenhuma tarefa">Peça uma ação ao JARVIS e ela aparece aqui com cada etapa registrada.</Empty> : (
            <ul>
              {tasks.map((t) => (
                <li key={t.id}>
                  <button onClick={() => setSel(t.id)} className={cx('w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition', sel === t.id ? 'bg-orange/[0.08]' : 'hover:bg-white/[0.03]')}>
                    <TaskStateBadge state={t.state} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] truncate">{t.goal}</div>
                      <div className="text-[11px] text-dim">{fmtTime(t.createdAt)} · {t.origin}{t.error ? ` · ${t.error.slice(0, 60)}` : ''}</div>
                    </div>
                    <ChevronRight className="size-4 text-dim" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div>
        {!sel ? <Panel><Empty title="Selecione uma tarefa">Veja plano, etapas, ferramentas, verificações, erros e logs.</Empty></Panel> : (
          <Panel title="Detalhes" actions={
            <div className="flex gap-2">
              {detail.data && !['completed', 'failed', 'cancelled'].includes(detail.data.state) && <Button size="sm" variant="danger" icon={<Square className="size-3.5" />} onClick={() => api.cancelTask(sel).catch((e) => notify('err', e.message))}>Cancelar</Button>}
              {detail.data && ['failed', 'cancelled'].includes(detail.data.state) && api.mode === 'local' && <Button size="sm" icon={<RotateCcw className="size-3.5" />} onClick={async () => { const r = await api.req<{ conversationId: string }>(`/api/tasks/${sel}/retry`, { method: 'POST' }); await chat.open(r.conversationId); location.hash = '#/chat'; }}>Reexecutar</Button>}
            </div>
          }>
            {api.mode === 'remote' && !detail.data && (() => { const t = list.data?.find((x) => x.id === sel); return t ? <TaskSummary t={t} /> : null; })()}
            {detail.data && (
              <div className="space-y-4">
                <TaskSummary t={detail.data} />
                {!!detail.data.plan.length && (
                  <div><div className="label-tech mb-1.5">Plano</div><ol className="list-decimal ml-5 text-[12.5px] text-muted space-y-0.5">{detail.data.plan.map((p, i) => <li key={i}>{p}</li>)}</ol></div>
                )}
                {!!detail.data.successCriteria.length && <div><div className="label-tech mb-1.5">Critérios de sucesso</div><ul className="ml-5 list-disc text-[12.5px] text-muted">{detail.data.successCriteria.map((c, i) => <li key={i}>{c}</li>)}</ul></div>}
                <div>
                  <div className="label-tech mb-1.5">Etapas executadas</div>
                  <ol className="relative border-l border-line ml-2 space-y-3">
                    {detail.data.steps.map((s) => {
                      const v = s.verification as { ok: boolean; detail: string } | null;
                      return (
                        <li key={s.id} className="ml-4">
                          <span className="absolute -left-[7px] mt-1 grid place-items-center size-3.5 rounded-full bg-bg">
                            {s.state === 'running' ? <Loader2 className="size-3.5 animate-spin text-orange" /> : s.state === 'done' ? <CheckCircle2 className="size-3.5 text-ok" /> : <XCircle className="size-3.5 text-err" />}
                          </span>
                          <div className="text-[12.5px]"><span className="font-mono text-orange-soft">{s.tool}</span> <span className="text-dim">· {s.agent}</span></div>
                          <pre className="text-[11px] font-mono text-muted whitespace-pre-wrap break-all">{JSON.stringify(s.args)}</pre>
                          {s.error && <div className="text-[12px] text-err">{s.error}</div>}
                          {v && <div className={cx('text-[11.5px]', v.ok ? 'text-ok' : 'text-err')}>verificação: {v.detail}</div>}
                        </li>
                      );
                    })}
                    {!detail.data.steps.length && <li className="ml-4 text-[12px] text-dim">Nenhuma ferramenta foi necessária.</li>}
                  </ol>
                </div>
                {detail.data.result && <div><div className="label-tech mb-1.5">Resultado</div><p className="text-[12.5px] text-muted whitespace-pre-wrap">{detail.data.result.slice(0, 1500)}</p></div>}
                <details className="text-[11.5px]"><summary className="cursor-pointer text-dim">Log bruto de chamadas ({detail.data.calls.length})</summary>
                  <pre className="mt-2 max-h-64 overflow-auto scroll-thin rounded-lg bg-black/40 p-2 font-mono text-[10.5px] text-muted">{JSON.stringify(detail.data.calls, null, 1)}</pre>
                </details>
              </div>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}

function TaskSummary({ t }: { t: Task }) {
  return (
    <div>
      <div className="flex items-center gap-2"><TaskStateBadge state={t.state} /><span className="label-tech">{t.id}</span></div>
      <h3 className="mt-2 font-display text-[16px]">{t.goal}</h3>
      <div className="text-[11.5px] text-dim mt-1">criada {fmtTime(t.createdAt)} · atualizada {fmtTime(t.updatedAt)} · origem {t.origin}</div>
      {t.error && <div className="mt-2 rounded-lg border border-err/30 bg-err/[0.06] px-3 py-2 text-[12.5px] text-err">{t.error}</div>}
    </div>
  );
}
