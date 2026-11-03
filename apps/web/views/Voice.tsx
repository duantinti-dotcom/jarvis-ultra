'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Volume2, VolumeX, PhoneOff, Captions, AudioLines, Download, Loader2, AlertTriangle, ArrowLeft } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { useChat } from '@/lib/chat';
import { VoiceSphere, type SphereState } from '@/components/VoiceSphere';
import { ModeSelector } from '@/components/ModeSelector';
import { Button, cx } from '@/components/ui';
import { openMic, browserRecognition, speakable, takeSentences, ptVoices, type MicHandle } from '@/lib/voice';
import { prepareNeuralVoice, synthNeural, playJarvis, maleVoice, onNeuralState, neuralState, type NeuralState } from '@/lib/neuralVoice';
import type { ReasoningMode } from '@/lib/types';
import type { CoreEvent } from '@jarvis/contracts';

const GREETINGS = ['Às suas ordens, senhor.', 'Estou aqui. Em que posso ajudar?', 'Sistemas online. Pode falar.', 'Olá. O que vamos fazer hoje?'];

type Phase = 'off' | 'starting' | 'listening' | 'transcribing' | 'thinking' | 'speaking';
type VoiceStatus = { stt: { engine: string | null; detail: string }; tts: { engine: string | null; voices: string[] }; elevenlabs: { configured: boolean }; installable: { whisper: boolean; piper: boolean }; settings: { provider: string; speed: number } };
type Turn = { user: string; jarvis: string; m: { stt?: number; ttft?: number; firstAudio?: number; total?: number } };

const isDesktopApp = () => typeof window !== 'undefined' && !!window.__JARVIS__;

/** Melhor voz do navegador disponível (vozes neurais/online soam bem menos robóticas). */
function bestBrowserVoice() {
  const male = maleVoice(ptVoices());
  if (male) return male;
  const vs = ptVoices().filter((v) => v.lang.toLowerCase().startsWith('pt'));
  const score = (v: SpeechSynthesisVoice) => (/natural|neural|online|premium|enhanced/i.test(v.name) ? 10 : 0) + (v.lang === 'pt-BR' ? 3 : 0) + (/francisca|antonio|thalita|luciana|felipe/i.test(v.name) ? 2 : 0) + (v.localService ? 0 : 1);
  return vs.sort((a, b) => score(b) - score(a))[0] ?? null;
}

function micError(e: unknown): string {
  const n = (e as { name?: string }).name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Permissão do microfone negada. Libere o microfone para a Lume nas configurações de privacidade do Windows (Configurações → Privacidade → Microfone) ou do navegador e tente de novo.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Nenhum microfone encontrado. Conecte um microfone e tente novamente.';
  if (n === 'NotReadableError') return 'O microfone está em uso por outro programa ou indisponível.';
  return (e as Error).message ?? String(e);
}

export function VoiceView() {
  const { api, onEvent, setVisual, conn, notify } = useJarvis();
  const chat = useChat();
  const local = api.mode === 'local';
  const vs = useAsync<VoiceStatus | null>(() => (local ? api.req<VoiceStatus>('/api/voice/status') : Promise.resolve(null)), [api]);
  const installs = useAsync<Record<string, { status: string; progress: number; error?: string }>>(() => (local ? api.req('/api/voice/install') : Promise.resolve({})), [api], local ? 1500 : undefined);
  const [phase, setPhase] = useState<Phase>('off');
  const [level, setLevel] = useState(0);
  const [micOn, setMicOn] = useState(true);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [captions, setCaptions] = useState(true);
  const [interim, setInterim] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ReasoningMode>('fast');
  const mic = useRef<MicHandle | null>(null);
  const rec = useRef<ReturnType<typeof browserRecognition>>(null);
  const ph = useRef<Phase>('off');
  const micOnRef = useRef(true);
  const speakerRef = useRef(true);
  const msgId = useRef<string | null>(null);
  const buf = useRef('');
  const queue = useRef<{ text: string; audio: Promise<AudioBuffer> | null }[]>([]);
  const outCtx = useRef<AudioContext | null>(null);
  const stopper = useRef<(() => void) | null>(null);
  const [fx, setFx] = useState(true);
  const fxRef = useRef(true);
  fxRef.current = fx;
  const [neural, setNeural] = useState<NeuralState>(() => neuralState());
  // Site: voz neural masculina no navegador (o app do PC usa o Piper local).
  const useNeural = !local && !isDesktopApp();
  useEffect(() => {
    try { setFx(localStorage.getItem('jarvis.voice.fx') !== '0'); } catch {}
    if (!useNeural) return;
    const off = onNeuralState(setNeural);
    prepareNeuralVoice().catch(() => {});
    return off;
  }, [useNeural]);
  const playing = useRef(false);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const ttsLevel = useRef(0);
  const ttsFailed = useRef(false);
  const t = useRef<{ speechEnd?: number; transcript?: number; firstToken?: number; firstAudio?: number }>({});
  /** Eventos que chegam antes de sabermos o id da resposta (a nuvem responde muito rápido). */
  const awaiting = useRef(false);
  const early = useRef<CoreEvent[]>([]);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  ph.current = phase;
  micOnRef.current = micOn;
  speakerRef.current = speakerOn;

  const coreStt = !!vs.data?.stt.engine;
  const coreTts = !!vs.data && (vs.data.elevenlabs.configured || !!vs.data.tts.engine) && vs.data.settings.provider !== 'browser';
  const sttAvailable = coreStt || (!isDesktopApp() && !!(typeof window !== 'undefined' && browserRecognition()));

  const setP = useCallback((p: Phase) => {
    const prev = ph.current;
    ph.current = p;
    setPhase(p);
    // Reconhecimento do navegador: pausa enquanto a Lume fala (evita eco) e volta ao ouvir.
    const r = rec.current;
    if (r) {
      if (p === 'speaking' && prev !== 'speaking') { try { r.abort(); } catch {} }
      if (p === 'listening' && prev !== 'listening') setTimeout(() => { if (ph.current === 'listening' && rec.current === r) { try { r.start(); } catch {} } }, 150);
    }
    setVisual(p === 'off' ? 'idle' : p === 'speaking' ? 'speaking' : p === 'listening' ? 'listening' : 'thinking');
  }, [setVisual]);

  // ---------- fala ----------
  const stopSpeaking = useCallback(() => {
    queue.current = [];
    try { source.current?.stop(); } catch {}
    source.current = null;
    stopper.current?.();
    stopper.current = null;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    playing.current = false;
    ttsLevel.current = 0;
  }, []);

  /** Gera o áudio da frase (em paralelo com a fala anterior). null = usar a voz do sistema. */
  const render = useCallback((text: string): Promise<AudioBuffer> | null => {
    const ctx = outCtx.current;
    if (!ctx || ttsFailed.current) return null;
    if (coreTts && local) {
      return fetch(`${api.coreUrl}/api/voice/speak`, { method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
        .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`); return ctx.decodeAudioData(await r.arrayBuffer()); });
    }
    if (useNeural && neuralState().status === 'ready') return synthNeural(ctx, text, vs.data?.settings.speed ?? 1.05);
    return null;
  }, [api, coreTts, local, useNeural, vs.data]);

  const pump = useCallback(async () => {
    if (playing.current) return;
    const next = queue.current.shift();
    if (!next) {
      if (ph.current === 'speaking' && !msgId.current) setP('listening');
      return;
    }
    if (!speakerRef.current) { void pump(); return; }
    playing.current = true;
    if (ph.current !== 'off') setP('speaking');
    const done = () => { playing.current = false; ttsLevel.current = 0; stopper.current = null; void pump(); };
    const browserSpeak = () => {
      const u = new SpeechSynthesisUtterance(next.text);
      u.lang = 'pt-BR';
      u.rate = vs.data?.settings.speed ?? 1.04;
      const v = bestBrowserVoice();
      if (v) u.voice = v;
      // sem voz masculina instalada: deixa a voz disponível mais grave
      u.pitch = v && maleVoice([v]) ? 0.92 : 0.7;
      u.onboundary = () => { ttsLevel.current = 0.65; setTimeout(() => (ttsLevel.current = 0.2), 110); };
      u.onend = done;
      u.onerror = done;
      t.current.firstAudio ??= performance.now();
      speechSynthesis.speak(u);
    };
    const audio = next.audio ?? render(next.text);
    if (!audio || !outCtx.current) { browserSpeak(); return; }
    try {
      const buf = await audio;
      if (!playing.current) return; // interrompido enquanto gerava
      const ctx = outCtx.current;
      if (ctx.state === 'suspended') await ctx.resume();
      t.current.firstAudio ??= performance.now();
      const h = playJarvis(ctx, buf, { fx: fxRef.current, onEnd: () => { clearInterval(meter); done(); } });
      const arr = new Uint8Array(h.analyser.frequencyBinCount);
      const meter = setInterval(() => { h.analyser.getByteTimeDomainData(arr); let s = 0; for (const v of arr) s += ((v - 128) / 128) ** 2; ttsLevel.current = Math.min(1, Math.sqrt(s / arr.length) * 4); }, 40);
      stopper.current = () => { clearInterval(meter); h.stop(); };
    } catch (e) {
      // Falhou a voz principal: avisa uma vez e segue com a voz do sistema.
      if (!ttsFailed.current) notify('warn', `Voz principal indisponível (${(e as Error).message}). Usando a voz do sistema.`);
      ttsFailed.current = true;
      browserSpeak();
    }
  }, [render, notify, setP, vs.data]);

  const enqueue = useCallback((s: string) => {
    const clean = speakable(s);
    if (!clean) return;
    // já começa a gerar o áudio enquanto a frase anterior toca (menos espera entre frases)
    queue.current.push({ text: clean, audio: speakerRef.current ? render(clean) : null });
    void pump();
  }, [pump, render]);

  // ---------- respostas em streaming ----------
  const handleEvent = useRef<(e: CoreEvent) => void>(() => {});
  useEffect(() => onEvent((e) => {
    if (!msgId.current) {
      if (awaiting.current && (e.type === 'chat.delta' || e.type === 'chat.done' || e.type === 'chat.error')) early.current.push(e);
      return;
    }
    handleEvent.current(e);
  }), [onEvent]);
  handleEvent.current = (e: CoreEvent) => {
    if (e.type === 'chat.delta' && e.messageId === msgId.current) {
      t.current.firstToken ??= performance.now();
      setTurns((ts) => ts.map((x, i) => (i === ts.length - 1 ? { ...x, jarvis: x.jarvis + e.text } : x)));
      if (buf.current.includes('\n---')) return;
      buf.current += e.text;
      const { sentences, rest } = takeSentences(buf.current);
      buf.current = rest;
      sentences.forEach(enqueue);
    }
    if ((e.type === 'chat.done' || e.type === 'chat.error') && e.messageId === msgId.current) {
      if (e.type === 'chat.error') enqueue(`Não consegui responder: ${e.error}`);
      if (buf.current.trim() && !buf.current.includes('\n---')) enqueue(buf.current);
      buf.current = '';
      msgId.current = null;
      const m = t.current;
      const metrics = { stt: m.transcript && m.speechEnd ? Math.round(m.transcript - m.speechEnd) : undefined, ttft: m.firstToken && m.transcript ? Math.round(m.firstToken - m.transcript) : undefined, firstAudio: m.firstAudio && m.speechEnd ? Math.round(m.firstAudio - m.speechEnd) : undefined, total: m.speechEnd ? Math.round(performance.now() - m.speechEnd) : undefined };
      setTurns((ts) => ts.map((x, i) => (i === ts.length - 1 ? { ...x, m: metrics } : x)));
      if (local) void api.req('/api/voice/metrics', { method: 'POST', json: { sttMs: metrics.stt ?? null, ttftMs: metrics.ttft ?? null, firstAudioMs: metrics.firstAudio ?? null, totalMs: metrics.total ?? null } }).catch(() => {});
      if (!playing.current && !queue.current.length && ph.current !== 'off') setP('listening');
    }
  };

  const handleTranscript = useCallback(async (text: string) => {
    const clean = text.replace(/\[.*?\]/g, '').trim();
    if (clean.length < 2) { if (ph.current !== 'off') setP('listening'); return; }
    t.current.transcript = performance.now();
    setInterim('');
    setTurns((ts) => [...ts.slice(-20), { user: clean, jarvis: '', m: {} }]);
    if (/^(encerrar|desligar|finalizar) (a )?(chamada|liga[cç][aã]o|conversa)\b/i.test(clean)) { void end(); return; }
    setP('thinking');
    buf.current = '';
    early.current = [];
    awaiting.current = true;
    const id = await chatRef.current.send(clean, undefined, mode, { voice: true });
    awaiting.current = false;
    msgId.current = id;
    if (!id) { if (ph.current !== 'off') setP('listening'); return; }
    // Reprocessa o que chegou antes do id (respostas muito rápidas).
    const pending = early.current.filter((e) => 'messageId' in e && e.messageId === id);
    early.current = [];
    for (const e of pending) handleEvent.current(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, setP]);

  const start = useCallback(async () => {
    if (ph.current !== 'off') return;
    setError(null);
    if (conn !== 'online') return setError('A Lume está offline. Verifique se o aplicativo está aberto no computador.');
    if (!sttAvailable) return setError(isDesktopApp() ? 'O reconhecimento de voz local ainda não está instalado. Clique em “Instalar reconhecimento de voz” abaixo (cerca de 150 MB).' : 'Este navegador não oferece reconhecimento de voz. Use o Chrome/Edge ou o app do computador.');
    setP('starting');
    ttsFailed.current = false;
    try { outCtx.current ??= new AudioContext(); void outCtx.current.resume(); } catch { outCtx.current = null; }
    try {
      mic.current = await openMic({
        // Durante a fala da Lume o limiar sobe bastante: só voz humana próxima interrompe (evita eco).
        sensitivity: () => (ph.current === 'speaking' ? 7 : 3),
        minSpeechMs: 300,
        onSpeechStart: () => {
          if (!micOnRef.current) return;
          if (ph.current === 'speaking') stopSpeaking();
          if (coreStt && ph.current !== 'thinking' && ph.current !== 'transcribing') setP('listening');
        },
        onSpeechEnd: async (wav) => {
          if (!micOnRef.current || !coreStt || ph.current === 'thinking' || ph.current === 'transcribing') return;
          t.current = { speechEnd: performance.now() };
          setP('transcribing');
          try {
            const r = await fetch(`${api.coreUrl}/api/voice/transcribe?lang=pt`, { method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'audio/wav' }, body: wav });
            const j = await r.json();
            if (!r.ok) throw new Error(j.error);
            await handleTranscript(j.text);
          } catch (e) {
            setError(`Falha ao transcrever: ${(e as Error).message}`);
            setP('listening');
          }
        },
      });
      await mic.current.ctx.resume();
      if (!coreStt) {
        const r = browserRecognition()!;
        rec.current = r;
        r.onspeechstart = () => { if (ph.current === 'speaking') stopSpeaking(); };
        r.onresult = (ev) => {
          if (!micOnRef.current || ph.current === 'speaking') return;
          let fin = '', tmp = '';
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const res = ev.results[i]!;
            if (res.isFinal) fin += res[0].transcript;
            else tmp += res[0].transcript;
          }
          setInterim(tmp);
          if (fin && ph.current !== 'thinking') { t.current = { speechEnd: performance.now(), transcript: performance.now() }; void handleTranscript(fin); }
        };
        r.onerror = (ev) => {
          if (['no-speech', 'aborted'].includes(ev.error)) return;
          if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') setError(micError({ name: 'NotAllowedError' }));
          else if (ev.error === 'network') setError('O reconhecimento de voz do navegador precisa de internet. Verifique a conexão.');
          else setError(`Reconhecimento de voz: ${ev.error}`);
        };
        // O navegador encerra o reconhecimento após silêncio: religamos enquanto a chamada estiver aberta.
        r.onend = () => {
          if (ph.current === 'off' || ph.current === 'speaking' || rec.current !== r) return;
          setTimeout(() => { if (ph.current !== 'off' && rec.current === r) { try { r.start(); } catch { /* já ativo */ } } }, 250);
        };
        r.start();
      }
      setP('listening');
      enqueue(GREETINGS[Math.floor(Math.random() * GREETINGS.length)]!);
    } catch (e) {
      setError(micError(e));
      void end();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, coreStt, conn, sttAvailable, handleTranscript, setP, stopSpeaking, enqueue]);

  const end = useCallback(async () => {
    setP('off');
    stopSpeaking();
    rec.current?.abort();
    rec.current = null;
    mic.current?.stop();
    mic.current = null;
    if (msgId.current) chatRef.current.cancel();
    msgId.current = null;
    awaiting.current = false;
    setLevel(0);
    setInterim('');
  }, [setP, stopSpeaking]);

  useEffect(() => {
    let raf = 0;
    const loop = () => { setLevel(ph.current === 'speaking' ? ttsLevel.current : mic.current && micOnRef.current ? mic.current.level() : 0); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => {
    if (location.hash.includes('auto=1') && !vs.loading) { history.replaceState(null, '', '#/voice'); void start(); }
  }, [vs.loading, start]);
  // Encerra só ao sair da tela (antes, qualquer mudança na conversa encerrava a chamada).
  const endRef = useRef(end);
  endRef.current = end;
  useEffect(() => () => { void endRef.current(); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ph.current !== 'off') void end();
      if (e.key === ' ' && ph.current === 'speaking' && (e.target as HTMLElement).tagName !== 'INPUT') { e.preventDefault(); stopSpeaking(); setP('listening'); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [end, stopSpeaking, setP]);

  const sphere: SphereState = error ? 'error' : conn !== 'online' ? 'offline' : phase === 'off' || phase === 'starting' ? 'idle' : phase === 'speaking' ? 'speaking' : phase === 'listening' ? 'listening' : 'thinking';
  const LABEL: Record<Phase, string> = { off: 'Pronto para conversar', starting: 'Preparando o microfone…', listening: micOn ? 'Ouvindo' : 'Microfone silenciado', transcribing: 'Entendendo', thinking: 'Pensando', speaking: 'Falando' };
  const last = turns.at(-1);
  const install = (component: 'whisper' | 'piper') => api.req('/api/voice/install', { method: 'POST', json: { component } }).then(() => { notify('ok', 'Instalação iniciada'); void installs.reload(); }).catch((e) => notify('err', e.message));
  useEffect(() => { if (Object.values(installs.data ?? {}).some((x) => x.status === 'instalado')) void vs.reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [JSON.stringify(installs.data)]);

  return (
    <div className="relative h-full overflow-hidden bg-[radial-gradient(1000px_600px_at_50%_35%,rgba(16,185,129,0.10),transparent_65%)]">
      <a href="#/chat" className="absolute left-4 top-4 z-10 press flex items-center gap-1.5 rounded-lg px-2.5 h-8 text-[12.5px] text-muted hover:text-fg hover:bg-white/5"><ArrowLeft className="size-4" />Voltar</a>
      <div className="absolute right-4 top-4 z-10"><ModeSelector value={mode} onChange={setMode} compact /></div>
      <div className="h-full overflow-y-auto scroll-thin flex flex-col items-center px-4 pt-14 pb-8">
        <VoiceSphere state={sphere} level={micOn || phase === 'speaking' ? level : 0} size={typeof window !== 'undefined' ? Math.min(360, window.innerWidth - 32) : 360} />
        <div className="mt-1 font-display tracking-[0.22em] text-[12.5px] uppercase text-accent-soft" aria-live="polite">{LABEL[phase]}</div>

        {captions && phase !== 'off' && (
          <div className="mt-5 w-full max-w-2xl min-h-[96px] text-center space-y-2.5" aria-live="polite">
            {(interim || last?.user) && <p className="text-[15px] text-muted">“{interim || last?.user}”</p>}
            {last?.jarvis && <p className="text-[17px] leading-relaxed text-fg line-clamp-4">{speakable(last.jarvis)}</p>}
          </div>
        )}

        {error && <div role="alert" className="mt-5 max-w-lg flex gap-2 rounded-xl border border-err/30 bg-err/[0.07] px-4 py-3 text-[13px] text-err"><AlertTriangle className="size-4 shrink-0 mt-0.5" />{error}</div>}

        <div className="mt-7 flex items-center gap-3">
          {phase === 'off' ? (
            <button onClick={start} className="press inline-flex items-center gap-3 rounded-full btn-accent h-14 pl-5 pr-7 font-display font-semibold text-[15px]">
              <AudioLines className="size-5" />Falar com Lume
            </button>
          ) : (
            <>
              <RoundBtn label={micOn ? 'Silenciar microfone' : 'Ativar microfone'} on={micOn} onClick={() => setMicOn((m) => !m)}>{micOn ? <Mic className="size-5" /> : <MicOff className="size-5" />}</RoundBtn>
              <button aria-label="Encerrar conversa" onClick={end} className="press grid place-items-center size-16 rounded-full bg-err text-white"><PhoneOff className="size-6" /></button>
              <RoundBtn label={speakerOn ? 'Desativar voz da Lume' : 'Ativar voz da Lume'} on={speakerOn} onClick={() => { if (speakerOn) stopSpeaking(); setSpeakerOn((s) => !s); }}>{speakerOn ? <Volume2 className="size-5" /> : <VolumeX className="size-5" />}</RoundBtn>
            </>
          )}
        </div>
        <div className="mt-3 flex items-center gap-4 text-[12px] text-dim">
          <button onClick={() => setCaptions((c) => !c)} className={cx('flex items-center gap-1.5 hover:text-fg', captions && 'text-muted')}><Captions className="size-4" />Transcrição {captions ? 'ligada' : 'desligada'}</button>
          {phase === 'speaking' && <span>Espaço ou fale para interromper</span>}
          {phase !== 'off' && <span>Esc encerra</span>}
        </div>

        {/* Motores de voz: estado real e instalação */}
        <div className="mt-10 w-full max-w-2xl grid gap-3 sm:grid-cols-2">
          <EngineCard title="Ouvir (reconhecimento)" ok={coreStt || (!isDesktopApp() && sttAvailable)}
            detail={coreStt ? `Local: ${vs.data?.stt.engine}` : !local ? 'Reconhecimento do navegador' : isDesktopApp() ? 'Não instalado' : 'Reconhecimento do navegador'}
            action={local && vs.data?.installable.whisper ? <InstallBtn st={installs.data?.whisper} onClick={() => install('whisper')} label="Instalar reconhecimento de voz" /> : null} />
          <EngineCard title="Falar (voz da Lume)" ok={coreTts || (useNeural && neural.status === 'ready')}
            detail={vs.data?.elevenlabs.configured ? 'ElevenLabs (voz premium)' : vs.data?.tts.engine ? `Piper local · ${vs.data.tts.voices[0] ?? ''}` : useNeural ? (neural.status === 'ready' ? 'Voz neural masculina Lume (no navegador)' : neural.status === 'loading' ? `Baixando a voz Lume… ${neural.progress}% (uma única vez)` : neural.status === 'error' ? `Voz neural indisponível agora (sem acesso ao servidor da voz); usando ${bestBrowserVoice()?.name ?? 'a voz do sistema'}` : 'Preparando a voz Lume…') : `Voz do sistema${bestBrowserVoice() ? ` · ${bestBrowserVoice()!.name}` : ''}`}
            action={
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-[12px] text-muted cursor-pointer select-none">
                  <input type="checkbox" checked={fx} onChange={(e) => { setFx(e.target.checked); try { localStorage.setItem('jarvis.voice.fx', e.target.checked ? '1' : '0'); } catch {} }} className="accent-[#34d399]" />
                  Timbre tecnológico (efeito Lume)
                </label>
                {useNeural && neural.status === 'error' && <button className="text-[12px] text-accent-soft hover:underline" onClick={() => void prepareNeuralVoice().catch(() => {})}>Tentar de novo</button>}
                {local && vs.data?.installable.piper ? <InstallBtn st={installs.data?.piper} onClick={() => install('piper')} label="Instalar voz natural" /> : local ? <a href="#/settings/voice" className="text-[12px] text-accent-soft hover:underline">Ajustar voz</a> : null}
              </div>
            } />
        </div>

        {!local && (
          <a href="#/settings/brain" className="mt-3 w-full max-w-2xl surface rounded-xl px-3.5 py-2.5 text-[12.5px] text-muted hover:text-fg flex items-center gap-2.5 lift">
            <span className="size-2 shrink-0 rounded-full bg-accent" />
            <span>Quer a Lume bem mais inteligente e respondendo em menos de 1 s? Adicione sua chave grátis da Groq em <b className="text-accent-soft">Configurações → Inteligência</b>.</span>
          </a>
        )}

        {turns.some((x) => x.m.total) && (
          <div className="mt-4 w-full max-w-2xl surface rounded-xl p-3">
            <div className="label-tech mb-2">Latência medida (ms)</div>
            <table className="w-full text-[11.5px] font-mono">
              <thead className="text-dim"><tr><th className="text-left font-normal">fala</th><th className="font-normal">transcrição</th><th className="font-normal">1º token</th><th className="font-normal">1º áudio</th><th className="font-normal">total</th></tr></thead>
              <tbody>{turns.filter((x) => x.m.total).slice(-5).map((x, i) => <tr key={i} className="text-center"><td className="text-left text-muted truncate max-w-[140px]">{x.user.slice(0, 22)}</td><td>{x.m.stt ?? '—'}</td><td>{x.m.ttft ?? '—'}</td><td>{x.m.firstAudio ?? '—'}</td><td>{x.m.total}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function RoundBtn({ label, on, onClick, children }: { label: string; on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button aria-label={label} title={label} onClick={onClick} className={cx('press grid place-items-center size-12 rounded-full border', on ? 'border-line-strong bg-white/[0.06] text-fg' : 'border-err/40 bg-err/15 text-err')}>{children}</button>;
}
function EngineCard({ title, ok, detail, action }: { title: string; ok: boolean; detail: string; action: React.ReactNode }) {
  return (
    <div className="surface rounded-xl p-3.5">
      <div className="flex items-center gap-2"><span className={cx('size-2 rounded-full', ok ? 'bg-ok' : 'bg-warn')} /><span className="text-[13px] font-medium">{title}</span></div>
      <div className="mt-1 text-[12px] text-dim">{detail}</div>
      {action && <div className="mt-2.5">{action}</div>}
    </div>
  );
}
function InstallBtn({ st, onClick, label }: { st?: { status: string; progress: number; error?: string }; onClick: () => void; label: string }) {
  if (st?.status && st.status !== 'erro' && st.status !== 'instalado') return <div className="text-[12px] text-muted flex items-center gap-2"><Loader2 className="size-3.5 animate-spin text-accent" />{st.status} {st.progress ? `${st.progress}%` : ''}</div>;
  return (
    <>
      <Button size="sm" icon={<Download className="size-3.5" />} onClick={onClick}>{label}</Button>
      {st?.error && <div className="mt-1 text-[11.5px] text-err">{st.error}</div>}
    </>
  );
}
