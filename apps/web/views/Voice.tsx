'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Captions, Volume2, Gauge } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { JarvisCore } from '@/components/JarvisCore';
import { Button, Badge, Select, Panel, cx } from '@/components/ui';
import { openMic, browserRecognition, speakable, takeSentences, ptVoices, type MicHandle } from '@/lib/voice';
import type { CoreVisualState } from '@jarvis/contracts';

type Phase = 'off' | 'listening' | 'transcribing' | 'thinking' | 'speaking';
type Turn = { user: string; jarvis: string; m: { stt?: number; ttft?: number; firstAudio?: number; total?: number } };
type VoiceStatus = { stt: { engine: string | null; detail: string }; tts: { engine: string | null; voices: string[]; detail: string } };

export function VoiceView() {
  const { api, chat, onEvent, setVisual, notify, conn } = useJarvis();
  const vs = useAsync<VoiceStatus | null>(() => (api.mode === 'local' ? api.req<VoiceStatus>('/api/voice/status') : Promise.resolve(null)), [api]);
  const [phase, setPhase] = useState<Phase>('off');
  const [level, setLevel] = useState(0);
  const [captions, setCaptions] = useState(true);
  const [muted, setMuted] = useState(false);
  const [interim, setInterim] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [voice, setVoice] = useState('');
  const [speed, setSpeed] = useState(1.05);
  const [voices, setVoices] = useState<{ value: string; label: string }[]>([]);
  const mic = useRef<MicHandle | null>(null);
  const rec = useRef<ReturnType<typeof browserRecognition>>(null);
  const phaseRef = useRef<Phase>('off');
  const mutedRef = useRef(false);
  const msgId = useRef<string | null>(null);
  const buf = useRef('');
  const queue = useRef<string[]>([]);
  const playing = useRef(false);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const ttsLevel = useRef(0);
  const t = useRef<{ speechEnd?: number; transcript?: number; firstToken?: number; firstAudio?: number }>({});
  phaseRef.current = phase;
  mutedRef.current = muted;

  const coreStt = vs.data?.stt.engine != null;
  const coreTts = vs.data?.tts.engine != null;

  useEffect(() => {
    const load = () => {
      const opts = coreTts ? (vs.data?.tts.voices ?? []).map((v) => ({ value: `core:${v}`, label: `${v} (Piper local)` })) : [];
      setVoices([...opts, ...ptVoices().map((v) => ({ value: `web:${v.name}`, label: `${v.name} (${v.lang})` }))]);
    };
    load();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.onvoiceschanged = load;
  }, [coreTts, vs.data]);
  useEffect(() => { if (!voice && voices[0]) setVoice(voices[0].value); }, [voices, voice]);

  const setP = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
    const map: Record<Phase, CoreVisualState> = { off: 'idle', listening: 'listening', transcribing: 'thinking', thinking: 'thinking', speaking: 'speaking' };
    setVisual(map[p]);
  }, [setVisual]);

  // ---------- síntese ----------
  const stopSpeaking = useCallback(() => {
    queue.current = [];
    source.current?.stop();
    source.current = null;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    playing.current = false;
  }, []);

  const pump = useCallback(async () => {
    if (playing.current) return;
    const next = queue.current.shift();
    if (!next) {
      if (phaseRef.current === 'speaking' && !msgId.current) setP('listening');
      return;
    }
    playing.current = true;
    if (phaseRef.current !== 'off') setP('speaking');
    if (t.current.firstAudio == null) {
      t.current.firstAudio = performance.now();
    }
    const done = () => { playing.current = false; ttsLevel.current = 0; void pump(); };
    try {
      if (voice.startsWith('core:') && mic.current) {
        const r = await fetch(`${api.coreUrl}/api/voice/speak`, { method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: next, voice: voice.slice(5), speed }) });
        if (!r.ok) throw new Error((await r.json()).error);
        const ctx = mic.current.ctx;
        const audio = await ctx.decodeAudioData(await r.arrayBuffer());
        const src = ctx.createBufferSource();
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        src.buffer = audio;
        src.connect(an);
        an.connect(ctx.destination);
        const arr = new Uint8Array(an.frequencyBinCount);
        const meter = setInterval(() => { an.getByteTimeDomainData(arr); let s = 0; for (const v of arr) s += ((v - 128) / 128) ** 2; ttsLevel.current = Math.min(1, Math.sqrt(s / arr.length) * 4); }, 50);
        src.onended = () => { clearInterval(meter); done(); };
        source.current = src;
        src.start();
      } else {
        const u = new SpeechSynthesisUtterance(next);
        u.lang = 'pt-BR';
        u.rate = speed;
        const v = ptVoices().find((x) => `web:${x.name}` === voice);
        if (v) u.voice = v;
        u.onboundary = () => { ttsLevel.current = 0.7; setTimeout(() => (ttsLevel.current = 0.25), 120); };
        u.onend = done;
        u.onerror = done;
        speechSynthesis.speak(u);
      }
    } catch (e) {
      notify('err', `Voz: ${(e as Error).message}`);
      done();
    }
  }, [api, voice, speed, notify, setP]);

  const enqueue = useCallback((s: string) => {
    const clean = speakable(s);
    if (!clean) return;
    queue.current.push(clean);
    void pump();
  }, [pump]);

  // ---------- respostas em streaming ----------
  useEffect(() => onEvent((e) => {
    if (!msgId.current) return;
    if (e.type === 'chat.delta' && e.messageId === msgId.current) {
      if (t.current.firstToken == null) t.current.firstToken = performance.now();
      setTurns((ts) => ts.map((x, i) => (i === ts.length - 1 ? { ...x, jarvis: x.jarvis + e.text } : x)));
      if (buf.current.includes('\n---')) return; // rodapé de verificação não é falado
      buf.current += e.text;
      const { sentences, rest } = takeSentences(buf.current);
      buf.current = rest;
      sentences.forEach(enqueue);
    }
    if ((e.type === 'chat.done' || e.type === 'chat.error') && e.messageId === msgId.current) {
      if (e.type === 'chat.error') enqueue(`Erro: ${e.error}`);
      if (buf.current.trim() && !buf.current.includes('\n---')) enqueue(buf.current);
      buf.current = '';
      msgId.current = null;
      const m = t.current;
      const total = performance.now() - (m.speechEnd ?? performance.now());
      const metrics = { stt: m.transcript && m.speechEnd ? Math.round(m.transcript - m.speechEnd) : undefined, ttft: m.firstToken && m.transcript ? Math.round(m.firstToken - m.transcript) : undefined, firstAudio: m.firstAudio && m.speechEnd ? Math.round(m.firstAudio - m.speechEnd) : undefined, total: Math.round(total) };
      setTurns((ts) => ts.map((x, i) => (i === ts.length - 1 ? { ...x, m: metrics } : x)));
      if (api.mode === 'local') void api.req('/api/voice/metrics', { method: 'POST', json: { sttMs: metrics.stt ?? null, ttftMs: metrics.ttft ?? null, firstAudioMs: metrics.firstAudio ?? null, totalMs: metrics.total ?? null } }).catch(() => {});
      if (!playing.current && !queue.current.length && phaseRef.current !== 'off') setP('listening');
    }
  }), [onEvent, enqueue, api, setP]);

  const handleTranscript = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean || clean.length < 2) { setP('listening'); return; }
    t.current.transcript = performance.now();
    setInterim('');
    setTurns((ts) => [...ts.slice(-20), { user: clean, jarvis: '', m: {} }]);
    if (/^(encerrar|desligar|tchau jarvis|finalizar) (a )?(chamada|liga[cç][aã]o)?/i.test(clean)) { void end(); return; }
    setP('thinking');
    buf.current = '';
    msgId.current = await chat.send(clean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat, setP]);

  // ---------- chamada ----------
  const start = useCallback(async () => {
    if (phaseRef.current !== 'off') return;
    try {
      if (conn !== 'online') throw new Error('O JARVIS está offline.');
      const useBrowserStt = !coreStt;
      if (useBrowserStt && !browserRecognition()) throw new Error('Este navegador não tem reconhecimento de voz e o PC não tem whisper instalado.');
      mic.current = await openMic({
        sensitivity: () => (phaseRef.current === 'speaking' ? 6 : 3),
        onSpeechStart: () => {
          if (mutedRef.current) return;
          if (phaseRef.current === 'speaking') stopSpeaking(); // interrupção (barge-in)
          if (!useBrowserStt && phaseRef.current !== 'thinking') setP('listening');
        },
        onSpeechEnd: async (wav) => {
          if (mutedRef.current || useBrowserStt || phaseRef.current === 'thinking') return;
          t.current = { speechEnd: performance.now() };
          setP('transcribing');
          try {
            const r = await fetch(`${api.coreUrl}/api/voice/transcribe?lang=pt`, { method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'audio/wav' }, body: wav });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error);
            await handleTranscript(j.text);
          } catch (e) {
            notify('err', `Transcrição: ${(e as Error).message}`);
            setP('listening');
          }
        },
      });
      await mic.current.ctx.resume();
      if (useBrowserStt) {
        const r = browserRecognition()!;
        rec.current = r;
        r.onspeechstart = () => { if (phaseRef.current === 'speaking') stopSpeaking(); };
        r.onresult = (ev) => {
          if (mutedRef.current) return;
          let fin = '', tmp = '';
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const res = ev.results[i]!;
            if (res.isFinal) fin += res[0].transcript;
            else tmp += res[0].transcript;
          }
          setInterim(tmp);
          if (fin && phaseRef.current !== 'thinking') {
            t.current = { speechEnd: performance.now(), transcript: performance.now() };
            void handleTranscript(fin);
          }
        };
        r.onerror = (ev) => { if (ev.error !== 'no-speech' && ev.error !== 'aborted') notify('err', `Reconhecimento: ${ev.error}`); };
        r.onend = () => { if (phaseRef.current !== 'off') try { r.start(); } catch {} };
        r.start();
      }
      setP('listening');
      enqueue('Estou ouvindo.');
    } catch (e) {
      notify('err', (e as Error).message);
      void end();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, coreStt, conn, handleTranscript, notify, setP, stopSpeaking, enqueue]);

  const end = useCallback(async () => {
    setP('off');
    stopSpeaking();
    rec.current?.abort();
    rec.current = null;
    mic.current?.stop();
    mic.current = null;
    if (msgId.current) chat.cancel();
    msgId.current = null;
    setLevel(0);
  }, [chat, setP, stopSpeaking]);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setLevel(phaseRef.current === 'speaking' ? ttsLevel.current : mic.current ? mic.current.level() : 0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => {
    if (location.hash.includes('auto=1') && !vs.loading) {
      history.replaceState(null, '', '#/voice');
      void start();
    }
  }, [vs.loading, start]);
  useEffect(() => () => { void end(); }, [end]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && phaseRef.current !== 'off') void end(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [end]);

  const visual: CoreVisualState = phase === 'off' ? (conn === 'online' ? 'idle' : 'offline') : phase === 'speaking' ? 'speaking' : phase === 'listening' ? 'listening' : 'thinking';
  const last = turns.at(-1);
  const PHASE_LABEL: Record<Phase, string> = { off: 'Chamada encerrada', listening: 'Ouvindo…', transcribing: 'Transcrevendo…', thinking: 'Pensando…', speaking: 'Falando…' };

  return (
    <div className="min-h-full flex flex-col items-center px-4 py-6">
      <div className="flex flex-wrap justify-center gap-1.5">
        <Badge tone={coreStt ? 'ok' : 'neutral'}><Mic className="size-3" />{coreStt ? `STT local: ${vs.data?.stt.engine}` : 'STT do navegador'}</Badge>
        <Badge tone={coreTts ? 'ok' : 'neutral'}><Volume2 className="size-3" />{coreTts ? 'Voz local: Piper' : 'Voz do sistema'}</Badge>
        {phase !== 'off' && <Badge tone="orange" pulse><Mic className="size-3" />Microfone ativo</Badge>}
      </div>
      <div className="relative mt-4">
        <JarvisCore state={visual} level={muted ? 0 : level} size={Math.min(380, typeof window !== 'undefined' ? window.innerWidth - 40 : 380)} />
      </div>
      <div className="font-display tracking-[0.2em] text-[13px] text-orange-soft glow-text" aria-live="polite">{PHASE_LABEL[phase]}</div>

      {captions && phase !== 'off' && (
        <div className="mt-4 w-full max-w-2xl min-h-[84px] text-center space-y-2" aria-live="polite">
          {(interim || last?.user) && <p className="text-[15px] text-muted">“{interim || last?.user}”</p>}
          {last?.jarvis && <p className="text-[16px] leading-relaxed text-fg line-clamp-4">{speakable(last.jarvis)}</p>}
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        {phase === 'off' ? (
          <button onClick={start} className="inline-flex items-center gap-3 rounded-full bg-orange text-black h-14 pl-4 pr-7 font-display font-semibold tracking-[0.14em] shadow-[0_0_50px_-10px_#ff6a00] hover:bg-orange-glow transition">
            <Phone className="size-5" />LIGAR PARA JARVIS
          </button>
        ) : (
          <>
            <button aria-label={muted ? 'Ativar microfone' : 'Silenciar microfone'} onClick={() => setMuted((m) => !m)} className={cx('grid place-items-center size-12 rounded-full border transition', muted ? 'bg-err/15 border-err/40 text-err' : 'border-line-strong bg-white/5')}>
              {muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
            </button>
            <button aria-label="Encerrar chamada" onClick={end} className="grid place-items-center size-14 rounded-full bg-err text-white shadow-[0_0_40px_-10px_#ff5d67]"><PhoneOff className="size-6" /></button>
            <button aria-label="Legendas" onClick={() => setCaptions((c) => !c)} className={cx('grid place-items-center size-12 rounded-full border transition', captions ? 'border-orange/50 text-orange' : 'border-line-strong text-muted')}><Captions className="size-5" /></button>
          </>
        )}
      </div>
      {phase === 'speaking' && <Button size="sm" variant="ghost" className="mt-2" onClick={stopSpeaking}>Interromper resposta</Button>}

      <div className="mt-8 w-full max-w-4xl grid gap-4 md:grid-cols-2">
        <Panel title="Ajustes de voz" icon={<Volume2 className="size-4" />}>
          <div className="space-y-3 text-[12.5px]">
            <label className="block"><span className="label-tech">Voz</span><Select className="w-full mt-1" value={voice} onChange={setVoice} options={voices.length ? voices : [{ value: '', label: 'Padrão do sistema' }]} /></label>
            <label className="block"><span className="label-tech">Velocidade {speed.toFixed(2)}×</span>
              <input type="range" min={0.7} max={1.6} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-full accent-[#ff6a00] mt-1" />
            </label>
            {vs.data && !coreStt && <p className="text-dim">{vs.data.stt.detail}</p>}
            {vs.data && !coreTts && <p className="text-dim">{vs.data.tts.detail}</p>}
            <p className="text-dim">Atalhos: <b>Esc</b> encerra · fale por cima da resposta para interromper · diga “encerrar chamada”.</p>
          </div>
        </Panel>
        <Panel title="Diagnóstico de latência (medido)" icon={<Gauge className="size-4" />}>
          {!turns.some((x) => x.m.total) ? <p className="text-[12.5px] text-muted">As medidas reais de cada turno aparecem aqui.</p> : (
            <table className="w-full text-[11.5px] font-mono">
              <thead className="text-dim"><tr><th className="text-left font-normal">turno</th><th className="font-normal">STT</th><th className="font-normal">1º token</th><th className="font-normal">1º áudio</th><th className="font-normal">total</th></tr></thead>
              <tbody>
                {turns.filter((x) => x.m.total).slice(-6).map((x, i) => (
                  <tr key={i} className="text-center"><td className="text-left text-muted truncate max-w-[120px]">{x.user.slice(0, 18)}</td><td>{x.m.stt ?? '—'}</td><td>{x.m.ttft ?? '—'}</td><td>{x.m.firstAudio ?? '—'}</td><td>{x.m.total}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-[10.5px] text-dim">ms · STT = fim da fala → texto · 1º token = texto → primeira palavra do modelo · 1º áudio = fim da fala → início da resposta falada</p>
        </Panel>
      </div>
    </div>
  );
}
