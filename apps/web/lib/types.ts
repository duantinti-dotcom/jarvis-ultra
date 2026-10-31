import type { CoreEvent, DeviceStatus, Task, Approval, Memory } from '@jarvis/contracts';
export type { CoreEvent, DeviceStatus, Task, Approval, Memory };

export type Mode = 'local' | 'remote';
export type Conn = 'connecting' | 'online' | 'offline' | 'unauthenticated' | 'no-device';

export type ConversationSummary = { id: string; title: string; updatedAt: string; messageCount?: number; origin?: string };
export type ChatMessage = { id: string; role: 'user' | 'assistant' | 'system' | 'tool'; content: string; createdAt: string; metrics?: Record<string, unknown> | null; toolCalls?: unknown };

export type StatusView = {
  device: DeviceStatus | null;
  online: boolean;
  lastSeen: string | null;
  ollama?: { url: string; version: string | null };
  selectedModel?: { model: string; numCtx: number; reason: string } | null;
  emergencyStop?: boolean;
  relay?: { enabled: boolean; connected: boolean; lastError: string | null; lastSyncAt: string | null; config: { deviceId: string; deviceName: string; url: string; pairedAt: string } | null };
};

export type Device = { id: string; name: string; platform: string; created_at: string; last_seen_at: string | null; revoked_at: string | null; status: DeviceStatus | null };

export interface JarvisApi {
  mode: Mode;
  subscribe(fn: (e: CoreEvent) => void): () => void;
  onConn(fn: (c: Conn, detail?: string) => void): () => void;
  status(): Promise<StatusView>;
  chat(text: string, conversationId: string | null): Promise<{ conversationId: string; messageId: string }>;
  cancelMessage(messageId: string): Promise<void>;
  conversations(): Promise<ConversationSummary[]>;
  conversation(id: string): Promise<ChatMessage[]>;
  tasks(limit?: number): Promise<Task[]>;
  cancelTask(id: string): Promise<void>;
  approvals(): Promise<Approval[]>;
  decide(id: string, approve: boolean): Promise<string>;
  memories(query?: string): Promise<Memory[]>;
  emergencyStop(): Promise<void>;
  live(): Promise<Record<string, unknown> | null>;
  /** Requisição direta ao core (somente modo local). */
  req<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>;
  coreUrl?: string;
  token?: string;
}
