import { z } from 'zod';

/**
 * Comandos que o site pode enviar ao agente Windows pelo relay.
 * Lista fechada: o relay nunca transporta comandos arbitrários de shell.
 */
export const RelayCommand = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat'), conversationId: z.string().max(64).nullable(), text: z.string().min(1).max(8000) }),
  z.object({ kind: z.literal('task.cancel'), taskId: z.string().max(64) }),
  z.object({ kind: z.literal('approval.respond'), approvalId: z.string().max(64), approve: z.boolean() }),
  z.object({ kind: z.literal('status.get') }),
  z.object({ kind: z.literal('tasks.list'), limit: z.number().int().min(1).max(100).default(30) }),
  z.object({ kind: z.literal('memory.list'), query: z.string().max(200).optional() }),
  z.object({ kind: z.literal('conversations.list') }),
  z.object({ kind: z.literal('conversation.get'), conversationId: z.string().max(64) }),
  z.object({ kind: z.literal('emergency.stop') }),
]);
export type RelayCommand = z.infer<typeof RelayCommand>;

/** Status publicado pelo agente no heartbeat. Somente métricas, nunca conteúdo de arquivos. */
export type DeviceStatus = {
  hostname: string;
  platform: string;
  coreVersion: string;
  model: string | null;
  modelLoaded: boolean;
  profile: string;
  cpuPercent: number;
  ramUsedGb: number;
  ramTotalGb: number;
  gpu: string | null;
  activeTasks: number;
  pendingApprovals: number;
  remoteEnabled: boolean;
  uptimeSec: number;
};
