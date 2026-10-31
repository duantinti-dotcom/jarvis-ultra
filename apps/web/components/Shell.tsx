'use client';
import { useEffect, useState, type ComponentType } from 'react';
import dynamic from 'next/dynamic';
import { MessageSquare, Code2, AudioLines, MonitorCog, FolderKanban, History, ShieldCheck, Settings, OctagonX, Wifi, WifiOff, Camera, Check, X, Menu, Globe, Search, Loader2 } from 'lucide-react';
import { useJarvis } from '@/lib/store';
import { ChatProvider } from '@/lib/chat';
import type { Device } from '@/lib/types';
import { Badge, Button, cx } from './ui';
import { CommandPalette } from './CommandPalette';
import { Onboarding } from './Onboarding';

const loading = () => <div className="h-full grid place-items-center"><Loader2 className="size-5 animate-spin text-orange" /></div>;
const ChatView = dynamic(() => import('@/views/Chat').then((m) => m.ChatView), { loading });
const CodeView = dynamic(() => import('@/views/CodeHub').then((m) => m.CodeHub), { loading, ssr: false });
const VoiceView = dynamic(() => import('@/views/Voice').then((m) => m.VoiceView), { loading, ssr: false });
const DesktopView = dynamic(() => import('@/views/Desktop').then((m) => m.DesktopView), { loading });
const FilesView = dynamic(() => import('@/views/Files').then((m) => m.FilesView), { loading });
const HistoryView = dynamic(() => import('@/views/History').then((m) => m.HistoryView), { loading });
const SecurityView = dynamic(() => import('@/views/Security').then((m) => m.SecurityView), { loading });
const SettingsView = dynamic(() => import('@/views/Settings').then((m) => m.SettingsView), { loading });

type ViewDef = { id: string; label: string; hint: string; icon: ComponentType<{ className?: string }>; C: ComponentType; localOnly?: boolean; group: 'main' | 'system' };
export const VIEWS: ViewDef[] = [
  { id: 'chat', label: 'Jarvis Chat', hint: 'Converse, pergunte e peça tarefas', icon: MessageSquare, C: ChatView, group: 'main' },
  { id: 'code', label: 'Jarvis Code', hint: 'Crie sites completos com preview ao vivo', icon: Code2, C: CodeView, group: 'main' },
  { id: 'voice', label: 'Jarvis Voice', hint: 'Converse por voz', icon: AudioLines, C: VoiceView, group: 'main' },
  { id: 'desktop', label: 'Desktop Control', hint: 'Tarefas reais no Windows', icon: MonitorCog, C: DesktopView, localOnly: true, group: 'main' },
  { id: 'files', label: 'Arquivos e projetos', hint: 'Pastas liberadas e projetos', icon: FolderKanban, C: FilesView, localOnly: true, group: 'main' },
  { id: 'history', label: 'Histórico', hint: 'Conversas e tarefas', icon: History, C: HistoryView, group: 'system' },
  { id: 'security', label: 'Security Center', hint: 'Permissões e privacidade', icon: ShieldCheck, C: SecurityView, group: 'system' },
  { id: 'settings', label: 'Configurações', hint: 'Modelos, voz, dispositivos', icon: Settings, C: SettingsView, group: 'system' },
];

const readHash = () => (typeof location !== 'undefined' ? location.hash.replace(/^#\/?/, '').split(/[?/]/)[0] || 'chat' : 'chat');

export function Shell({ device }: { device?: Device }) {
  return (
    <ChatProvider>
      <ShellInner device={device} />
    </ChatProvider>
  );
}

function ShellInner({ device }: { device?: Device }) {
  const { api, conn, connDetail, status, approvals, decide, notices, capture, tasks } = useJarvis();
  const [view, setView] = useState('chat');
  const [mobileNav, setMobileNav] = useState(false);
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const on = () => { setView(readHash()); setMobileNav(false); };
    on();
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
      if (e.altKey && /^[1-8]$/.test(e.key)) { e.preventDefault(); location.hash = `#/${VIEWS[Number(e.key) - 1]!.id}`; }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'v') { e.preventDefault(); location.hash = '#/voice?auto=1'; }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); location.hash = '#/chat?new=1'; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const def = VIEWS.find((v) => v.id === view) ?? VIEWS[0]!;
  const Active = def.C;
  const remote = api.mode === 'remote';
  const online = conn === 'online';
  const running = Object.values(tasks).filter((t) => !['completed', 'failed', 'cancelled'].includes(t.state));
  const immersive = view === 'voice';

  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label="Navegação principal">
      {(['main', 'system'] as const).map((g) => (
        <div key={g} className={cx(g === 'system' && 'mt-4 pt-4 border-t border-line')}>
          {VIEWS.filter((v) => v.group === g).map((v) => {
            const Icon = v.icon;
            const i = VIEWS.indexOf(v);
            const disabled = remote && v.localOnly;
            const active = view === v.id;
            return (
              <a key={v.id} href={`#/${v.id}`} aria-current={active ? 'page' : undefined} title={disabled ? 'Disponível no app do computador' : `${v.hint} (Alt+${i + 1})`}
                className={cx('press group relative flex items-center gap-3 rounded-lg px-2.5 h-9 text-[13px]', active ? 'bg-white/[0.06] text-fg' : 'text-muted hover:text-fg hover:bg-white/[0.035]', disabled && 'opacity-40')}>
                {active && <span className="absolute -left-3 top-2 bottom-2 w-[3px] rounded-r-full bg-gradient-to-b from-orange-glow to-amber" />}
                <Icon className={cx('size-[16px] shrink-0', active ? 'text-orange-glow' : 'text-dim group-hover:text-muted')} />
                <span className="truncate">{v.label}</span>
                {v.id === 'desktop' && running.length > 0 && <span className="ml-auto size-1.5 rounded-full bg-orange animate-pulse-soft" aria-label="tarefa em execução" />}
                {v.id === 'security' && approvals.length > 0 && <span className="ml-auto rounded-full bg-amber text-black text-[10px] font-bold px-1.5">{approvals.length}</span>}
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );

  const sidebar = (
    <>
      <Brand />
      <button onClick={() => setPalette(true)} className="press mt-5 flex items-center gap-2 rounded-lg border border-line bg-white/[0.02] px-2.5 h-9 text-[12.5px] text-dim hover:text-muted hover:border-line-strong">
        <Search className="size-3.5 shrink-0" /><span className="whitespace-nowrap">Buscar e comandos</span><kbd className="ml-auto whitespace-nowrap font-mono text-[10px] rounded border border-line px-1">Ctrl K</kbd>
      </button>
      <div className="mt-4 flex-1 overflow-y-auto scroll-thin pl-3 -ml-3">{nav}</div>
      <div className="mt-3 space-y-2">
        <ConnectionPill remote={remote} online={online} pcOnline={!!status?.online} device={device} relay={status?.relay} />
        <EmergencyButton />
      </div>
    </>
  );

  return (
    <div className="h-dvh flex">
      <aside className="hidden lg:flex w-[236px] shrink-0 flex-col border-r border-line bg-black/25 px-3 py-4">{sidebar}</aside>
      {mobileNav && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={() => setMobileNav(false)}>
          <aside className="absolute left-0 top-0 bottom-0 w-[268px] bg-surface border-r border-line px-3 py-4 flex flex-col animate-fade-up" onClick={(e) => e.stopPropagation()}>{sidebar}</aside>
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        {!immersive && (
          <header className="h-12 shrink-0 flex items-center gap-2 px-3 sm:px-5 border-b border-line">
            <button className="lg:hidden p-2 -ml-1 text-muted" onClick={() => setMobileNav(true)} aria-label="Abrir menu"><Menu className="size-5" /></button>
            <h1 className="font-display text-[14px] font-semibold truncate">{def.label}</h1>
            <span className="hidden md:inline text-[12px] text-dim truncate">· {def.hint}</span>
            <div className="ml-auto flex items-center gap-1.5 overflow-hidden">
              {capture && <Badge tone="warn" pulse><Camera className="size-3" />Captura de tela: {capture.scope}</Badge>}
              {status?.relay?.enabled && status.relay.connected && <span className="hidden sm:inline-flex"><Badge tone="orange" pulse><Globe className="size-3" />Acesso remoto ativo</Badge></span>}
              {running.length > 0 && <a href="#/desktop"><Badge tone="orange" pulse><Loader2 className="size-3 animate-spin" />{running.length} tarefa{running.length > 1 ? 's' : ''}</Badge></a>}
              {status?.device?.model && <span className="hidden md:inline-flex"><Badge>{status.device.model.replace(/:latest$/, '')}</Badge></span>}
            </div>
          </header>
        )}
        {(conn === 'offline' || conn === 'no-device') && (
          <div role="status" className="px-5 py-2 text-[12.5px] bg-err/[0.08] border-b border-err/20 text-err flex items-center gap-2"><WifiOff className="size-3.5 shrink-0" />{connDetail ?? 'Sem conexão.'} Nenhum resultado é simulado enquanto estiver offline.</div>
        )}
        {status?.emergencyStop && (
          <div role="alert" className="px-5 py-2 text-[12.5px] bg-err/[0.12] border-b border-err/30 text-err flex items-center gap-2">
            <OctagonX className="size-3.5" />Parada de emergência ativa: nenhuma ação será executada.
            <Button size="sm" variant="danger" className="ml-auto" onClick={async () => { await api.req('/api/emergency/resume', { method: 'POST' }); location.reload(); }}>Retomar</Button>
          </div>
        )}
        <main className={cx('flex-1 min-h-0', immersive ? 'overflow-hidden' : 'overflow-y-auto scroll-thin')}>
          {remote && def.localOnly ? <LocalOnly label={def.label} pcOnline={!!status?.online} /> : <div key={view} className="h-full view-enter"><Active /></div>}
        </main>
      </div>

      {approvals.length > 0 && (
        <div className="fixed right-3 bottom-3 sm:right-5 sm:bottom-5 z-30 w-[min(380px,calc(100vw-24px))] space-y-2">
          {approvals.slice(0, 3).map((a) => (
            <div key={a.id} className="surface-raised rounded-2xl p-3.5 !border-amber/30 animate-fade-up" role="alertdialog" aria-label={`Aprovar ${a.tool}`}>
              <div className="flex items-center gap-2">
                <Badge tone={a.risk === 'high' || a.risk === 'critical' ? 'err' : 'warn'}>confirmação · risco {a.risk}</Badge>
                <span className="ml-auto label-tech">{a.origin === 'remote' ? 'pelo celular' : 'neste PC'}</span>
              </div>
              <p className="mt-2 text-[13px]"><span className="font-mono text-orange-soft">{a.tool}</span></p>
              <p className="text-[12px] text-muted line-clamp-2">{a.reason}</p>
              <pre className="mt-2 max-h-24 overflow-auto scroll-thin rounded-lg bg-black/40 p-2 text-[11px] font-mono text-fg/80 whitespace-pre-wrap break-all">{JSON.stringify(a.args, null, 1)}</pre>
              <div className="mt-2.5 flex gap-2">
                <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={() => decide(a.id, true)}>Permitir</Button>
                <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => decide(a.id, false)}>Negar</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="fixed left-1/2 -translate-x-1/2 bottom-5 z-50 space-y-2 w-[min(440px,calc(100vw-24px))] pointer-events-none" aria-live="polite">
        {notices.map((n) => (
          <div key={n.id} className={cx('surface-raised rounded-xl px-3.5 py-2.5 text-[13px] animate-fade-up', n.tone === 'err' && '!border-err/40 text-err', n.tone === 'ok' && '!border-ok/40 text-ok', n.tone === 'warn' && '!border-amber/40 text-amber')}>{n.text}</div>
        ))}
      </div>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      <Onboarding />
    </div>
  );
}

function Brand() {
  return (
    <a href="#/chat" className="flex items-center gap-2.5 px-1">
      <span className="relative grid place-items-center size-8 rounded-[10px] bg-gradient-to-br from-[#2a1a0e] to-[#0f0d0b] border border-orange/25">
        <svg viewBox="0 0 64 64" className="size-6" aria-hidden><circle cx="32" cy="32" r="22" fill="none" stroke="#ff8a2b" strokeWidth="3" strokeDasharray="28 8" /><circle cx="32" cy="32" r="9" fill="#ffb35c" /></svg>
      </span>
      <div>
        <div className="font-display font-semibold tracking-[0.2em] text-[14px] leading-none">JARVIS</div>
        <div className="font-mono text-[9px] tracking-[0.18em] mt-1 text-orange-soft/80">ULTRA · 0.2</div>
      </div>
    </a>
  );
}

function ConnectionPill({ remote, online, pcOnline, relay }: { remote: boolean; online: boolean; pcOnline?: boolean; device?: Device; relay?: { enabled: boolean; connected: boolean } }) {
  return (
    <div className="flex items-center gap-2 rounded-lg px-2.5 h-8 text-[11.5px] text-muted bg-white/[0.025]">
      {online ? <Wifi className="size-3.5 text-ok" /> : <WifiOff className="size-3.5 text-err" />}
      <span className="truncate">{remote ? `Nuvem · PC ${pcOnline ? 'online' : 'offline'}` : `Núcleo local · ${online ? 'conectado' : 'offline'}`}</span>
      {!remote && relay?.enabled && <Globe className={cx('ml-auto size-3.5', relay.connected ? 'text-orange' : 'text-dim')} aria-label={relay.connected ? 'acesso remoto conectado' : 'acesso remoto desconectado'} />}
    </div>
  );
}

function EmergencyButton() {
  const { api, notify } = useJarvis();
  const [confirm, setConfirm] = useState(false);
  return (
    <Button variant="danger" size="sm" className="w-full" icon={<OctagonX className="size-3.5" />}
      onClick={async () => {
        if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3000); return; }
        try { await api.emergencyStop(); } catch (e) { notify('err', (e as Error).message); }
        setConfirm(false);
      }}>
      {confirm ? 'Confirmar parada total' : 'Parada de emergência'}
    </Button>
  );
}

function LocalOnly({ label, pcOnline }: { label: string; pcOnline: boolean }) {
  return (
    <div className="h-full grid place-items-center p-6">
      <div className="max-w-md text-center">
        <MonitorCog className="size-9 mx-auto text-orange-soft" />
        <h2 className="mt-3 font-display text-lg">{label} roda no seu computador</h2>
        <p className="mt-2 text-[13px] text-muted">Esta função usa arquivos, programas e o terminal do PC. Por segurança, ela fica disponível no aplicativo JARVIS instalado no Windows. Pelo site você conversa, cria imagens e fala por voz sem precisar do PC.{pcOnline ? ' Seu PC está online: peça tarefas no computador pelo chat.' : ''}</p>
      </div>
    </div>
  );
}
