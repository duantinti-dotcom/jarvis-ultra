import os from 'node:os';
import type { OllamaClient, ModelTag } from './ollama.js';
import type { Db } from '../db/index.js';
import type { HardwareInfo } from '../hardware/detect.js';
import { logger } from '../log.js';

const log = logger('router');

export type Profile = 'ECO' | 'BALANCED' | 'MAXIMUM';
export type TaskClass = 'chat' | 'tools' | 'code' | 'vision' | 'fast' | 'embed';

export const PROFILES: Record<Profile, { label: string; maxParamsB: number; numCtx: number; description: string }> = {
  ECO: { label: 'ECO', maxParamsB: 2.1, numCtx: 4096, description: 'Modelos até ~2B. Menor uso de RAM/VRAM e respostas rápidas; raciocínio mais limitado.' },
  BALANCED: { label: 'BALANCED', maxParamsB: 4.6, numCtx: 8192, description: 'Modelos até ~4B quantizados (cabem quase inteiros em 4 GB de VRAM). Melhor custo-benefício para GTX 1650.' },
  MAXIMUM: { label: 'MAXIMUM', maxParamsB: 9, numCtx: 8192, description: 'Modelos até ~8B. Mais inteligência; parte das camadas roda na CPU com 4 GB de VRAM, então é mais lento.' },
};

/** Catálogo de modelos recomendados (tamanhos de download do registro Ollama, aproximados). */
export const CATALOG = [
  { name: 'qwen3:1.7b', profile: 'ECO', sizeGb: 1.4, purpose: 'Conversa e ferramentas simples', tools: true, vision: false },
  { name: 'qwen3:4b-instruct-2507-q4_K_M', profile: 'BALANCED', sizeGb: 2.5, purpose: 'Assistente principal com tool calling', tools: true, vision: false },
  { name: 'qwen3:8b', profile: 'MAXIMUM', sizeGb: 5.2, purpose: 'Raciocínio e planejamento mais fortes', tools: true, vision: false },
  { name: 'qwen2.5-coder:7b', profile: 'MAXIMUM', sizeGb: 4.7, purpose: 'Programação', tools: true, vision: false },
  { name: 'qwen2.5vl:3b', profile: 'BALANCED', sizeGb: 3.2, purpose: 'Visão: interpretar telas e imagens', tools: false, vision: true },
  { name: 'gemma3:4b', profile: 'BALANCED', sizeGb: 3.3, purpose: 'Visão e conversa multilíngue', tools: false, vision: true },
  { name: 'nomic-embed-text', profile: 'ECO', sizeGb: 0.27, purpose: 'Embeddings para memória semântica', tools: false, vision: false },
] as const;

export function paramsB(t: Pick<ModelTag, 'details' | 'size'>): number {
  const ps = t.details?.parameter_size ?? '';
  const m = ps.match(/([\d.]+)\s*([BM])/i);
  if (m) return m[2]!.toUpperCase() === 'M' ? Number(m[1]) / 1000 : Number(m[1]);
  return t.size / 0.6e9; // estimativa grosseira para Q4
}

/** Memória estimada para rodar: pesos + cache KV + overhead. */
export function estimateMemoryGb(t: Pick<ModelTag, 'size' | 'details'>, numCtx: number): number {
  const weights = t.size / 1073741824;
  const kv = (paramsB(t) * numCtx) / 8192 * 0.18;
  return Math.round((weights + kv + 0.4) * 10) / 10;
}

export type ModelView = ModelTag & { paramsB: number; capabilities: string[]; estimatedMemoryGb: number; kind: 'chat' | 'embedding' | 'vision' };

export class ModelRouter {
  private hw: HardwareInfo | null = null;
  constructor(private ollama: OllamaClient, private db: Db) {}

  setHardware(hw: HardwareInfo) {
    this.hw = hw;
  }

  get profile(): Profile {
    return this.db.getSetting<Profile>('model.profile', 'BALANCED');
  }
  set profile(p: Profile) {
    this.db.setSetting('model.profile', p);
  }
  get override(): string | null {
    return this.db.getSetting<string | null>('model.override', null);
  }
  set override(m: string | null) {
    this.db.setSetting('model.override', m);
  }

  async models(): Promise<ModelView[]> {
    const tags = await this.ollama.tags();
    const out: ModelView[] = [];
    for (const t of tags) {
      const show = await this.ollama.show(t.name).catch(() => ({ capabilities: [] as string[] }));
      const caps = show.capabilities ?? [];
      const kind = caps.includes('embedding') || /bert|embed/i.test(t.details?.family ?? '') ? 'embedding' : caps.includes('vision') ? 'vision' : 'chat';
      out.push({ ...t, paramsB: Math.round(paramsB(t) * 10) / 10, capabilities: caps, estimatedMemoryGb: estimateMemoryGb(t, PROFILES[this.profile].numCtx), kind });
    }
    return out;
  }

  /** Memória disponível para o modelo: VRAM livre + RAM livre menos margem para o sistema. */
  budgetGb(): number {
    const freeRam = os.freemem() / 1073741824;
    const vram = (this.hw?.gpus ?? []).reduce((s, g) => s + ((g.vramTotalMb ?? 0) - (g.vramUsedMb ?? 0)) / 1024, 0);
    return Math.max(0.5, freeRam - 1.5 + vram);
  }

  async pick(cls: TaskClass): Promise<{ model: string; numCtx: number; reason: string } | null> {
    const profile = PROFILES[this.profile];
    const all = await this.models().catch(() => [] as ModelView[]);
    if (cls === 'embed') {
      const e = all.find((m) => m.kind === 'embedding');
      return e ? { model: e.name, numCtx: 2048, reason: 'modelo de embeddings instalado' } : null;
    }
    if (cls === 'vision') {
      const v = await this.pickVisionModel();
      return v ? { model: v, numCtx: profile.numCtx, reason: 'modelo com capacidade de visão' } : null;
    }
    const chatModels = all.filter((m) => m.kind !== 'embedding' && m.capabilities.includes('completion'));
    if (this.override && chatModels.some((m) => m.name === this.override)) {
      return { model: this.override, numCtx: profile.numCtx, reason: 'seleção manual' };
    }
    const needsTools = cls === 'tools' || cls === 'code';
    const budget = this.budgetGb();
    const maxP = cls === 'fast' ? Math.min(profile.maxParamsB, 2.1) : profile.maxParamsB;
    const ranked = chatModels
      .filter((m) => !needsTools || m.capabilities.includes('tools'))
      .map((m) => {
        let score = m.paramsB <= maxP ? m.paramsB : -m.paramsB; // maior que caiba no perfil
        if (m.estimatedMemoryGb > budget) score -= 100; // não cabe na memória livre agora
        if (cls === 'code' && /coder/i.test(m.name)) score += 3;
        if (cls === 'fast' && m.paramsB <= 2.1) score += 2;
        return { m, score };
      })
      .sort((a, b) => b.score - a.score);
    // Fallback: modelo já carregado evita troca de modelo (latência de carga).
    const best = ranked[0];
    if (!best) {
      log.warn(`nenhum modelo adequado para ${cls}`);
      return null;
    }
    if (cls === 'fast') {
      const loaded = new Set((await this.ollama.ps().catch(() => [])).map((p) => p.name));
      const loadedCandidate = ranked.find((r) => loaded.has(r.m.name) && r.score > -100);
      if (loadedCandidate && loadedCandidate.m.paramsB <= profile.maxParamsB) {
        return { model: loadedCandidate.m.name, numCtx: profile.numCtx, reason: 'modelo já carregado (evita troca)' };
      }
    }
    return { model: best.m.name, numCtx: profile.numCtx, reason: `${this.profile}: ${best.m.paramsB}B, ~${best.m.estimatedMemoryGb} GB (orçamento ${budget.toFixed(1)} GB)` };
  }

  async pickVisionModel(): Promise<string | null> {
    const all = await this.models().catch(() => [] as ModelView[]);
    return all.filter((m) => m.capabilities.includes('vision')).sort((a, b) => a.paramsB - b.paramsB)[0]?.name ?? null;
  }

  /** Sugestão de perfil baseada no hardware detectado. */
  static suggest(hw: HardwareInfo): { profile: Profile; reason: string } {
    const vram = Math.max(0, ...hw.gpus.map((g) => g.vramTotalMb ?? 0)) / 1024;
    if (hw.ramTotalGb < 10) return { profile: 'ECO', reason: `${hw.ramTotalGb} GB de RAM: modelos pequenos evitam travamentos.` };
    if (vram >= 8 && hw.ramTotalGb >= 16) return { profile: 'MAXIMUM', reason: `${vram.toFixed(0)} GB de VRAM comportam modelos de 8B inteiros na GPU.` };
    return { profile: 'BALANCED', reason: `${hw.ramTotalGb} GB de RAM e ${vram.toFixed(1)} GB de VRAM: modelos de ~4B quantizados têm a melhor latência.` };
  }
}
