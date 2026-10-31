'use client';
import { useEffect, useState, type ComponentType } from 'react';
import {
  Command, MessageSquare, Phone, Monitor, ListChecks, Database, Bot, FlaskConical, Cpu, Activity, Smartphone, ShieldCheck,
  OctagonX, Wifi, WifiOff, Camera, Check, X, Menu, Globe,
} from 'lucide-react';
import { useJarvis } from '@/lib/store';
import type { Device } from '@/lib/types';
import { Badge, Button, cx } from './ui';
import { LABEL } from './JarvisCore';
import { CommandCenter } from '@/views/CommandCenter';
import { ChatView } from '@/views/Chat';
import { VoiceView } from '@/views/Voice';
import { DesktopView } from '@/views/Desktop';
import { TasksView } from '@/views/Tasks';
import { MemoryView } from '@/views/Memory';
import { AgentsView } from '@/views/Agents';
import { LabView } from '@/views/Lab';
import { ModelsView } from '@/views/Models';
import { MonitorView } from '@/views/Monitor';
import { DevicesView } from '@/views/Devices';
import { SecurityView } from '@/views/Security';

type ViewDef = { id: string; label: string; icon: ComponentType<{ className?: string }>; C: ComponentType; localOnly?: boolean };
export const VIEWS: ViewDef[] = [
  { id: 'command', label: 'Command Center', icon: Command, C: CommandCenter },
  { id: 'chat', label: 'Neural Chat', icon: MessageSquare, C: ChatView },
  { id: 'voice', label: 'Live Voice', icon: Phone, C: VoiceView },
  { id: 'desktop', label: 'Desktop Control', icon: Monitor, C: DesktopView, localOnly: true },
  { id: 'tasks', label: 'Task Engine', icon: ListChecks, C: TasksView },
  { id: 'memory', label: 'Memory Vault', icon: Database, C: MemoryView },
  { id: 'agents', label: 'Agent Hub', icon: Bot, C: AgentsView, localOnly: true },
  { id: 'lab', label: 'JARVIS Lab', icon: FlaskConical, C: LabView, localOnly: true },
  { id: 'models', label: 'Model Manager', icon: Cpu, C: ModelsView, localOnly: true },
  { id: 'monitor', label: 'System Monitor', icon: Activity, C: MonitorView },
  { id: 'devices', label: 'Device Center', icon: Smartphone, C: DevicesView },
  { id: 'security', label: 'Security Center', icon: ShieldCheck, C: SecurityView },
];

const readHash = () => (typeof location !== 'undefined' ? location.hash.replace(/^#\/?/, '').split('?')[0] || 'command' : 'command');

export function Shell({ device }: { device?: Device }) {
  const { api, conn, connDetail, status, visual, approvals, decide, notices, capture } = useJarvis();
  const [view, setView] = useState('command');
  const [mobileNav, setMobileNav] = useState(false);
  useEffect(() => {
    const on = () => { setView(readHash()); setMobileNav(false); };
    on();
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && /^[1-9]$/.test(e.key)) { location.hash = `#/${VIEWS[Number(e.key) - 1]!.id}`; e.preventDefault(); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v') { location.hash = '#/voice?auto=1'; e.preventDefault(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { location.hash = '#/command'; setTimeout(() => document.getElementById('command-input')?.focus(), 30); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const def = VIEWS.find((v) => v.id === view) ?? VIEWS[0]!;
  const Active = def.C;
  const remote = api.mode === 'remote';
  const online = conn === 'online';

  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label="Navegação principal">
      {VIEWS.map((v, i) => {
        const Icon = v.icon;
        const disabled = remote && v.localOnly;
        return (
          <a key={v.id} href={`#/${v.id}`} aria-current={view === v.id ? 'page' : undefined} title={disabled ? 'Disponível no app do computador' : `${v.label} (Alt+${i + 1})`}
            className={cx('group relative flex items-center gap-3 rounded-xl px-3 h-10 text-[13px] transition-colors', view === v.id ? 'bg-orange/[0.1] text-fg' : 'text-muted hover:text-fg hover:bg-white/[0.04]', disabled && 'opacity-40')}>
            {view === v.id && <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-orange shadow-[0_0_10px_#ff6a00]" />}
            <Icon className={cx('size-[17px]', view === v.id ? 'text-orange' : 'text-dim group-hover:text-muted')} />
            <span className="truncate">{v.label}</span>
            {v.id === 'tasks' && approvals.length > 0 && <span className="ml-auto rounded-full bg-warn/90 text-black text-[10px] font-bold px-1.5">{approvals.length}</span>}
          </a>
        );
      })}
    </nav>
  );

  return (
    <div className="h-dvh flex">
      {/* Sidebar */}
      <aside className="hidden lg:flex w-[232px] shrink-0 flex-col border-r border-line bg-black/20 px-3 py-4">
        <Brand />
        <div className="mt-6 flex-1 overflow-y-auto scroll-thin">{nav}</div>
        <EmergencyButton />
      </aside>
      {mobileNav && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={() => setMobileNav(false)}>
          <aside className="absolute left-0 top-0 bottom-0 w-[260px] bg-surface border-r border-line p-3 flex flex-col" onClick={(e) => e.stopPropagation()}>
            <Brand />
            <div className="mt-5 flex-1 overflow-y-auto">{nav}</div>
            <EmergencyButton />
          </aside>
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top bar */}
        <header className="h-14 shrink-0 flex items-center gap-2 px-3 sm:px-5 border-b border-line bg-black/10">
          <button className="lg:hidden p-2 -ml-1 text-muted" onClick={() => setMobileNav(true)} aria-label="Abrir menu"><Menu className="size-5" /></button>
          <h1 className="font-display text-[15px] font-semibold truncate">{def.label}</h1>
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2 overflow-hidden">
            {capture && <Badge tone="warn" pulse><Camera className="size-3" />Captura: {capture.scope}</Badge>}
            {status?.relay?.enabled && <Badge tone={status.relay.connected ? 'orange' : 'warn'} pulse={status.relay.connected}><Globe className="size-3" />{status.relay.connected ? 'Acesso remoto ativo' : 'Remoto desconectado'}</Badge>}
            {remote && device && <Badge tone={online ? 'ok' : 'err'} pulse={online}>{online ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}<span className="hidden sm:inline">{device.name}</span></Badge>}
            {!remote && <Badge tone={online ? 'ok' : 'err'} pulse={online}>{online ? 'Core local' : 'Core offline'}</Badge>}
            {status?.device?.model && <span className="hidden md:inline-flex"><Badge><Cpu className="size-3" />{status.device.model.replace(/:latest$/, '')}</Badge></span>}
            <span className="hidden sm:inline-flex"><Badge tone="orange">{LABEL[visual]}</Badge></span>
          </div>
        </header>
        {(conn === 'offline' || conn === 'no-device') && (
          <div role="status" className="px-5 py-2 text-[12.5px] bg-err/[0.08] border-b border-err/20 text-err flex items-center gap-2">
            <WifiOff className="size-3.5" />{connDetail ?? 'Sem conexão.'} Nenhum resultado é simulado enquanto estiver offline.
          </div>
        )}
        {status?.emergencyStop && (
          <div role="alert" className="px-5 py-2 text-[12.5px] bg-err/[0.12] border-b border-err/30 text-err flex items-center gap-2">
            <OctagonX className="size-3.5" />Parada de emergência ativa: nenhuma ferramenta será executada.
            <Button size="sm" variant="danger" className="ml-auto" onClick={async () => { await api.req('/api/emergency/resume', { method: 'POST' }); location.reload(); }}>Retomar</Button>
          </div>
        )}
        <main className="flex-1 min-h-0 overflow-y-auto scroll-thin" key={def.id}>
          {remote && def.localOnly ? <LocalOnly label={def.label} /> : <Active />}
        </main>
      </div>

      {/* Aprovações pendentes (flutuante) */}
      {approvals.length > 0 && (
        <div className="fixed right-3 bottom-3 sm:right-5 sm:bottom-5 z-30 w-[min(380px,calc(100vw-24px))] space-y-2">
          {approvals.slice(0, 3).map((a) => (
            <div key={a.id} className="glass rounded-2xl p-3.5 border-warn/30 animate-fade-up" role="alertdialog" aria-label={`Aprovar ${a.tool}`}>
              <div className="flex items-center gap-2">
                <Badge tone={a.risk === 'high' || a.risk === 'critical' ? 'err' : 'warn'}>risco {a.risk}</Badge>
                <span className="font-mono text-[12px] text-orange-soft">{a.tool}</span>
                <span className="ml-auto label-tech">{a.origin}</span>
              </div>
              <p className="mt-2 text-[12.5px] text-muted line-clamp-2">{a.reason}</p>
              <pre className="mt-2 max-h-24 overflow-auto scroll-thin rounded-lg bg-black/40 p-2 text-[11px] font-mono text-fg/80">{JSON.stringify(a.args, null, 1)}</pre>
              <div className="mt-2.5 flex gap-2">
                <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={() => decide(a.id, true)}>Aprovar</Button>
                <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => decide(a.id, false)}>Negar</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="fixed left-1/2 -translate-x-1/2 top-3 z-50 space-y-2 w-[min(460px,calc(100vw-24px))]" aria-live="polite">
        {notices.map((n) => (
          <div key={n.id} className={cx('glass rounded-xl px-3.5 py-2.5 text-[13px] animate-fade-up', n.tone === 'err' && 'border-err/40 text-err', n.tone === 'ok' && 'border-ok/40 text-ok', n.tone === 'warn' && 'border-warn/40 text-warn')}>{n.text}</div>
        ))}
      </div>
    </div>
  );
}

function Brand() {
  return (
    <a href="#/command" className="flex items-center gap-2.5 px-2">
      <svg viewBox="0 0 64 64" className="size-8" aria-hidden><circle cx="32" cy="32" r="22" fill="none" stroke="#ff6a00" strokeWidth="2.5" strokeDasharray="26 8" /><circle cx="32" cy="32" r="14" fill="none" stroke="#ffb36b" strokeWidth="1.5" strokeDasharray="3 4" /><circle cx="32" cy="32" r="7" fill="#ff8c32" /></svg>
      <div>
        <div className="font-display font-semibold tracking-[0.18em] text-[14px] leading-none">JARVIS</div>
        <div className="label-tech !text-[9px] mt-1 !text-orange/80">ULTRA · v0.1</div>
      </div>
    </a>
  );
}

function EmergencyButton() {
  const { api, notify } = useJarvis();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="mt-3">
      <Button variant="danger" className="w-full" icon={<OctagonX className="size-4" />}
        onClick={async () => {
          if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3000); return; }
          try { await api.emergencyStop(); } catch (e) { notify('err', (e as Error).message); }
          setConfirm(false);
        }}>
        {confirm ? 'Clique de novo para parar' : 'Parada de emergência'}
      </Button>
    </div>
  );
}

function LocalOnly({ label }: { label: string }) {
  return (
    <div className="p-6 max-w-xl">
      <div className="glass rounded-2xl p-5 text-sm text-muted">
        <div className="font-display text-base text-fg mb-1">{label} fica no computador</div>
        Por segurança, configurações que alteram o que o JARVIS pode fazer (pastas, aplicativos, modelos, instalação de ferramentas) só podem ser feitas no aplicativo do próprio PC. Pelo site você conversa, acompanha tarefas, aprova ações de risco médio e vê o estado do computador.
      </div>
    </div>
  );
}
