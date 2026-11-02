'use client';
import { useEffect, useState } from 'react';
import { SlidersHorizontal, Cpu, AudioLines, Database, Smartphone, FlaskConical, Bot, Activity, UserRound, Download, Loader2, KeyRound, Trash2, Check, Sparkles, ExternalLink } from 'lucide-react';
import { useJarvis, useAsync } from '@/lib/store';
import { useChat } from '@/lib/chat';
import { Panel, Button, Input, Select, Toggle, Badge, cx } from '@/components/ui';
import { ModeSelector, MODE_INFO } from '@/components/ModeSelector';
import { ModelsView } from './Models';
import { MemoryView } from './Memory';
import { DevicesView } from './Devices';
import { LabView } from './Lab';
import { AgentsView } from './Agents';
import { MonitorView } from './Monitor';
import { supabase, SUPABASE_URL, SUPABASE_ANON } from '@/lib/remote';
import { cloudAiStatus } from '@/lib/cloud';

const TABS = [
  { id: 'general', label: 'Geral', icon: SlidersHorizontal },
  { id: 'brain', label: 'Inteligência', icon: Sparkles, remote: true },
  { id: 'models', label: 'Modelos', icon: Cpu, local: true },
  { id: 'voice', label: 'Voz', icon: AudioLines, local: true },
  { id: 'memory', label: 'Memória', icon: Database },
  { id: 'devices', label: 'Dispositivos', icon: Smartphone },
  { id: 'lab', label: 'Laboratório', icon: FlaskConical, local: true },
  { id: 'agents', label: 'Agentes', icon: Bot, local: true },
  { id: 'system', label: 'Desempenho', icon: Activity },
  { id: 'account', label: 'Conta', icon: UserRound, remote: true },
] as const;

export function SettingsView() {
  const { api } = useJarvis();
  const local = api.mode === 'local';
  const read = () => location.hash.split('/')[2]?.split('?')[0] ?? 'general';
  const [tab, setTab] = useState<string>('general');
  useEffect(() => { setTab(read()); const on = () => setTab(read()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  const tabs = TABS.filter((t) => (local ? !('remote' in t) : !('local' in t)));
  return (
    <div className="flex flex-col md:flex-row h-full">
      <nav className="md:w-52 shrink-0 border-b md:border-b-0 md:border-r border-line p-2 md:p-3 flex md:flex-col gap-0.5 overflow-x-auto scroll-thin" aria-label="Seções de configurações">
        {tabs.map((t) => (
          <a key={t.id} href={`#/settings/${t.id}`} aria-current={tab === t.id ? 'page' : undefined} className={cx('press flex items-center gap-2 rounded-lg px-2.5 h-8 text-[13px] whitespace-nowrap', tab === t.id ? 'bg-white/[0.06] text-fg' : 'text-muted hover:text-fg')}><t.icon className={cx('size-4', tab === t.id ? 'text-orange-glow' : 'text-dim')} />{t.label}</a>
        ))}
      </nav>
      <div className="flex-1 min-w-0 overflow-y-auto scroll-thin">
        {tab === 'general' && <General />}
        {tab === 'brain' && <Brain />}
        {tab === 'models' && <ModelsView />}
        {tab === 'voice' && <VoiceSettings />}
        {tab === 'memory' && <MemoryView />}
        {tab === 'devices' && <DevicesView />}
        {tab === 'lab' && <LabView />}
        {tab === 'agents' && <AgentsView />}
        {tab === 'system' && <MonitorView />}
        {tab === 'account' && <Account />}
      </div>
    </div>
  );
}

function General() {
  const { api, notify } = useJarvis();
  const chat = useChat();
  const local = api.mode === 'local';
  const settings = useAsync(() => (local ? api.req<Record<string, unknown>>('/api/settings') : Promise.resolve({} as Record<string, unknown>)), [api]);
  const [motion, setMotion] = useState(false);
  useEffect(() => { try { setMotion(localStorage.getItem('jarvis.motion') === 'reduced'); } catch {} }, []);
  const save = (k: string, v: unknown) => api.req('/api/settings', { method: 'POST', json: { [k]: v } }).then(() => settings.reload()).catch((e) => notify('err', e.message));
  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-5">
      <Panel title="Raciocínio padrão">
        <ModeSelector value={chat.mode} onChange={chat.setMode} />
        <p className="mt-2 text-[12.5px] text-muted">{MODE_INFO[chat.mode].desc}</p>
      </Panel>
      <Panel title="Interface">
        <Row label="Reduzir animações" hint="Também respeita a preferência do sistema."><Toggle label="Reduzir animações" checked={motion} onChange={(v) => { setMotion(v); try { localStorage.setItem('jarvis.motion', v ? 'reduced' : ''); } catch {} document.documentElement.dataset.motion = v ? 'reduced' : ''; }} /></Row>
        <Row label="Rever o tutorial inicial"><Button size="sm" onClick={() => window.dispatchEvent(new Event('jarvis:onboarding'))}>Abrir</Button></Row>
        <Row label="Atalhos" hint="Ctrl+K busca e comandos · Alt+1…8 seções · Ctrl+Shift+O nova conversa · Ctrl+Shift+V voz · Esc para a geração"><span /></Row>
      </Panel>
      {local && (
        <Panel title="Conversas">
          <Row label="Títulos automáticos" hint="Gera um título curto após a primeira resposta (em segundo plano)."><Toggle label="Títulos automáticos" checked={settings.data?.['chat.autoTitle'] !== false} onChange={(v) => save('chat.autoTitle', v)} /></Row>
          <Row label="Mostrar conversas do PC no celular" hint="Por padrão o site só vê conversas iniciadas nele."><Toggle label="Compartilhar conversas" checked={settings.data?.['relay.shareLocalConversations'] === true} onChange={(v) => save('relay.shareLocalConversations', v)} /></Row>
          <Row label="Confirmações" hint="“Só ações sensíveis” evita perguntas repetitivas dentro do que você liberou.">
            <Select value={String(settings.data?.approvalMode ?? 'balanced')} onChange={(v) => save('approvalMode', v)} options={[{ value: 'balanced', label: 'Só ações sensíveis' }, { value: 'strict', label: 'Toda alteração' }]} />
          </Row>
        </Panel>
      )}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <div className="flex items-center gap-4 py-2.5 border-b border-line last:border-0"><div className="flex-1"><div className="text-[13px]">{label}</div>{hint && <div className="text-[11.5px] text-dim">{hint}</div>}</div>{children}</div>;
}

type VS = { stt: { engine: string | null; model: string | null }; tts: { engine: string | null; voices: string[] }; elevenlabs: { configured: boolean }; installable: { whisper: boolean; piper: boolean }; settings: Record<string, number | string | null> };

function VoiceSettings() {
  const { api, notify } = useJarvis();
  const vs = useAsync(() => api.req<VS>('/api/voice/status'), [api]);
  const installs = useAsync(() => api.req<Record<string, { status: string; progress: number; error?: string }>>('/api/voice/install'), [api], 1500);
  const [key, setKey] = useState('');
  const [testing, setTesting] = useState(false);
  const s = vs.data?.settings ?? {};
  const set = (patch: Record<string, unknown>) => api.req('/api/voice/settings', { method: 'POST', json: patch }).then(() => vs.reload()).catch((e) => notify('err', e.message));
  const test = async () => {
    setTesting(true);
    try {
      const r = await fetch(`${api.coreUrl}/api/voice/speak`, { method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Olá! Eu sou o Jarvis. Esta é a minha voz, com entonação e pausas naturais. Como posso ajudar hoje?' }) });
      if (!r.ok) throw new Error((await r.json()).error);
      const url = URL.createObjectURL(await r.blob());
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
      notify('ok', `Voz: ${r.headers.get('x-tts-provider')} · ${r.headers.get('x-tts-ms')} ms para sintetizar`);
    } catch (e) { notify('err', (e as Error).message); } finally { setTesting(false); }
  };
  const slider = (k: string, label: string, min: number, max: number, step: number, hint: string) => (
    <label className="block py-2"><div className="flex text-[12.5px]"><span>{label}</span><span className="ml-auto font-mono text-dim">{Number(s[k] ?? 0).toFixed(2)}</span></div>
      <input type="range" min={min} max={max} step={step} value={Number(s[k] ?? 0)} onChange={(e) => set({ [k]: Number(e.target.value) })} className="w-full accent-[#ff6d0a]" aria-label={label} />
      <div className="text-[11px] text-dim">{hint}</div></label>
  );
  const inst = (c: 'whisper' | 'piper') => installs.data?.[c];
  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-5">
      <Panel title="Motores de voz instalados">
        <Row label="Ouvir (reconhecimento de fala)" hint={vs.data?.stt.engine ? `${vs.data.stt.engine} · modelo ${vs.data.stt.model}` : 'Não instalado. O app do PC precisa dele para conversar por voz.'}>
          {vs.data?.installable.whisper ? <InstallBtn st={inst('whisper')} onClick={() => api.req('/api/voice/install', { method: 'POST', json: { component: 'whisper' } }).then(() => installs.reload())} label="Instalar (~150 MB)" /> : vs.data?.stt.engine ? <Badge tone="ok"><Check className="size-3" />pronto</Badge> : null}
        </Row>
        <Row label="Precisão do reconhecimento" hint="“small” entende melhor o português, mas é mais lento que “base”. Mudar exige reinstalar.">
          <Select value={String(s.whisperModel ?? 'base')} onChange={(v) => set({ whisperModel: v })} options={[{ value: 'base', label: 'base (rápido)' }, { value: 'small', label: 'small (mais preciso)' }]} />
        </Row>
        <Row label="Voz natural local (Piper, pt-BR)" hint={vs.data?.tts.engine ? `Instalada: ${vs.data.tts.voices.join(', ')}` : 'Voz neural que roda no seu PC, bem menos robótica que a do sistema.'}>
          {vs.data?.installable.piper ? <InstallBtn st={inst('piper')} onClick={() => api.req('/api/voice/install', { method: 'POST', json: { component: 'piper' } }).then(() => installs.reload())} label="Instalar (~80 MB)" /> : vs.data?.tts.engine ? <Badge tone="ok"><Check className="size-3" />pronto</Badge> : null}
        </Row>
      </Panel>

      <Panel title="Qual voz usar">
        <Row label="Provedor" hint="Automático: ElevenLabs se houver chave, senão Piper local, senão a voz do sistema.">
          <Select value={String(s.provider ?? 'auto')} onChange={(v) => set({ provider: v })} options={[{ value: 'auto', label: 'Automático' }, { value: 'elevenlabs', label: 'ElevenLabs (premium)' }, { value: 'piper', label: 'Piper (local)' }, { value: 'browser', label: 'Voz do sistema' }]} />
        </Row>
        {slider('speed', 'Velocidade da fala', 0.7, 1.4, 0.05, 'Ritmo geral da voz.')}
        <Button size="sm" variant="primary" icon={testing ? <Loader2 className="size-3.5 animate-spin" /> : <AudioLines className="size-3.5" />} onClick={test} disabled={testing}>Ouvir exemplo</Button>
      </Panel>

      <Panel title="Ajuste fino — Piper (voz local)">
        {slider('piperExpressiveness', 'Expressividade (entonação)', 0.1, 1, 0.05, 'Mais alto = mais variação de entonação, mais humano; muito alto pode soar instável.')}
        {slider('piperRhythm', 'Variação de ritmo', 0.1, 1.2, 0.05, 'Variação natural da duração das sílabas.')}
        {slider('piperPauseSec', 'Pausa entre frases (s)', 0, 0.8, 0.05, 'Respiro entre frases.')}
      </Panel>

      <Panel title="ElevenLabs (voz premium, opcional)" icon={<KeyRound className="size-4" />}>
        <p className="text-[12.5px] text-muted">Vozes neurais de altíssima qualidade em português, via internet (requer conta e chave). A chave fica criptografada pelo Windows e nunca volta para a interface. O texto falado é enviado à ElevenLabs.</p>
        <div className="mt-3 flex gap-2 items-center">
          {vs.data?.elevenlabs.configured ? (
            <><Badge tone="ok">chave configurada</Badge><Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => api.req('/api/credentials/elevenlabs.apiKey', { method: 'DELETE' }).then(() => vs.reload())}>Remover chave</Button></>
          ) : (
            <><Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Chave da API ElevenLabs" className="h-9" autoComplete="off" /><Button size="sm" disabled={key.length < 8} onClick={() => api.req('/api/credentials', { method: 'POST', json: { name: 'elevenlabs.apiKey', value: key } }).then(() => { setKey(''); void vs.reload(); notify('ok', 'Chave salva com segurança'); }).catch((e) => notify('err', e.message))}>Salvar</Button></>
          )}
        </div>
        <div className="mt-3 grid sm:grid-cols-2 gap-3">
          <label className="text-[12.5px]">ID da voz<Input value={String(s.elevenVoiceId ?? '')} onChange={(e) => set({ elevenVoiceId: e.target.value })} className="h-9 mt-1 font-mono" /></label>
          <label className="text-[12.5px]">Modelo<Select className="w-full mt-1" value={String(s.elevenModel ?? 'eleven_flash_v2_5')} onChange={(v) => set({ elevenModel: v })} options={[{ value: 'eleven_flash_v2_5', label: 'Flash v2.5 (menor latência)' }, { value: 'eleven_turbo_v2_5', label: 'Turbo v2.5' }, { value: 'eleven_multilingual_v2', label: 'Multilingual v2 (mais expressivo)' }]} /></label>
        </div>
        {slider('stability', 'Estabilidade', 0, 1, 0.05, 'Menor = mais expressiva e variada; maior = mais constante.')}
        {slider('similarity', 'Fidelidade à voz', 0, 1, 0.05, 'Quanto a síntese se prende ao timbre original.')}
        {slider('style', 'Estilo / exagero', 0, 1, 0.05, 'Realça o estilo da voz; valores altos aumentam a latência.')}
      </Panel>
    </div>
  );
}

function InstallBtn({ st, onClick, label }: { st?: { status: string; progress: number; error?: string }; onClick: () => void; label: string }) {
  if (st?.status && !['erro', 'instalado'].includes(st.status)) return <span className="text-[12px] text-muted flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin text-orange" />{st.status} {st.progress ? `${st.progress}%` : ''}</span>;
  return <div className="text-right"><Button size="sm" icon={<Download className="size-3.5" />} onClick={onClick}>{label}</Button>{st?.error && <div className="text-[11px] text-err mt-1 max-w-56">{st.error}</div>}</div>;
}

function Account() {
  const { notify } = useJarvis();
  const [name, setName] = useState('');
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => { void supabase().auth.getUser().then((u) => setName(u.data.user?.email?.replace(/@u\.jarvisultra\.app$/, '') ?? '')); }, []);
  return (
    <div className="p-4 sm:p-6 max-w-2xl space-y-5">
      <Panel title="Sua conta">
        <Row label="Usuário"><span className="font-mono text-[13px]">{name}</span></Row>
        <Row label="Código de recuperação" hint="Permite redefinir a senha sem e-mail. Gerar um novo invalida o anterior.">
          <Button size="sm" onClick={async () => { const r = await supabase().rpc('jarvis_new_recovery_code'); if (r.error) notify('err', r.error.message); else setCode((r.data as { recovery_code: string }).recovery_code); }}>Gerar</Button>
        </Row>
        {code && <div className="mt-2 rounded-xl border border-amber/30 bg-amber/[0.06] p-3 text-[13px]">Guarde agora — não será mostrado de novo:<div className="mt-1 font-mono text-lg tracking-[0.2em] text-amber select-all">{code}</div></div>}
        <Row label="Sair"><div className="flex gap-2"><Button size="sm" onClick={() => supabase().auth.signOut()}>Deste aparelho</Button><Button size="sm" variant="danger" onClick={() => supabase().auth.signOut({ scope: 'global' })}>De todos</Button></div></Row>
      </Panel>
    </div>
  );
}

const AI_PROVIDERS = [
  { id: 'groq', name: 'Groq', url: 'https://console.groq.com/keys', hint: 'gsk_…', what: 'GPT-OSS 120B e Qwen3 — o mais rápido', how: 'Entre com Google → Create API Key' },
  { id: 'gemini', name: 'Google Gemini', url: 'https://aistudio.google.com/apikey', hint: 'AIza…', what: 'Gemini Flash/Pro — cota grátis enorme', how: 'Entre com Google → Create API key' },
  { id: 'cerebras', name: 'Cerebras', url: 'https://cloud.cerebras.ai/', hint: 'csk-…', what: 'GPT-OSS 120B e Qwen3 — muito rápido', how: 'Crie a conta → API Keys' },
  { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/keys', hint: 'sk-or-…', what: 'Modelos :free (DeepSeek, Qwen Coder…)', how: 'Entre → Keys → Create Key' },
  { id: 'mistral', name: 'Mistral', url: 'https://console.mistral.ai/api-keys', hint: '…', what: 'Mistral Large e Codestral (código)', how: 'Plano Experiment (grátis) → API Keys' },
  { id: 'sambanova', name: 'SambaNova', url: 'https://cloud.sambanova.ai/apis', hint: '…', what: 'DeepSeek V3 e Llama', how: 'Entre → API Keys' },
  { id: 'nvidia', name: 'NVIDIA', url: 'https://build.nvidia.com/', hint: 'nvapi-…', what: 'DeepSeek, Qwen Coder, Kimi', how: 'Entre → Get API Key' },
] as const;

/** Várias chaves grátis somadas: o Jarvis reveza entre todas (a mais inteligente primeiro). */
function Brain() {
  const { notify } = useJarvis();
  const st = useAsync(async () => {
    const { data, error } = await supabase().rpc('jarvis_ai_key_status');
    if (error) throw new Error(error.message);
    return data as { configured: boolean; keys: { provider: string; hint: string; models: string[]; status: string | null }[] };
  }, []);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const call = async (provider: string, body: Record<string, unknown>) => {
    const { data } = await supabase().auth.getSession();
    const r = await fetch(`${SUPABASE_URL}/functions/v1/jarvis-ai-keys`, { method: 'POST', headers: { authorization: `Bearer ${data.session?.access_token ?? ''}`, apikey: SUPABASE_ANON, 'content-type': 'application/json' }, body: JSON.stringify({ provider, ...body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
    return j as { models?: string[] };
  };
  const save = async (provider: string) => {
    setBusy(provider);
    try {
      const j = await call(provider, { key: (keys[provider] ?? '').trim() });
      setKeys((k) => ({ ...k, [provider]: '' }));
      void cloudAiStatus(true);
      notify('ok', `Conectado! Modelos: ${(j.models ?? []).slice(0, 3).join(', ')}`);
      await st.reload();
    } catch (e) { notify('err', (e as Error).message); } finally { setBusy(null); }
  };
  const remove = async (provider: string) => {
    if (!confirm('Remover esta chave?')) return;
    setBusy(provider);
    try { await call(provider, { action: 'remove' }); void cloudAiStatus(true); await st.reload(); } catch (e) { notify('err', (e as Error).message); } finally { setBusy(null); }
  };
  const on = new Map((st.data?.keys ?? []).map((k) => [k.provider, k]));
  return (
    <div className="space-y-4 max-w-3xl">
      <Panel title="Inteligência na nuvem" icon={<Sparkles className="size-4 text-orange-glow" />}>
        <p className="text-[13px] text-muted">Cada IA grátis tem uma cota por minuto/dia. <b className="text-fg">Conecte quantas quiser</b>: o Jarvis soma todas e reveza sozinho — quando uma enche, usa a próxima, sem você perceber. Quanto mais chaves, mais perto de ilimitado. As chaves ficam só no servidor.</p>
        <div className="mt-3 flex items-center gap-2 text-[13px]">
          <span className={cx('size-2 rounded-full', on.size ? 'bg-ok' : 'bg-amber')} />
          {st.loading ? 'Verificando…' : on.size ? `${on.size} IA(s) conectada(s)` : 'Nenhuma chave: usando a IA pública gratuita (lenta)'}
        </div>
      </Panel>
      <div className="grid gap-3">
        {AI_PROVIDERS.map((p) => {
          const k = on.get(p.id);
          return (
            <div key={p.id} className={cx('surface rounded-xl p-4 lift', k && 'border-ok/30')}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={cx('size-2 rounded-full', k ? 'bg-ok' : 'bg-white/20')} />
                <span className="text-[14px] font-medium">{p.name}</span>
                <span className="text-[12px] text-dim">· {p.what}</span>
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="ml-auto text-[12px] text-orange-soft hover:underline inline-flex items-center gap-1">Pegar chave grátis<ExternalLink className="size-3" /></a>
              </div>
              {k ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                  <Check className="size-3.5 text-ok" />Conectado (…{k.hint}) · {k.models?.slice(0, 3).join(', ')}
                  <button onClick={() => void remove(p.id)} disabled={busy === p.id} className="ml-auto text-dim hover:text-err inline-flex items-center gap-1"><Trash2 className="size-3.5" />Remover</button>
                </div>
              ) : (
                <>
                  <div className="mt-1 text-[11.5px] text-dim">{p.how}</div>
                  <div className="mt-2.5 flex gap-2">
                    <Input type="password" autoComplete="off" placeholder={p.hint} value={keys[p.id] ?? ''} onChange={(e) => setKeys((x) => ({ ...x, [p.id]: e.target.value }))} className="flex-1" aria-label={`Chave ${p.name}`} />
                    <Button variant="primary" icon={<KeyRound className="size-3.5" />} disabled={(keys[p.id] ?? '').trim().length < 20} loading={busy === p.id} onClick={() => void save(p.id)}>Conectar</Button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
