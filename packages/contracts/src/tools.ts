import { z } from 'zod';

/** Níveis de risco. `high` e `critical` sempre exigem aprovação explícita. */
export const RiskLevel = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** Escopos de permissão concedidos pelo proprietário do dispositivo. */
export const PermissionScope = z.enum([
  'fs.read',
  'fs.write',
  'fs.delete',
  'apps.list',
  'apps.launch',
  'apps.close',
  'browser.control',
  'screen.capture',
  'system.read',
  'memory.read',
  'memory.write',
  'lab.execute',
  'net.fetch',
]);
export type PermissionScope = z.infer<typeof PermissionScope>;

export const ToolCategory = z.enum([
  'system', 'files', 'browser', 'documents', 'programming',
  'research', 'productivity', 'voice', 'vision', 'memory',
]);
export type ToolCategory = z.infer<typeof ToolCategory>;

/** JSON Schema (subconjunto) usado para descrever parâmetros ao modelo. */
export type JsonSchema = {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[]; items?: unknown; default?: unknown }>;
  required?: string[];
  additionalProperties?: boolean;
};

export const ToolManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_.]{2,63}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(10).max(600),
  category: ToolCategory,
  permissions: z.array(PermissionScope),
  risk: RiskLevel,
  reversible: z.boolean(),
  timeoutMs: z.number().int().min(100).max(600_000),
  /** Requisitos de plataforma ou de software (ex.: "windows", "playwright"). */
  requires: z.array(z.string()).default([]),
  parameters: z.custom<JsonSchema>((v) => typeof v === 'object' && v !== null && (v as JsonSchema).type === 'object'),
  /** Descrição do resultado esperado, usada pelo verificador. */
  returns: z.string().max(400),
});
export type ToolManifest = z.infer<typeof ToolManifestSchema>;

export type ToolResult = {
  ok: boolean;
  /** Dados estruturados devolvidos ao modelo. */
  data?: unknown;
  error?: string;
  /** Evidência objetiva coletada pela própria ferramenta (ex.: hash do arquivo escrito). */
  evidence?: Record<string, unknown>;
  /** Informação para desfazer a operação, quando reversível. */
  undo?: { tool: string; args: Record<string, unknown> };
  durationMs: number;
};

/** Origem de uma solicitação: define a política de permissões aplicada. */
export const RequestOrigin = z.enum(['local', 'remote', 'lab', 'system']);
export type RequestOrigin = z.infer<typeof RequestOrigin>;
