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
  elevenlabs: { configured: boolean };
  installable: { whisper: boolean; piper: boolean };
  settings: VoiceSettings;
};

/** Parâmetros de SÍNTESE de voz (não confundir com temperatura do modelo de linguagem). */
export type VoiceSettings = {
  provider: 'auto' | 'elevenlabs' | 'piper' | 'browser';
  speed: number;
  /** Piper: variação de entonação (noise_scale) e de duração dos fonemas (noise_w). */
  piperExpressiveness: number;
  piperRhythm: number;
  piperPauseSec: number;
  piperVoice: string | null;
  /** ElevenLabs */
  elevenVoiceId: string;
  elevenModel: 'eleven_flash_v2_5' | 'eleven_multilingual_v2' | 'eleven_turbo_v2_5';
  stability: number;
  similarity: number;
  style: number;
  whisperModel: 'base' | 'small';
};

export const DEFAULT_VOICE: VoiceSettings = {
  provider: 'auto', speed: 1.0,
  piperExpressiveness: 0.7, piperRhythm: 0.85, piperPauseSec: 0.25, piperVoice: null,
  // Voz multilíngue pública da biblioteca ElevenLabs; troque pelo ID de uma voz pt-BR da sua conta.
  elevenVoiceId: 'JBFqnCBsd6RMkjVDRZzb', elevenModel: 'eleven_flash_v2_5', stability: 0.45, similarity: 0.8, style: 0.25,
  whisperModel: 'base',
};

const PIPER_URL = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';
const PIPER_VOICES: Record<string, string> = {
  'pt_BR-faber-medium': 'https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx',
};
const WHISPER_TAGS = ['v1.8.2', 'v1.8.1', 'v1.7.6'];
const WHISPER_MODELS: Record<string, string> = {
  base: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  small: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
};

/**
 * Voz local. Procura binários e modelos em <dados>/voice ou nas variáveis
 * JARVIS_WHISPER_BIN, JARVIS_WHISPER_MODEL, JARVIS_PIPER_BIN, JARVIS_PIPER_VOICES.
 * Quando nada estiver instalado a interface usa as APIs de voz do navegador.
 */
export class VoiceEngine {
  private dir: string;
  settings: () => VoiceSettings = () => DEFAULT_VOICE;
  elevenKey: () => Promise<string | null> = async () => null;
  installing: Record<string, { status: string; progress: number; error?: string }> = {};
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'voice');
    fs.mkdirSync(path.join(this.dir, 'tmp'), { recursive: true });
  }

  /** Download com progresso para dentro da pasta de voz do JARVIS. */
  private async download(url: string, dest: string, key: string) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Falha ao baixar ${path.basename(dest)}: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') ?? 0);
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      if (total) this.installing[key]!.progress = Math.round((got / total) * 100);
    }
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
    await fsp.rename(tmp, dest);
  }

  private async unzip(zip: string, dest: string) {
    const r = process.platform === 'win32'
      ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`], { timeoutMs: 300_000 })
      : await run('unzip', ['-o', zip, '-d', dest], { timeoutMs: 300_000 });
    if (r.code !== 0) throw new Error(`Falha ao extrair: ${r.stderr.slice(-300)}`);
  }

  /** Instala motores locais de voz (Windows): whisper.cpp (ouvir) e Piper com voz pt-BR (falar). */
  async install(component: 'whisper' | 'piper') {
    if (process.platform !== 'win32') throw new Error('A instalação automática de voz está disponível no Windows. Em outros sistemas instale whisper.cpp/Piper manualmente.');
    if (this.installing[component]?.status === 'baixando') throw new Error('Instalação já em andamento.');
    this.installing[component] = { status: 'baixando', progress: 0 };
    const st = this.installing[component]!;
    try {
      if (component === 'piper') {
        const dir = path.join(this.dir, 'piper');
        await fsp.mkdir(dir, { recursive: true });
        const zip = path.join(this.dir, 'tmp', 'piper.zip');
        await this.download(PIPER_URL, zip, component);
        await this.unzip(zip, this.dir); // o zip contém a pasta piper/
        for (const [name, url] of Object.entries(PIPER_VOICES)) {
          if (!fs.existsSync(path.join(dir, `${name}.onnx`))) {
            st.status = `baixando voz ${name}`;
            await this.download(url, path.join(dir, `${name}.onnx`), component);
            await this.download(url + '.json', path.join(dir, `${name}.onnx.json`), component);
          }
        }
      } else {
        const dir = path.join(this.dir, 'whisper');
        await fsp.mkdir(dir, { recursive: true });
        // Versões fixas com binário Windows verificado (as mais novas deixaram de publicar o zip x64).
        const zip = path.join(this.dir, 'tmp', 'whisper.zip');
        let lastErr: Error | null = null;
        for (const tag of WHISPER_TAGS) {
          try {
            await this.download(`https://github.com/ggml-org/whisper.cpp/releases/download/${tag}/whisper-bin-x64.zip`, zip, component);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e as Error;
          }
        }
        if (lastErr) throw new Error(`Não consegui baixar o whisper.cpp: ${lastErr.message}`);
        await this.unzip(zip, dir);
        // Alguns pacotes vêm em subpasta Release/: traz os binários para a raiz.
        for (const sub of ['Release', 'release']) {
          const p = path.join(dir, sub);
          if (fs.existsSync(p)) for (const f of await fsp.readdir(p)) await fsp.rename(path.join(p, f), path.join(dir, f)).catch(() => {});
        }
        const model = this.settings().whisperModel;
        st.status = `baixando modelo ${model}`;
        const dest = path.join(dir, `ggml-${model}.bin`);
        if (!fs.existsSync(dest)) await this.download(WHISPER_MODELS[model]!, dest, component);
      }
      st.status = 'instalado';
      st.progress = 100;
      log.info(`voz: ${component} instalado`);
    } catch (e) {
      st.status = 'erro';
      st.error = (e as Error).message;
      throw e;
    }
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
    const pref = this.settings().whisperModel;
    const all = this.find(path.join(this.dir, 'whisper'), /^ggml-.*\.bin$/);
    const model = process.env.JARVIS_WHISPER_MODEL ?? all.find((m) => m.includes(`ggml-${pref}`)) ?? all.sort((a, b) => rank(a) - rank(b))[0];
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
    const win = process.platform === 'win32';
    return {
      elevenlabs: { configured: !!(await this.elevenKey().catch(() => null)) },
      installable: { whisper: win && !w, piper: win && !p },
      settings: this.settings(),
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

  /** Síntese: ElevenLabs (se configurado) → Piper local → erro (a interface usa a voz do sistema). */
  async speak(text: string, voice?: string, speedOverride?: number): Promise<{ audio: Buffer; mime: string; ms: number; voice: string; provider: string }> {
    const cfg = this.settings();
    const speed = speedOverride ?? cfg.speed;
    const t0 = performance.now();
    const key = cfg.provider === 'auto' || cfg.provider === 'elevenlabs' ? await this.elevenKey().catch(() => null) : null;
    if (key) {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.elevenVoiceId)}/stream?output_format=mp3_44100_128&optimize_streaming_latency=2`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: text.slice(0, 2500), model_id: cfg.elevenModel, language_code: cfg.elevenModel === 'eleven_flash_v2_5' || cfg.elevenModel === 'eleven_turbo_v2_5' ? 'pt' : undefined,
          voice_settings: { stability: cfg.stability, similarity_boost: cfg.similarity, style: cfg.style, use_speaker_boost: true, speed: Math.min(1.2, Math.max(0.7, speed)) },
        }),
      });
      if (!res.ok) {
        const msg = (await res.text()).slice(0, 300);
        if (cfg.provider === 'elevenlabs') throw new Error(`ElevenLabs recusou (HTTP ${res.status}): ${msg}`);
        log.warn(`ElevenLabs falhou (${res.status}); usando Piper`);
      } else {
        return { audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg', ms: Math.round(performance.now() - t0), voice: cfg.elevenVoiceId, provider: 'elevenlabs' };
      }
    }
    if (cfg.provider === 'browser') throw new Error('Voz do navegador selecionada.');
    const p = await this.piper();
    if (!p) throw new Error('Nenhuma voz local instalada (instale o Piper em Configurações → Voz).');
    const wanted = voice ?? cfg.piperVoice;
    const model = p.voices.find((v) => path.basename(v, '.onnx') === wanted) ?? p.voices.find((v) => /pt_BR/i.test(v)) ?? p.voices[0]!;
    const out = path.join(this.dir, 'tmp', `${newId('tts')}.wav`);
    const r = await run(p.bin, [
      '--model', model, '--output_file', out,
      '--length_scale', String(Math.min(2, Math.max(0.5, 1 / speed))),
      '--noise_scale', String(Math.min(1, Math.max(0.1, cfg.piperExpressiveness))),
      '--noise_w', String(Math.min(1.2, Math.max(0.1, cfg.piperRhythm))),
      '--sentence_silence', String(Math.min(1, Math.max(0, cfg.piperPauseSec))),
    ], { timeoutMs: 60_000, input: text.slice(0, 4000) });
    if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`Piper falhou: ${r.stderr.slice(-300)}`);
    const audio = await fsp.readFile(out);
    fsp.rm(out, { force: true }).catch(() => {});
    return { audio, mime: 'audio/wav', ms: Math.round(performance.now() - t0), voice: path.basename(model, '.onnx'), provider: 'piper' };
  }
}

const rank = (p: string) => ['base', 'small', 'tiny', 'medium', 'large'].findIndex((s) => p.includes(s)) + 1 || 9;
