import type { Task, TaskState, TaskStep, StepState } from '@jarvis/contracts';
import { TERMINAL_STATES } from '@jarvis/contracts';
import type { Db } from '../db/index.js';
import { json, parse } from '../db/index.js';
import type { Bus } from '../bus.js';
import { newId, nowIso } from '../util/ids.js';

type TaskRow = { id: string; conversation_id: string | null; origin: Task['origin']; goal: string; state: TaskState; plan: string; success_criteria: string; result: string | null; error: string | null; created_at: string; updated_at: string };
type StepRow = { id: string; task_id: string; idx: number; agent: string; description: string; tool: string | null; args: string | null; state: StepState; result: string | null; error: string | null; verification: string | null; started_at: string | null; finished_at: string | null };

const toTask = (r: TaskRow): Task => ({ id: r.id, conversationId: r.conversation_id, origin: r.origin, goal: r.goal, state: r.state, plan: parse(r.plan, []), successCriteria: parse(r.success_criteria, []), result: r.result, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at });
const toStep = (r: StepRow): TaskStep => ({ id: r.id, taskId: r.task_id, index: r.idx, agent: r.agent, description: r.description, tool: r.tool, args: parse(r.args, null), state: r.state, result: parse(r.result, null), error: r.error, verification: parse(r.verification, null), startedAt: r.started_at, finishedAt: r.finished_at });

export class TaskStore {
  private controllers = new Map<string, AbortController>();
  constructor(private db: Db, private bus: Bus) {}

  create(input: { conversationId: string | null; origin: Task['origin']; goal: string; plan?: string[]; successCriteria?: string[] }) {
    const id = newId('task');
    const now = nowIso();
    this.db.run('INSERT INTO tasks (id, conversation_id, origin, goal, state, plan, success_criteria, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, input.conversationId, input.origin, input.goal.slice(0, 500), 'planning', json(input.plan ?? []), json(input.successCriteria ?? []), now, now);
    const ac = new AbortController();
    this.controllers.set(id, ac);
    this.bus.emitEvent({ type: 'task.update', taskId: id, state: 'planning', detail: input.goal.slice(0, 120) });
    return { task: this.get(id)!, signal: ac.signal };
  }

  setState(id: string, state: TaskState, patch: { result?: string | null; error?: string | null; plan?: string[] } = {}) {
    const cur = this.get(id);
    if (!cur || TERMINAL_STATES.includes(cur.state)) return;
    this.db.run('UPDATE tasks SET state = ?, result = coalesce(?, result), error = coalesce(?, error), plan = coalesce(?, plan), updated_at = ? WHERE id = ?',
      state, patch.result ?? null, patch.error ?? null, patch.plan ? json(patch.plan) : null, nowIso(), id);
    if (TERMINAL_STATES.includes(state)) this.controllers.delete(id);
    this.bus.emitEvent({ type: 'task.update', taskId: id, state, detail: patch.error ?? undefined });
  }

  addStep(taskId: string, s: { agent: string; description: string; tool: string | null; args: Record<string, unknown> | null }) {
    const idx = (this.db.get<{ n: number }>('SELECT count(*) AS n FROM task_steps WHERE task_id = ?', taskId)?.n ?? 0);
    const id = newId('step');
    this.db.run('INSERT INTO task_steps (id, task_id, idx, agent, description, tool, args, state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, taskId, idx, s.agent, s.description.slice(0, 300), s.tool, json(s.args), 'running', nowIso());
    return id;
  }

  finishStep(id: string, state: StepState, r: { result?: unknown; error?: string | null; verification?: unknown }) {
    this.db.run('UPDATE task_steps SET state = ?, result = ?, error = ?, verification = ?, finished_at = ? WHERE id = ?',
      state, json(r.result ?? null), r.error ?? null, json(r.verification ?? null), nowIso(), id);
  }

  get(id: string, withSteps = false): Task | null {
    const r = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
    if (!r) return null;
    const t = toTask(r);
    if (withSteps) t.steps = this.db.all<StepRow>('SELECT * FROM task_steps WHERE task_id = ? ORDER BY idx', id).map(toStep);
    return t;
  }

  list(limit = 50, state?: TaskState): Task[] {
    return (state ? this.db.all<TaskRow>('SELECT * FROM tasks WHERE state = ? ORDER BY updated_at DESC LIMIT ?', state, limit) : this.db.all<TaskRow>('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?', limit)).map(toTask);
  }

  active(): Task[] {
    return this.db.all<TaskRow>("SELECT * FROM tasks WHERE state NOT IN ('completed','failed','cancelled') ORDER BY created_at").map(toTask);
  }

  cancel(id: string, reason = 'Cancelada pelo usuário') {
    const ac = this.controllers.get(id);
    ac?.abort(new Error(reason));
    this.setState(id, 'cancelled', { error: reason });
    return !!ac || !!this.get(id);
  }

  cancelAll(reason: string) {
    for (const t of this.active()) this.cancel(t.id, reason);
  }

  /** Tarefas interrompidas por reinício do processo não podem continuar com segurança. */
  failOrphans() {
    for (const t of this.active()) if (!this.controllers.has(t.id)) this.setState(t.id, 'failed', { error: 'Interrompida: o JARVIS foi reiniciado durante a execução.' });
  }
}
