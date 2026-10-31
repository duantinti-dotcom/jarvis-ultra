import type { JsonSchema } from '@jarvis/contracts';

/** Validação de argumentos contra o subconjunto de JSON Schema usado nos manifestos. */
export function validateArgs(schema: JsonSchema, args: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return { ok: false, error: 'Argumentos devem ser um objeto.' };
  const a = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const req of schema.required ?? []) {
    if (a[req] === undefined || a[req] === null || a[req] === '') return { ok: false, error: `Parâmetro obrigatório ausente: ${req}` };
  }
  for (const [k, v] of Object.entries(a)) {
    const prop = schema.properties[k];
    if (!prop) {
      if (schema.additionalProperties === false) return { ok: false, error: `Parâmetro desconhecido: ${k}` };
      continue;
    }
    const coerced = coerce(prop.type, v);
    if (coerced === INVALID) return { ok: false, error: `Parâmetro ${k} deve ser do tipo ${prop.type}.` };
    if (prop.enum && !prop.enum.includes(String(coerced))) return { ok: false, error: `Parâmetro ${k} deve ser um de: ${prop.enum.join(', ')}` };
    out[k] = coerced;
  }
  for (const [k, prop] of Object.entries(schema.properties)) {
    if (out[k] === undefined && prop.default !== undefined) out[k] = prop.default;
  }
  return { ok: true, value: out };
}

const INVALID = Symbol('invalid');

function coerce(type: string, v: unknown): unknown {
  switch (type) {
    case 'string':
      return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : INVALID;
    case 'number':
    case 'integer': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || Number.isNaN(n)) return INVALID;
      return type === 'integer' ? Math.trunc(n) : n;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true') return true;
      if (v === 'false') return false;
      return INVALID;
    case 'array':
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') {
        try {
          const p = JSON.parse(v);
          if (Array.isArray(p)) return p;
        } catch {}
      }
      return INVALID;
    case 'object':
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v;
      if (typeof v === 'string') {
        try {
          const p = JSON.parse(v);
          if (typeof p === 'object' && p !== null) return p;
        } catch {}
      }
      return INVALID;
    default:
      return v;
  }
}
