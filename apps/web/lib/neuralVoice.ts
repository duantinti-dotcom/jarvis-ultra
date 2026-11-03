'use client';
/**
 * Voz neural masculina (Piper "faber", pt-BR) rodando no próprio navegador:
 * nada de chave nem servidor. Baixa ~80 MB uma única vez (fica no cache).
 * O áudio sai como AudioBuffer, então dá para aplicar o efeito "Lume".
 */
type Ort = {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  InferenceSession: { create(b: ArrayBuffer): Promise<{ run(i: Record<string, unknown>): Promise<{ output: { data: Float32Array } }> }> };
  Tensor: new (type: string, data: unknown, dims?: number[]) => unknown;
};
type PhonemizeModule = { callMain(args: string[]): void };
type PhonemizeFactory = (o: Record<string, unknown>) => Promise<PhonemizeModule>;

const ORT = 'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/';
const PHON = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';
const MODEL = 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx';

export type NeuralState = { status: 'idle' | 'loading' | 'ready' | 'error'; progress: number; error?: string };
let state: NeuralState = { status: 'idle', progress: 0 };
const listeners = new Set<(s: NeuralState) => void>();
const set = (s: Partial<NeuralState>) => { state = { ...state, ...s }; listeners.forEach((f) => f(state)); };
export const neuralState = () => state;
export const onNeuralState = (f: (s: NeuralState) => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

function loadScript(src: string): Promise<void> {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous'; s.dataset.src = src;
    s.onload = () => res(); s.onerror = () => rej(new Error(`não carregou ${src}`));
    document.head.appendChild(s);
  });
}

async function cached(url: string, onProgress?: (p: number) => void): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try { cache = await caches.open('jarvis-voice-v1'); const hit = await cache.match(url); if (hit) return await hit.arrayBuffer(); } catch { cache = null; }
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`download falhou (HTTP ${r.status})`);
  const total = Number(r.headers.get('content-length') ?? 0);
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (total) onProgress?.(got / total);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  try { await cache?.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); } catch { /* sem espaço: segue sem cache */ }
  return buf.buffer;
}

let ready: Promise<void> | null = null;
let session: Awaited<ReturnType<Ort['InferenceSession']['create']>> | null = null;
let config: { audio: { sample_rate: number }; espeak: { voice: string }; inference: { noise_scale: number; length_scale: number; noise_w: number } } | null = null;
let wasmBinary: ArrayBuffer | null = null;

/** Prepara a voz (pode ser chamado várias vezes). */
export function prepareNeuralVoice(): Promise<void> {
  if (ready) return ready;
  set({ status: 'loading', progress: 0, error: undefined });
  ready = (async () => {
    await Promise.all([loadScript(`${ORT}ort.min.js`), loadScript(`${PHON}.js`)]);
    const ort = (window as unknown as { ort: Ort }).ort;
    ort.env.wasm.wasmPaths = ORT;
    ort.env.wasm.numThreads = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    const [cfg, model, wasm] = await Promise.all([
      cached(`${MODEL}.json`).then((b) => JSON.parse(new TextDecoder().decode(b))),
      cached(MODEL, (p) => set({ progress: Math.round(p * 100) })),
      cached(`${PHON}.wasm`),
    ]);
    config = cfg; wasmBinary = wasm;
    session = await ort.InferenceSession.create(model);
    set({ status: 'ready', progress: 100 });
  })().catch((e) => { ready = null; set({ status: 'error', error: (e as Error).message }); throw e; });
  return ready;
}

let phon: Promise<PhonemizeModule> | null = null;
let onLine: ((l: string) => void) | null = null;
/** O módulo do eSpeak é criado uma vez e reaproveitado (evita recarregar 18 MB a cada frase). */
async function phonemize(text: string): Promise<number[]> {
  const factory = (window as unknown as { createPiperPhonemize: PhonemizeFactory }).createPiperPhonemize;
  phon ??= factory({
    noInitialRun: true, noExitRuntime: true,
    print: (l: string) => onLine?.(l),
    printErr: () => {},
    locateFile: (f: string) => (f.endsWith('.wasm') ? `${PHON}.wasm` : f.endsWith('.data') ? `${PHON}.data` : f),
    wasmBinary: wasmBinary ?? undefined,
  });
  const m = await phon;
  return new Promise<number[]>((resolve, reject) => {
    onLine = (l) => { try { const j = JSON.parse(l); if (j.phoneme_ids) resolve(j.phoneme_ids); } catch (e) { reject(e); } };
    try { m.callMain(['-l', config!.espeak.voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']); } catch (e) { phon = null; reject(e); }
    setTimeout(() => reject(new Error('fonemas: sem resposta')), 4000);
  });
}

let chain: Promise<unknown> = Promise.resolve();
/** Sintetiza uma frase (as chamadas são enfileiradas: uma sessão por vez). */
export function synthNeural(ctx: BaseAudioContext, text: string, speed = 1): Promise<AudioBuffer> {
  const job = chain.then(async () => {
    await prepareNeuralVoice();
    const ort = (window as unknown as { ort: Ort }).ort;
    const ids = await phonemize(text);
    const inf = config!.inference;
    const out = await session!.run({
      input: new ort.Tensor('int64', BigInt64Array.from(ids.map((n) => BigInt(n))), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale, inf.length_scale / speed, inf.noise_w]), [3]),
    });
    const data = out.output.data;
    const buf = ctx.createBuffer(1, data.length, config!.audio.sample_rate);
    buf.copyToChannel(Float32Array.from(data), 0);
    return buf;
  });
  chain = job.catch(() => {});
  return job;
}

// ---------------------------------------------------------------- efeito "Lume"
const irCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function impulse(ctx: BaseAudioContext) {
  let ir = irCache.get(ctx);
  if (ir) return ir;
  const len = Math.floor(ctx.sampleRate * 0.9);
  ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
  }
  irCache.set(ctx, ir);
  return ir;
}

/**
 * Toca o áudio com o timbre de IA: presença nos agudos, leve dobra metálica
 * (chorus curto + ressonância de pente) e uma ambiência discreta de "sala".
 * Devolve o nó de análise (para animar a esfera) e uma função para parar.
 */
export function playJarvis(ctx: AudioContext, buffer: AudioBuffer, opts: { fx: boolean; onEnd: () => void }) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const out = ctx.createDynamicsCompressor();
  out.threshold.value = -18; out.ratio.value = 3; out.attack.value = 0.004; out.release.value = 0.2;
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  out.connect(an); an.connect(ctx.destination);
  const nodes: AudioNode[] = [src, out, an];
  const stopLfo: (() => void)[] = [];
  if (!opts.fx) {
    src.connect(out);
  } else {
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 95;
    const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 180; low.gain.value = 2.5;
    const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3000; pres.Q.value = 0.9; pres.gain.value = 2.5;
    const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 7500; air.gain.value = 2;
    src.connect(hp); hp.connect(low); low.connect(pres); pres.connect(air);
    const dry = ctx.createGain(); dry.gain.value = 0.95;
    air.connect(dry); dry.connect(out);
    // dobra metálica (chorus curto modulado)
    const dly = ctx.createDelay(0.05); dly.delayTime.value = 0.009;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.35;
    const depth = ctx.createGain(); depth.gain.value = 0.0008;
    lfo.connect(depth); depth.connect(dly.delayTime); lfo.start();
    stopLfo.push(() => { try { lfo.stop(); } catch { /* */ } });
    const wet = ctx.createGain(); wet.gain.value = 0.16;
    air.connect(dly); dly.connect(wet); wet.connect(out);
    // ambiência
    const verb = ctx.createConvolver(); verb.buffer = impulse(ctx);
    const vg = ctx.createGain(); vg.gain.value = 0.07;
    air.connect(verb); verb.connect(vg); vg.connect(out);
    nodes.push(hp, low, pres, air, dry, dly, lfo, depth, wet, verb, vg);
  }
  let ended = false;
  const finish = () => {
    if (ended) return; ended = true;
    stopLfo.forEach((f) => f());
    setTimeout(() => nodes.forEach((n) => { try { n.disconnect(); } catch { /* */ } }), 900);
    opts.onEnd();
  };
  src.onended = finish;
  src.start();
  return { analyser: an, stop: () => { try { src.stop(); } catch { /* */ } finish(); } };
}

/** Vozes masculinas conhecidas dos navegadores/Windows (pt-BR e pt-PT). */
const MALE = /antonio|daniel|donato|fabio|f[áa]bio|humberto|julio|j[úu]lio|nicolau|valerio|val[ée]rio|duarte|felipe|ricardo|cristiano|male|masculin/i;
export function maleVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const pt = voices.filter((v) => v.lang.toLowerCase().startsWith('pt'));
  const score = (v: SpeechSynthesisVoice) => (MALE.test(v.name) ? 20 : 0) + (/natural|neural|online|premium|enhanced/i.test(v.name) ? 10 : 0) + (v.lang === 'pt-BR' ? 3 : 0);
  const best = pt.sort((a, b) => score(b) - score(a))[0] ?? null;
  return best && MALE.test(best.name) ? best : null;
}
