import { z } from 'zod';

export const TaskState = z.enum([
  'waiting', 'planning', 'awaiting_approval', 'executing', 'paused',
  'verifying', 'correcting', 'completed', 'failed', 'cancelled',
]);
export type TaskState = z.infer<typeof TaskState>;

export const TERMINAL_STATES: readonly TaskState[] = ['completed', 'failed', 'cancelled'];

export const StepState = z.enum(['pending', 'running', 'awaiting_approval', 'done', 'failed', 'skipped', 'cancelled']);
export type StepState = z.infer<typeof StepState>;

export type TaskStep = {
  id: string;
  taskId: string;
  index: number;
  agent: string;
  description: string;
  tool: string | null;
  args: Record<string, unknown> | null;
  state: StepState;
  result: unknown;
  error: string | null;
  verification: { ok: boolean; detail: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type Task = {
  id: string;
  conversationId: string | null;
  origin: 'local' | 'remote' | 'lab' | 'system';
  goal: string;
  state: TaskState;
  plan: string[];
  successCriteria: string[];
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  steps?: TaskStep[];
};

export type Approval = {
  id: string;
  taskId: string | null;
  stepId: string | null;
  tool: string;
  args: Record<string, unknown>;
  risk: string;
  reason: string;
  origin: string;
  state: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: string;
  decidedAt: string | null;
};
