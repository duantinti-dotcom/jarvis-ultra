'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Revela o texto em streaming de forma fluida (como o Claude): em vez de despejar
 * cada pedaço que chega da rede, avança alguns caracteres por quadro, acelerando
 * quando há muito texto acumulado para nunca ficar para trás.
 * Mensagens que já chegaram prontas (histórico) aparecem inteiras na hora.
 */
export function useSmoothText(target: string, streaming: boolean): string {
  const [shown, setShown] = useState(() => (streaming ? '' : target));
  const pos = useRef(streaming ? 0 : target.length);
  const targetRef = useRef(target);
  const raf = useRef<number | null>(null);
  const last = useRef(0);
  const live = useRef(streaming);
  targetRef.current = target;
  if (streaming) live.current = true;

  useEffect(() => {
    if (!live.current) { pos.current = target.length; setShown(target); return; }
    if (pos.current > target.length) pos.current = target.length; // texto truncado/regenerado
    const tick = (now: number) => {
      const t = targetRef.current;
      const dt = last.current ? Math.min(64, now - last.current) : 16;
      last.current = now;
      const backlog = t.length - pos.current;
      if (backlog <= 0) { raf.current = null; last.current = 0; return; }
      // voltou de outra aba/janela com muito texto acumulado: mostra direto, sem replay lento
      if (backlog > 600 || (typeof document !== 'undefined' && document.hidden)) { pos.current = t.length; setShown(t); raf.current = null; last.current = 0; return; }
      // rápido como o ChatGPT: ≥ 320 caracteres/s e esvazia o acumulado em ~160 ms.
      const step = Math.max(1, Math.round(Math.max(320 * (dt / 1000), backlog * (dt / 160))));
      let next = Math.min(t.length, pos.current + step);
      // não corta pares substitutos (emoji)
      const c = t.charCodeAt(next - 1);
      if (c >= 0xd800 && c <= 0xdbff && next < t.length) next++;
      pos.current = next;
      setShown(t.slice(0, next));
      raf.current = requestAnimationFrame(tick);
    };
    if (raf.current == null) raf.current = requestAnimationFrame(tick);
  }, [target]);

  // terminou: garante o texto completo assim que a animação alcançar
  useEffect(() => {
    if (!streaming && live.current && pos.current >= targetRef.current.length) setShown(targetRef.current);
  }, [streaming, shown]);

  useEffect(() => () => { if (raf.current != null) cancelAnimationFrame(raf.current); }, []);
  return shown;
}
