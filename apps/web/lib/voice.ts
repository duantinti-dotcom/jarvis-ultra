'use client';
/** Captura de microfone com VAD por energia (piso de ruído adaptativo) e gravação PCM. */
export type MicHandle = { stop: () => void; level: () => number; ctx: AudioContext };

export async function openMic(opts: {
  onSpeechStart: () => void;
  onSpeechEnd: (wav: Blob, durationMs: number) => void;
  silenceMs?: number;
  minSpeechMs?: number;
  /** Multiplicador sobre o piso de ruído; maior = menos sensível (usado durante a fala do JARVIS). */
  sensitivity?: () => number;
}): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  src.connect(proc);
  proc.connect(ctx.destination);
  const silenceMs = opts.silenceMs ?? 750;
  const minSpeechMs = opts.minSpeechMs ?? 250;
  let floor = 0.01, level = 0, speaking = false, speechStart = 0, lastVoice = 0;
  let chunks: Float32Array[] = [];
  const pre: Float32Array[] = []; // pré-roll para não cortar o início da fala

  proc.onaudioprocess = (ev) => {
    const data = ev.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
    const rms = Math.sqrt(sum / data.length);
    level = Math.min(1, rms * 8);
    const now = performance.now();
    if (!speaking) floor = floor * 0.97 + Math.min(rms, floor * 2) * 0.03;
    const threshold = Math.max(0.012, floor * (opts.sensitivity?.() ?? 3));
    const copy = new Float32Array(data);
    if (rms > threshold) {
      lastVoice = now;
      if (!speaking) {
        speaking = true;
        speechStart = now;
        chunks = [...pre];
        opts.onSpeechStart();
      }
    }
    if (speaking) {
      chunks.push(copy);
      if (now - lastVoice > silenceMs) {
        speaking = false;
        const dur = now - speechStart;
        if (dur - silenceMs >= minSpeechMs) opts.onSpeechEnd(encodeWav(chunks, ctx.sampleRate), dur);
        chunks = [];
      }
    } else {
      pre.push(copy);
      if (pre.length > 3) pre.shift();
    }
  };

  return {
    ctx,
    level: () => level,
    stop: () => {
      proc.disconnect();
      src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

/** Reamostra para 16 kHz mono e gera WAV PCM 16 bits (formato do whisper.cpp). */
export function encodeWav(chunks: Float32Array[], rate: number, target = 16000): Blob {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { merged.set(c, o); o += c.length; }
  const ratio = rate / target;
  const len = Math.floor(merged.length / ratio);
  const out = new DataView(new ArrayBuffer(44 + len * 2));
  const w = (p: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(p + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + len * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, target, true); out.setUint32(28, target * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) {
    // média simples da janela (anti-aliasing básico)
    const start = Math.floor(i * ratio), end = Math.min(merged.length, Math.floor((i + 1) * ratio));
    let acc = 0;
    for (let j = start; j < end; j++) acc += merged[j]!;
    const v = Math.max(-1, Math.min(1, acc / Math.max(1, end - start)));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

/** Limpa Markdown e o rodapé de verificação antes de falar. */
export function speakable(text: string) {
  return text
    .split(/\n-{3,}\n/)[0]!
    .replace(/```[\s\S]*?```/g, ' (código na tela) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*|__|[#>*_]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extrai frases completas de um buffer em streaming. */
export function takeSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buf;
  const re = /^([\s\S]{12,}?[.!?…:;\n])(\s+|$)/;
  let m: RegExpMatchArray | null;
  while ((m = rest.match(re))) {
    sentences.push(m[1]!.trim());
    rest = rest.slice(m[0].length);
  }
  return { sentences, rest };
}

type SR = { lang: string; continuous: boolean; interimResults: boolean; start: () => void; stop: () => void; abort: () => void; onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null; onspeechstart: (() => void) | null };
export function browserRecognition(): SR | null {
  const W = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
  if (!Ctor) return null;
  const r = new Ctor();
  r.lang = 'pt-BR';
  r.continuous = true;
  r.interimResults = true;
  return r;
}

export function ptVoices(): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === 'undefined') return [];
  const all = speechSynthesis.getVoices();
  const pt = all.filter((v) => v.lang.toLowerCase().startsWith('pt'));
  return pt.length ? pt.sort((a, b) => Number(b.lang === 'pt-BR') - Number(a.lang === 'pt-BR')) : all;
}
