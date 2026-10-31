import type { ToolManifest, ToolResult, RequestOrigin } from '@jarvis/contracts';
import type { PermissionEngine } from '../permissions/engine.js';
import type { Db } from '../db/index.js';
import type { CoreConfig } from '../config.js';

export type ToolContext = {
  origin: RequestOrigin;
  taskId: string | null;
  stepId: string | null;
  conversationId: string | null;
  signal: AbortSignal;
  perms: PermissionEngine;
  db: Db;
  config: CoreConfig;
  services: Record<string, unknown>;
};

export type ToolOutput = Omit<ToolResult, 'durationMs'>;
export type Verification = { ok: boolean; detail: string };

export interface Tool {
  manifest: ToolManifest;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
  /** Verificação independente do efeito real (não confia no retorno textual). */
  verify?(args: Record<string, unknown>, out: ToolOutput, ctx: ToolContext): Promise<Verification>;
  /** Teste de disponibilidade (ex.: Playwright instalado, Windows). */
  available?(): Promise<{ ok: boolean; reason?: string }>;
}
