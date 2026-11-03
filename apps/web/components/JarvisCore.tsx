'use client';
import { useEffect, useRef } from 'react';
import type { CoreVisualState } from '@jarvis/contracts';

type Props = { state: CoreVisualState; level?: number; size?: number; className?: string };

const PALETTE: Record<CoreVisualState, { hue: [number, number, number]; speed: number; intensity: number }> = {
  idle: { hue: [16, 185, 129], speed: 0.25, intensity: 0.55 },
  listening: { hue: [52, 211, 153], speed: 0.5, intensity: 0.85 },
  thinking: { hue: [110, 231, 183], speed: 1.6, intensity: 0.9 },
  speaking: { hue: [167, 243, 208], speed: 0.8, intensity: 1 },
  executing: { hue: [16, 185, 129], speed: 1.2, intensity: 0.95 },
  success: { hue: [53, 212, 154], speed: 0.6, intensity: 0.9 },
  error: { hue: [255, 93, 103], speed: 0.9, intensity: 0.9 },
  offline: { hue: [110, 118, 132], speed: 0.08, intensity: 0.25 },
};

type Particle = { a: number; r: number; v: number; s: number; life: number };

/**
 * Núcleo Lume em Canvas 2D. Custo baixo: ~30 fps em repouso, 60 fps quando
 * ativo, pausa com a aba oculta e respeita "reduzir movimento".
 */
export function JarvisCore({ state, level = 0, size = 340, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  const levelRef = useRef(level);
  stateRef.current = state;
  levelRef.current = level;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d', { alpha: true })!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduced';
    const particles: Particle[] = Array.from({ length: 70 }, () => spawn(size));
    const color = { r: 255, g: 106, b: 0 };
    let t = 0, raf = 0, lastFrame = 0, smoothLevel = 0, pulse = 0, prevState = stateRef.current;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const st = stateRef.current;
      const cfg = PALETTE[st];
      const active = st !== 'idle' && st !== 'offline';
      const minDt = reduced ? 1000 / 12 : active ? 1000 / 60 : 1000 / 30;
      if (now - lastFrame < minDt) return;
      const dt = Math.min(0.05, (now - lastFrame) / 1000);
      lastFrame = now;
      if (st !== prevState) { pulse = 1; prevState = st; }
      pulse = Math.max(0, pulse - dt * 1.4);
      t += dt * cfg.speed * (reduced ? 0.3 : 1);
      smoothLevel += (levelRef.current - smoothLevel) * 0.25;
      // transição suave de cor
      color.r += (cfg.hue[0] - color.r) * 0.08;
      color.g += (cfg.hue[1] - color.g) * 0.08;
      color.b += (cfg.hue[2] - color.b) * 0.08;
      const c = (a: number) => `rgba(${color.r | 0},${color.g | 0},${color.b | 0},${a})`;
      const cx = size / 2, cy = size / 2, R = size * 0.3;
      const lv = st === 'listening' || st === 'speaking' ? smoothLevel : 0;
      ctx.clearRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'lighter';

      // halo
      const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * (1.65 + lv * 0.6 + pulse * 0.2));
      halo.addColorStop(0, c(0.22 * cfg.intensity + lv * 0.2));
      halo.addColorStop(0.45, c(0.07 * cfg.intensity));
      halo.addColorStop(1, c(0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, size, size);

      // anéis concêntricos com arcos girando em sentidos opostos
      const rings = [
        { r: R * 1.18, w: 1, dash: [2, 7], dir: 1, sp: 0.35, a: 0.35 },
        { r: R * 1.02, w: 1.6, dash: [R * 0.9, R * 0.35], dir: -1, sp: 0.6, a: 0.75 },
        { r: R * 0.86, w: 1, dash: [1, 4], dir: 1, sp: 0.9, a: 0.45 },
        { r: R * 0.7, w: 2.4, dash: [R * 0.35, R * 0.22], dir: -1, sp: 1.3, a: 0.85 },
        { r: R * 0.55, w: 1, dash: [], dir: 1, sp: 0, a: 0.25 },
      ];
      for (const ring of rings) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(t * ring.sp * ring.dir * (st === 'thinking' ? 1.8 : 1));
        ctx.beginPath();
        ctx.setLineDash(ring.dash);
        ctx.lineWidth = ring.w;
        ctx.strokeStyle = c(ring.a * cfg.intensity);
        ctx.shadowColor = c(0.9);
        ctx.shadowBlur = 8;
        ctx.arc(0, 0, ring.r * (1 + lv * 0.08), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // marcadores de circuito (EXECUTING) — ticks em movimento
      if (st === 'executing' || st === 'thinking') {
        ctx.save();
        ctx.translate(cx, cy);
        for (let i = 0; i < 48; i++) {
          const ang = (i / 48) * Math.PI * 2 + t * 0.8;
          const on = (Math.sin(i * 1.7 + t * 6) + 1) / 2;
          ctx.strokeStyle = c(0.15 + on * 0.6);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(Math.cos(ang) * R * 1.28, Math.sin(ang) * R * 1.28);
          ctx.lineTo(Math.cos(ang) * R * (1.32 + on * 0.06), Math.sin(ang) * R * (1.32 + on * 0.06));
          ctx.stroke();
        }
        ctx.restore();
      }

      // forma de onda circular (LISTENING / SPEAKING)
      if (st === 'listening' || st === 'speaking' || st === 'idle') {
        ctx.beginPath();
        const amp = (st === 'idle' ? 1.5 : 4) + lv * R * 0.32;
        for (let i = 0; i <= 120; i++) {
          const ang = (i / 120) * Math.PI * 2;
          const n = Math.sin(ang * 6 + t * 5) * 0.5 + Math.sin(ang * 11 - t * 7) * 0.3 + Math.sin(ang * 3 + t * 2) * 0.2;
          const rr = R * 0.62 + n * amp;
          const x = cx + Math.cos(ang) * rr, y = cy + Math.sin(ang) * rr;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = c(0.7 * cfg.intensity);
        ctx.setLineDash([]);
        ctx.stroke();
      }

      // núcleo
      const coreR = R * (0.34 + lv * 0.12 + Math.sin(t * 2.2) * 0.012 + pulse * 0.05);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      g.addColorStop(0, `rgba(255,245,235,${0.9 * cfg.intensity})`);
      g.addColorStop(0.35, c(0.85 * cfg.intensity));
      g.addColorStop(1, c(0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      // partículas orbitando / fluindo para o centro (THINKING)
      for (const p of particles) {
        p.a += dt * p.v * (st === 'thinking' ? 3 : 1) * (reduced ? 0.2 : 1);
        if (st === 'thinking' || st === 'executing') p.r -= dt * 18;
        p.life -= dt * 0.15;
        if (p.r < R * 0.3 || p.life <= 0) Object.assign(p, spawn(size));
        const x = cx + Math.cos(p.a) * p.r, y = cy + Math.sin(p.a) * p.r;
        ctx.fillStyle = c(Math.min(1, p.life) * 0.8 * cfg.intensity);
        ctx.beginPath();
        ctx.arc(x, y, p.s * (1 + lv), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    };
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [size]);

  return <canvas ref={ref} role="img" aria-label={`Núcleo Lume: ${LABEL[state]}`} style={{ width: size, height: size }} className={className} />;
}

function spawn(size: number): Particle {
  const R = size * 0.3;
  return { a: Math.random() * Math.PI * 2, r: R * (0.9 + Math.random() * 0.75), v: (Math.random() - 0.5) * 0.9, s: 0.6 + Math.random() * 1.3, life: 0.4 + Math.random() };
}

export const LABEL: Record<CoreVisualState, string> = {
  idle: 'Em espera', listening: 'Ouvindo', thinking: 'Pensando', speaking: 'Falando', executing: 'Executando', success: 'Concluído', error: 'Erro', offline: 'Offline',
};
