-- Chat na nuvem (site funciona sem o PC). Escrita só pela Edge Function jarvis-ai (service role).
create table public.jarvis_cloud_conversations (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Nova conversa',
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jarvis_cloud_conversations_owner on public.jarvis_cloud_conversations(owner, updated_at desc);
create table public.jarvis_cloud_messages (
  id uuid primary key default gen_random_uuid(),
  seq bigserial,
  conversation_id uuid not null references public.jarvis_cloud_conversations(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  metrics jsonb,
  created_at timestamptz not null default now()
);
create index jarvis_cloud_messages_conv on public.jarvis_cloud_messages(conversation_id, seq);
create table public.jarvis_ai_usage (id bigserial primary key, owner uuid not null references auth.users(id) on delete cascade, created_at timestamptz not null default now(), tokens int);
create index jarvis_ai_usage_owner on public.jarvis_ai_usage(owner, created_at);
alter table public.jarvis_cloud_conversations enable row level security;
alter table public.jarvis_cloud_messages enable row level security;
alter table public.jarvis_ai_usage enable row level security;
create policy jarvis_cc_select on public.jarvis_cloud_conversations for select to authenticated using (owner = auth.uid());
create policy jarvis_cc_update on public.jarvis_cloud_conversations for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy jarvis_cc_delete on public.jarvis_cloud_conversations for delete to authenticated using (owner = auth.uid());
create policy jarvis_cm_select on public.jarvis_cloud_messages for select to authenticated using (owner = auth.uid());
create policy jarvis_cm_delete on public.jarvis_cloud_messages for delete to authenticated using (owner = auth.uid());
