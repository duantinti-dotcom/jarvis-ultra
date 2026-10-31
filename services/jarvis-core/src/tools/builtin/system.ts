import type { Tool } from '../types.js';
import { liveStats, detectHardware } from '../../hardware/detect.js';

export const systemTools: Tool[] = [
  {
    manifest: {
      name: 'system.status', version: '1.0.0', category: 'system', permissions: ['system.read'], risk: 'low', reversible: true, timeoutMs: 15_000, requires: [],
      description: 'Lê o estado atual do computador: uso de CPU, RAM, GPU/VRAM, memória usada pelo JARVIS e tempo ativo. Use para "como está meu computador?".',
      parameters: { type: 'object', properties: {} },
      returns: 'Métricas medidas no momento da chamada',
    },
    async run() {
      // Primeira amostra de CPU após 300 ms para obter uma diferença válida.
      await liveStats();
      await new Promise((r) => setTimeout(r, 300));
      return { ok: true, data: await liveStats() };
    },
  },
  {
    manifest: {
      name: 'system.hardware', version: '1.0.0', category: 'system', permissions: ['system.read'], risk: 'low', reversible: true, timeoutMs: 20_000, requires: [],
      description: 'Detecta o hardware: modelo da CPU, núcleos, RAM total, GPUs, VRAM e espaço livre em disco.',
      parameters: { type: 'object', properties: {} },
      returns: 'Inventário de hardware',
    },
    async run(_a, ctx) {
      return { ok: true, data: await detectHardware(ctx.config.dataDir) };
    },
  },
  {
    manifest: {
      name: 'system.time', version: '1.0.0', category: 'system', permissions: [], risk: 'low', reversible: true, timeoutMs: 2_000, requires: [],
      description: 'Retorna data, hora e fuso horário atuais do computador.',
      parameters: { type: 'object', properties: {} },
      returns: 'Data e hora local',
    },
    async run() {
      const d = new Date();
      return { ok: true, data: { iso: d.toISOString(), local: d.toLocaleString('pt-BR'), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } };
    },
  },
];
