import { createClient, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js';
import type { RelayCommand, CoreEvent, Task, Approval, Memory, DeviceStatus } from '@jarvis/contracts';
import type { JarvisApi, Conn, StatusView, ChatMessage, ConversationSummary, Device } from './types';
import { Emitter } from './events';
import { cloudChat, cloudCancel, cloudConversations, cloudConversation, cloudTruncate, cloudDelete, cloudPin } from './cloud';

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const remoteConfigured = () => !!(SUPABASE_URL && SUPABASE_ANON);

let client: SupabaseClient | null = null;
export function supabase() {
  if (!client) client = createClient(SUPABASE_URL, SUPABASE_ANON, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'jarvis.auth' } });
  return client;
}

const ONLINE_WINDOW_MS = 20_000;
export const isOnline = (d: Pick<Device, 'last_seen_at' | 'revoked_at'> | null) => !!d && !d.revoked_at && !!d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < ONLINE_WINDOW_MS;

export async function listDevices(): Promise<Device[]> {
  const { data, error } = await supabase().from("jarvis_devices").select('id,name,platform,created_at,last_seen_at,revoked_at,status').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Device[];
}
export async function createPairingCode(): Promise<{ code: string; expires_at: string }> {
  const { data, error } = await supabase().rpc('jarvis_create_pairing_code');
  if (error) throw new Error(error.message);
  return data as { code: string; expires_at: string };
}
export async function revokeDevice(id: string) {
  const { error } = await supabase().rpc('jarvis_revoke_device', { p_device_id: id });
  if (error) throw new Error(error.message);
}
export async function renameDevice(id: string, name: string) {
  const { error } = await supabase().from("jarvis_devices").update({ name }).eq('id', id);
  if (error) throw new Error(error.message);
}

/** Envia um comando ao PC e aguarda o resultado (Realtime + polling de segurança). */
async function command<T>(deviceId: string, payload: RelayCommand, timeoutMs = 25_000): Promise<T> {
  const sb = supabase();
  const { data, error } = await sb.from("jarvis_relay_commands").insert({ device_id: deviceId, payload }).select('id').single();
  if (error) throw new Error(error.message);
  const id = (data as { id: string }).id;
  const deadline = Date.now() + timeoutMs;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let ch: RealtimeChannel | null = null;
    const finish = (row: { status: string; result: unknown }) => {
      if (done || !['done', 'failed', 'rejected', 'expired'].includes(row.status)) return;
      done = true;
      ch?.unsubscribe();
      clearInterval(poll);
      if (row.status === 'done') resolve(row.result as T);
      else reject(new Error((row.result as { error?: string })?.error ?? (row.status === 'expired' ? 'O computador não recebeu o comando a tempo.' : `Comando ${row.status}`)));
    };
    ch = sb.channel(`cmd-${id}`).on('postgres_changes', { event: 'UPDATE', schema: 'public', table: "jarvis_relay_commands", filter: `id=eq.${id}` }, (p) => finish(p.new as never)).subscribe();
    const poll = setInterval(async () => {
      if (done) return;
      if (Date.now() > deadline) {
        done = true;
        ch?.unsubscribe();
        clearInterval(poll);
        return reject(new Error('Sem resposta do computador (ele pode ter ficado offline). Nenhum resultado foi simulado.'));
      }
      const { data: row } = await sb.from("jarvis_relay_commands").select('status,result').eq('id', id).single();
      if (row) finish(row as never);
    }, 1200);
  });
}

export function createRemoteApi(deviceId: string | null): JarvisApi {
  const sb = supabase();
  const events = new Emitter<[CoreEvent]>();
  const conn = new Emitter<[Conn, string?]>();
  const approvals = new Map<string, Approval>();
  let device: Device | null = null;
  let last: Conn = 'connecting';
  let lastEventId = 0;
  const setConn = (c: Conn, d?: string) => { if (c !== last) { last = c; conn.emit(c, d); } };

  const dispatch = (row: { id: number; events: CoreEvent[] }) => {
    if (row.id <= lastEventId) return;
    lastEventId = row.id;
    for (const e of row.events ?? []) {
      if (e.type === 'approval.request') approvals.set(e.approvalId, { id: e.approvalId, taskId: null, stepId: null, tool: e.tool, args: e.args as Record<string, unknown>, risk: e.risk, reason: e.reason, origin: e.origin, state: 'pending', createdAt: new Date().toISOString(), decidedAt: null });
      if (e.type === 'approval.resolved') approvals.delete(e.approvalId);
      events.emit(e);
    }
  };

  // Eventos do PC: Realtime; polling como reserva caso o WebSocket caia.
  // Sem computador vinculado: o app abre normalmente e avisa; quando um PC for vinculado, recarrega sozinho.
  if (!deviceId) {
    setTimeout(() => setConn('no-device', 'Nenhum computador vinculado. No app do PC, abra Configurações → Dispositivos e entre com seu usuário e senha.'), 0);
    setInterval(async () => {
      const devs = await listDevices().catch(() => []);
      const d = devs.find((x) => !x.revoked_at);
      if (d) { localStorage.setItem('jarvis.device', d.id); location.reload(); }
    }, 5000);
  }
  if (deviceId) (async () => {
    const { data } = await sb.from("jarvis_relay_events").select('id').eq('device_id', deviceId).order('id', { ascending: false }).limit(1);
    lastEventId = (data?.[0] as { id: number } | undefined)?.id ?? 0;
    sb.channel(`ev-${deviceId}`).on('postgres_changes', { event: 'INSERT', schema: 'public', table: "jarvis_relay_events", filter: `device_id=eq.${deviceId}` }, (p) => dispatch(p.new as never)).subscribe();
  })();
  const refreshDevice = async () => {
    const { data } = await sb.from("jarvis_devices").select('id,name,platform,created_at,last_seen_at,revoked_at,status').eq('id', deviceId).single();
    device = (data as Device) ?? null;
    if (!device || device.revoked_at) setConn('no-device', 'Dispositivo revogado ou removido');
    else setConn(isOnline(device) ? 'online' : 'offline', isOnline(device) ? undefined : 'O computador está offline (desligado, sem internet ou com o JARVIS fechado).');
  };
  if (deviceId) {
    void refreshDevice();
    setInterval(refreshDevice, 5000);
  }
  if (deviceId) setInterval(async () => {
    const { data } = await sb.from("jarvis_relay_events").select('id,events').eq('device_id', deviceId).gt('id', lastEventId).order('id').limit(50);
    for (const r of (data ?? []) as { id: number; events: CoreEvent[] }[]) dispatch(r);
  }, 4000);

  const ensureOnline = () => {
    if (!isOnline(device)) throw new Error('O computador está offline. Ligue o PC e abra o JARVIS para executar esta ação.');
  };

  return {
    mode: 'remote',
    subscribe: (fn) => events.on(fn),
    onConn: (fn) => { fn(last); return conn.on(fn); },
    async status(): Promise<StatusView> {
      await refreshDevice();
      return { device: (device?.status as DeviceStatus) ?? null, online: isOnline(device), lastSeen: device?.last_seen_at ?? null };
    },
    async chat(text, conversationId) {
      ensureOnline();
      if (!text.trim()) throw new Error('Pelo site, envie texto (imagens só no app do computador).');
      return command(deviceId!, { kind: 'chat', text, conversationId });
    },
    async cancelMessage() {},
    async conversations() {
      if (!isOnline(device)) return [];
      return (await command<{ conversations: ConversationSummary[] }>(deviceId!, { kind: 'conversations.list' })).conversations;
    },
    async conversation(id) {
      ensureOnline();
      return (await command<{ messages: ChatMessage[] }>(deviceId!, { kind: 'conversation.get', conversationId: id })).messages;
    },
    async tasks(limit = 30) {
      if (!isOnline(device)) return [];
      return (await command<{ tasks: Task[] }>(deviceId!, { kind: 'tasks.list', limit })).tasks;
    },
    async cancelTask(taskId) {
      ensureOnline();
      await command(deviceId!, { kind: 'task.cancel', taskId });
    },
    async approvals() {
      return [...approvals.values()];
    },
    async decide(approvalId, approve) {
      ensureOnline();
      return (await command<{ state: string }>(deviceId!, { kind: 'approval.respond', approvalId, approve })).state;
    },
    async memories(query) {
      if (!isOnline(device)) return [];
      return (await command<{ memories: Memory[] }>(deviceId!, { kind: 'memory.list', query })).memories;
    },
    async emergencyStop() {
      ensureOnline();
      await command(deviceId!, { kind: 'emergency.stop' });
    },
    async live() {
      if (!isOnline(device)) return null;
      return (await command<{ live: Record<string, unknown> }>(deviceId!, { kind: 'status.get' })).live;
    },
    async req() {
      throw new Error('Disponível somente no aplicativo JARVIS do computador.');
    },
  };
}

/**
 * Site: conversa, histórico e voz pela nuvem (funciona sem o PC).
 * Recursos do computador (tarefas, confirmações, estado) usam o PC vinculado quando ele estiver online.
 */
export function createHybridApi(deviceId: string | null): JarvisApi {
  const pc = createRemoteApi(deviceId);
  const events = new Emitter<[CoreEvent]>();
  pc.subscribe((e) => events.emit(e));
  const conn = new Emitter<[Conn, string?]>();
  return {
    ...pc,
    mode: 'remote',
    cloud: true,
    pcOnConn: pc.onConn,
    subscribe: (fn) => events.on(fn),
    onConn: (fn) => { fn('online'); return conn.on(fn); },
    chat: (text, conversationId, opts) => {
      if (!text.trim()) return Promise.reject(new Error('Pelo site, envie texto (imagens anexadas só no app do PC).'));
      return cloudChat(text, conversationId, opts?.mode, (e) => events.emit(e), opts?.code, opts?.voice);
    },
    cancelMessage: async (id) => cloudCancel(id),
    conversations: cloudConversations,
    conversation: cloudConversation,
    truncate: cloudTruncate,
    deleteConversation: cloudDelete,
    pinConversation: cloudPin,
  };
}
