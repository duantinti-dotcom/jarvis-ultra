-- JARVIS ULTRA — Relay remoto (Supabase/Postgres)
-- O relay só transporta comandos de uma lista fechada e eventos de status.
-- Nenhum conteúdo de pastas do computador é armazenado aqui.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tabelas
create table public.jarvis_devices (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  platform text not null default '',
  secret_hash text not null,
  status jsonb,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
create index jarvis_devices_owner on public.jarvis_devices(owner);

create table public.jarvis_pairing_codes (
  code text primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  device_id uuid references public.jarvis_devices(id) on delete set null
);

create table public.jarvis_relay_commands (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.jarvis_devices(id) on delete cascade,
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','delivered','done','failed','rejected','expired')),
  result jsonb,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  completed_at timestamptz,
  constraint payload_kind check (payload->>'kind' in ('chat','task.cancel','approval.respond','status.get','tasks.list','memory.list','conversations.list','conversation.get','emergency.stop')),
  constraint payload_size check (octet_length(payload::text) <= 32768)
);
create index jarvis_relay_commands_pending on public.jarvis_relay_commands(device_id, status, created_at);

create table public.jarvis_relay_events (
  id bigserial primary key,
  device_id uuid not null references public.jarvis_devices(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  events jsonb not null,
  created_at timestamptz not null default now()
);
create index jarvis_relay_events_device on public.jarvis_relay_events(device_id, id);

create table public.jarvis_relay_audit (
  id bigserial primary key,
  owner uuid references auth.users(id) on delete cascade,
  device_id uuid,
  kind text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS
-- Esta migração evita REVOKE/DELETE: o isolamento vem de RLS (sem política = sem acesso),
-- do segredo em tabela própria e de um gatilho que só deixa o navegador renomear.
alter table public.jarvis_devices enable row level security;
alter table public.jarvis_pairing_codes enable row level security;
alter table public.jarvis_relay_commands enable row level security;
alter table public.jarvis_relay_events enable row level security;
alter table public.jarvis_relay_audit enable row level security;

create policy jarvis_devices_select on public.jarvis_devices for select to authenticated using (owner = auth.uid());
create policy jarvis_devices_rename on public.jarvis_devices for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy jarvis_commands_select on public.jarvis_relay_commands for select to authenticated using (owner = auth.uid());
create policy jarvis_commands_insert on public.jarvis_relay_commands for insert to authenticated with check (
  owner = auth.uid()
  and exists (select 1 from public.jarvis_devices d where d.id = device_id and d.owner = auth.uid() and d.revoked_at is null)
);
create policy jarvis_events_select on public.jarvis_relay_events for select to authenticated using (owner = auth.uid());
create policy jarvis_audit_select on public.jarvis_relay_audit for select to authenticated using (owner = auth.uid());

-- Segredos dos dispositivos: RLS ativo e nenhuma política = ninguém lê pela API.
create table public.jarvis_device_secrets (
  device_id uuid primary key references public.jarvis_devices(id) on delete cascade,
  secret_hash text not null
);
alter table public.jarvis_device_secrets enable row level security;

-- Pelo navegador só o nome do dispositivo pode mudar.
create or replace function public.jarvis_devices_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') and (
     new.owner is distinct from old.owner or new.revoked_at is distinct from old.revoked_at or
     new.status is distinct from old.status or new.last_seen_at is distinct from old.last_seen_at or
     new.secret_hash is distinct from old.secret_hash or new.platform is distinct from old.platform or new.id is distinct from old.id) then
    raise exception 'somente o nome do dispositivo pode ser alterado';
  end if;
  return new;
end $$;
create trigger jarvis_devices_guard before update on public.jarvis_devices for each row execute function public.jarvis_devices_guard();

create or replace function public.jarvis_rate_limit() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.jarvis_relay_commands where owner = new.owner and created_at > now() - interval '1 minute') >= 60 then
    raise exception 'limite de comandos por minuto excedido';
  end if;
  return new;
end $$;
create trigger jarvis_relay_commands_rate before insert on public.jarvis_relay_commands for each row execute function public.jarvis_rate_limit();

create or replace function public.jarvis_create_pairing_code() returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_code text := '';
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_exp timestamptz := now() + interval '10 minutes';
  i int;
begin
  if auth.uid() is null then raise exception 'não autenticado'; end if;
  update public.jarvis_pairing_codes set expires_at = now() where owner = auth.uid() and used_at is null and expires_at > now();
  for i in 1..8 loop
    v_code := v_code || substr(v_alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
  end loop;
  insert into public.jarvis_pairing_codes (code, owner, expires_at) values (v_code, auth.uid(), v_exp);
  insert into public.jarvis_relay_audit (owner, kind) values (auth.uid(), 'pairing.code');
  return json_build_object('code', v_code, 'expires_at', v_exp);
end $$;

create or replace function public.jarvis_revoke_device(p_device_id uuid) returns json
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'não autenticado'; end if;
  update public.jarvis_devices set revoked_at = now() where id = p_device_id and owner = auth.uid() and revoked_at is null;
  if not found then raise exception 'dispositivo não encontrado'; end if;
  update public.jarvis_relay_commands set status = 'expired', completed_at = now() where device_id = p_device_id and status in ('pending','delivered');
  insert into public.jarvis_relay_audit (owner, device_id, kind) values (auth.uid(), p_device_id, 'device.revoke');
  return json_build_object('revoked', true);
end $$;

create or replace function public.jarvis_claim_pairing(p_code text, p_device_name text, p_platform text) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_row public.jarvis_pairing_codes;
  v_secret text := encode(gen_random_bytes(32), 'base64');
  v_device uuid;
begin
  select * into v_row from public.jarvis_pairing_codes
   where code = upper(trim(p_code)) and used_at is null and expires_at > now() for update;
  if not found then raise exception 'código inválido ou expirado'; end if;
  insert into public.jarvis_devices (owner, name, platform, secret_hash)
    values (v_row.owner, left(coalesce(nullif(trim(p_device_name), ''), 'PC'), 60), left(coalesce(p_platform, ''), 40), '-')
    returning id into v_device;
  insert into public.jarvis_device_secrets (device_id, secret_hash) values (v_device, encode(digest(v_secret, 'sha256'), 'hex'));
  update public.jarvis_pairing_codes set used_at = now(), device_id = v_device where code = v_row.code;
  insert into public.jarvis_relay_audit (owner, device_id, kind) values (v_row.owner, v_device, 'device.paired');
  return json_build_object('device_id', v_device, 'device_secret', v_secret);
end $$;

create or replace function public.jarvis_device_sync(p_device_id uuid, p_secret text, p_status jsonb, p_events jsonb, p_results jsonb) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_dev public.jarvis_devices;
  v_hash text;
  v_r jsonb;
  v_cmds json;
begin
  select * into v_dev from public.jarvis_devices where id = p_device_id;
  select secret_hash into v_hash from public.jarvis_device_secrets where device_id = p_device_id;
  if v_dev.id is null or v_hash is null or v_hash <> encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex') then
    raise exception 'invalid device credentials';
  end if;
  if v_dev.revoked_at is not null then
    return json_build_object('revoked', true, 'commands', '[]'::json, 'server_time', now());
  end if;
  if octet_length(coalesce(p_events, '[]')::text) > 524288 or octet_length(coalesce(p_status, '{}')::text) > 16384 then
    raise exception 'payload muito grande';
  end if;

  update public.jarvis_devices set last_seen_at = now(), status = p_status where id = p_device_id;

  if jsonb_typeof(p_events) = 'array' and jsonb_array_length(p_events) > 0 then
    insert into public.jarvis_relay_events (device_id, owner, events) values (p_device_id, v_dev.owner, p_events);
  end if;

  if jsonb_typeof(p_results) = 'array' then
    for v_r in select * from jsonb_array_elements(p_results) loop
      update public.jarvis_relay_commands
         set status = case when v_r->>'status' in ('done','failed','rejected') then v_r->>'status' else 'failed' end,
             result = v_r->'result', completed_at = now()
       where id = (v_r->>'id')::uuid and device_id = p_device_id and status = 'delivered';
    end loop;
  end if;

  update public.jarvis_relay_commands set status = 'expired', completed_at = now()
   where device_id = p_device_id and status = 'pending' and created_at < now() - interval '2 minutes';

  with claimed as (
    update public.jarvis_relay_commands set status = 'delivered', delivered_at = now()
     where id in (select id from public.jarvis_relay_commands where device_id = p_device_id and status = 'pending' order by created_at limit 20 for update skip locked)
     returning id, payload, created_at
  )
  select coalesce(json_agg(claimed order by created_at), '[]'::json) into v_cmds from claimed;

  return json_build_object('revoked', false, 'commands', v_cmds, 'server_time', now());
end $$;

grant execute on function public.jarvis_claim_pairing(text, text, text) to anon, authenticated;
grant execute on function public.jarvis_device_sync(uuid, text, jsonb, jsonb, jsonb) to anon, authenticated;
grant execute on function public.jarvis_create_pairing_code() to authenticated;
grant execute on function public.jarvis_revoke_device(uuid) to authenticated;

alter publication supabase_realtime add table public.jarvis_relay_commands, public.jarvis_relay_events;
