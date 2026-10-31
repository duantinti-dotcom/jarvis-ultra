import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { run, which } from '../util/proc.js';
import { newId } from '../util/ids.js';
import { logger } from '../log.js';

const log = logger('voice');

export type VoiceStatus = {
  stt: { engine: 'whisper.cpp' | 'faster-whisper' | null; model: string | null; detail: string };
  tts: { engine: 'piper' | null; voices: string[]; detail: string };
};

/**
 * Voz local. Procura binários e modelos em <dados>/voice ou nas variáveis
 * JARVIS_WHISPER_BIN, JARVIS_WHISPER_MODEL, JARVIS_PIPER_BIN, JARVIS_PIPER_VOICES.
 * Quando nada estiver instalado a interface usa as APIs de voz do navegador.
 */
export class VoiceEngine {
  private dir: string;
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'voice');
    fs.mkdirSync(path.join(this.dir, 'tmp'), { recursive: true });
  }

  private find(dir: string, re: RegExp): string[] {
    try {
      return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }

  async whisper(): Promise<{ bin: string; model: string } | null> {
    const exe = process.platform === 'win32' ? '.exe' : '';
    const bin = process.env.JARVIS_WHISPER_BIN ?? [path.join(this.dir, 'whisper', `whisper-cli${exe}`), path.join(this.dir, 'whisper', `main${exe}`)].find((p) => fs.existsSync(p)) ?? (await which('whisper-cli'));
    const model = process.env.JARVIS_WHISPER_MODEL ?? this.find(path.join(this.dir, 'whisper'), /^ggml-.*\.bin$/).sort((a, b) => rank(a) - rank(b))[0];
    return bin && model && fs.existsSync(model) ? { bin, model } : null;
  }

  async fasterWhisper(): Promise<string | null> {
    const py = process.env.JARVIS_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const r = await run(py, ['-c', 'import faster_whisper; print("ok")'], { timeoutMs: 8000 }).catch(() => null);
    return r?.code === 0 ? py : null;
  }

  async piper(): Promise<{ bin: string; voices: string[] } | null> {
    const exe = process.platform === 'win32' ? '.exe' : '';
    const bin = process.env.JARVIS_PIPER_BIN ?? [path.join(this.dir, 'piper', `piper${exe}`)].find((p) => fs.existsSync(p)) ?? (await which('piper'));
    const voiceDir = process.env.JARVIS_PIPER_VOICES ?? path.join(this.dir, 'piper');
    const voices = this.find(voiceDir, /\.onnx$/);
    return bin && voices.length ? { bin, voices } : null;
  }

  async status(): Promise<VoiceStatus> {
    const w = await this.whisper();
    const fw = w ? null : await this.fasterWhisper();
    const p = await this.piper();
    return {
      stt: w ? { engine: 'whisper.cpp', model: path.basename(w.model), detail: 'local' } : fw ? { engine: 'faster-whisper', model: process.env.JARVIS_FW_MODEL ?? 'small', detail: 'local (Python)' } : { engine: null, model: null, detail: `Instale whisper.cpp em ${path.join(this.dir, 'whisper')} ou faster-whisper. A interface usará o reconhecimento do navegador.` },
      tts: p ? { engine: 'piper', voices: p.voices.map((v) => path.basename(v, '.onnx')), detail: 'local' } : { engine: null, voices: [], detail: `Instale o Piper e uma voz pt_BR em ${path.join(this.dir, 'piper')}. A interface usará a voz do sistema.` },
    };
  }

  /** Transcreve WAV 16 kHz mono (a interface já envia neste formato). */
  async transcribe(wav: Buffer, language = 'pt'): Promise<{ text: string; engine: string; ms: number }> {
    if (wav.length < 44 || wav.subarray(0, 4).toString() !== 'RIFF') throw new Error('Áudio deve ser WAV PCM.');
    const t0 = performance.now();
    const file = path.join(this.dir, 'tmp', `${newId('rec')}.wav`);
    await fsp.writeFile(file, wav);
    try {
      const w = await this.whisper();
      if (w) {
        const threads = String(Math.max(2, Math.min(8, (await import('node:os')).cpus().length - 2)));
        const r = await run(w.bin, ['-m', w.model, '-f', file, '-l', language, '-nt', '-np', '-t', threads], { timeoutMs: 120_000 });
        if (r.code !== 0) throw new Error(`whisper.cpp falhou: ${r.stderr.slice(-300)}`);
        return { text: r.stdout.replace(/\[.*?\]/g, '').trim(), engine: 'whisper.cpp', ms: Math.round(performance.now() - t0) };
      }
      const py = await this.fasterWhisper();
      if (py) {
        const script = `import sys\nfrom faster_whisper import WhisperModel\nm=WhisperModel(sys.argv[2], device="auto", compute_type="int8")\nsegs,_=m.transcribe(sys.argv[1], language=sys.argv[3], vad_filter=True)\nprint(" ".join(s.text.strip() for s in segs))`;
        const r = await run(py, ['-c', script, file, process.env.JARVIS_FW_MODEL ?? 'small', language], { timeoutMs: 180_000 });
        if (r.code !== 0) throw new Error(`faster-whisper falhou: ${r.stderr.slice(-300)}`);
        return { text: r.stdout.trim(), engine: 'faster-whisper', ms: Math.round(performance.now() - t0) };
      }
      throw new Error('Nenhum motor local de transcrição instalado.');
    } finally {
      fsp.rm(file, { force: true }).catch(() => {});
    }
  }

  async speak(text: string, voice?: string, speed = 1): Promise<{ wav: Buffer; ms: number; voice: string }> {
    const p = await this.piper();
    if (!p) throw new Error('Piper não instalado.');
    const t0 = performance.now();
    const model = p.voices.find((v) => path.basename(v, '.onnx') === voice) ?? p.voices.find((v) => /pt_BR/i.test(v)) ?? p.voices[0]!;
    const out = path.join(this.dir, 'tmp', `${newId('tts')}.wav`);
    const r = await run(p.bin, ['--model', model, '--output_file', out, '--length_scale', String(Math.min(2, Math.max(0.5, 1 / speed)))], { timeoutMs: 60_000, input: text.slice(0, 4000) });
    if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`Piper falhou: ${r.stderr.slice(-300)}`);
    const wav = await fsp.readFile(out);
    fsp.rm(out, { force: true }).catch(() => {});
    log.debug(`tts ${wav.length} bytes`);
    return { wav, ms: Math.round(performance.now() - t0), voice: path.basename(model, '.onnx') };
  }
}

const rank = (p: string) => ['base', 'small', 'tiny', 'medium', 'large'].findIndex((s) => p.includes(s)) + 1 || 9;
