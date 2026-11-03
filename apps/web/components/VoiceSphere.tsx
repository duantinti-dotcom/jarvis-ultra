'use client';
import { useEffect, useRef } from 'react';

export type SphereState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error' | 'offline';
const COLORS: Record<SphereState, [number, number, number]> = {
  idle: [16, 185, 129], listening: [52, 211, 153], thinking: [110, 231, 183], speaking: [167, 243, 208], error: [255, 93, 103], offline: [110, 116, 128],
};

/**
 * Esfera de pontos em projeção 3D (Canvas 2D, sem WebGL): leve o bastante para não
 * competir com o modelo local. O raio e o brilho reagem ao volume real do áudio.
 */
export function VoiceSphere({ state, level, size = 360 }: { state: SphereState; level: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const st = useRef(state);
  const lv = useRef(level);
  st.current = state;
  lv.current = level;
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = size * dpr;
    c.height = size * dpr;
    ctx.scale(dpr, dpr);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const N = 520;
    const pts = Array.from({ length: N }, (_, i) => {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = i * Math.PI * (3 - Math.sqrt(5));
      return { x: Math.cos(th) * r, y, z: Math.sin(th) * r, seed: Math.random() * 6.28 };
    });
    const col = [...COLORS.idle];
    let raf = 0, t = 0, last = 0, smooth = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const s = st.current;
      const active = s !== 'idle' && s !== 'offline';
      if (now - last < (reduced ? 80 : active ? 16 : 33)) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const target = COLORS[s];
      for (let k = 0; k < 3; k++) col[k]! += (target[k]! - col[k]!) * 0.08;
      smooth += ((s === 'listening' || s === 'speaking' ? lv.current : 0) - smooth) * 0.22;
      const speed = s === 'thinking' ? 1.6 : s === 'speaking' ? 0.8 : s === 'listening' ? 0.6 : 0.25;
      t += dt * speed * (reduced ? 0.3 : 1);
      const cx = size / 2, cy = size / 2;
      const R = size * 0.27 * (1 + smooth * 0.22);
      const rgb = (a: number) => `rgba(${col[0]! | 0},${col[1]! | 0},${col[2]! | 0},${a})`;
      ctx.clearRect(0, 0, size, size);
      // halo
      const g = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.9);
      g.addColorStop(0, rgb(0.22 + smooth * 0.25));
      g.addColorStop(0.5, rgb(0.06));
      g.addColorStop(1, rgb(0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'lighter';
      const cosA = Math.cos(t * 0.6), sinA = Math.sin(t * 0.6), cosB = Math.cos(0.35), sinB = Math.sin(0.35);
      for (const p of pts) {
        // deformação orgânica com o áudio
        const wob = 1 + (s === 'thinking' ? 0.04 : 0) * Math.sin(t * 6 + p.seed) + smooth * 0.18 * Math.sin(p.y * 7 + t * 9 + p.seed);
        let x = p.x * wob, y = p.y * wob, z = p.z * wob;
        const x1 = x * cosA - z * sinA; z = x * sinA + z * cosA; x = x1;
        const y1 = y * cosB - z * sinB; z = y * sinB + z * cosB; y = y1;
        const depth = (z + 1.6) / 2.6;
        const px = cx + x * R, py = cy + y * R;
        ctx.fillStyle = rgb(0.12 + depth * 0.75);
        ctx.beginPath();
        ctx.arc(px, py, 0.6 + depth * 1.5, 0, 6.283);
        ctx.fill();
      }
      // anéis
      for (let k = 0; k < 3; k++) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, R * (1.32 + k * 0.14), R * (0.32 + k * 0.05), t * (0.4 + k * 0.2) * (k % 2 ? -1 : 1), 0, 6.283);
        ctx.strokeStyle = rgb(0.18 - k * 0.04 + smooth * 0.2);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // núcleo
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * (0.42 + smooth * 0.2));
      core.addColorStop(0, 'rgba(255,246,236,0.85)');
      core.addColorStop(0.4, rgb(0.6));
      core.addColorStop(1, rgb(0));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.6, 0, 6.283);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    };
    raf = requestAnimationFrame(draw);
    const vis = () => { cancelAnimationFrame(raf); if (!document.hidden) raf = requestAnimationFrame(draw); };
    document.addEventListener('visibilitychange', vis);
    return () => { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', vis); };
  }, [size]);
  return <canvas ref={ref} style={{ width: size, height: size }} role="img" aria-label={`Lume: ${state}`} />;
}
