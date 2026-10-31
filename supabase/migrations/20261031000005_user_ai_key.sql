-- Chave pessoal do provedor de IA (ex.: Groq gratuita). Fica só no servidor:
-- RLS ativo sem políticas = o navegador nunca lê o valor; só a Edge Function (service role).
create table if not exists public.jarvis_user_ai (
  owner uuid primary key references auth.users(id) on delete cascade,
  api_key text not null check (char_length(api_key) between 20 and 300),
  provider text not null default 'groq' check (provider in ('groq', 'openai', 'openrouter')),
  updated_at timestamptz not null default now()
);
alter table public.jarvis_user_ai enable row level security;

create or replace function public.jarvis_set_ai_key(p_key text, p_provider text default 'groq') returns json
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'não autenticado'; end if;
  if coalesce(trim(p_key), '') = '' then
    delete from public.jarvis_user_ai where owner = auth.uid();
    return json_build_object('configured', false);
  end if;
  insert into public.jarvis_user_ai (owner, api_key, provider) values (auth.uid(), trim(p_key), coalesce(p_provider, 'groq'))
  on conflict (owner) do update set api_key = excluded.api_key, provider = excluded.provider, updated_at = now();
  return json_build_object('configured', true, 'provider', coalesce(p_provider, 'groq'), 'hint', right(trim(p_key), 4));
end $$;

create or replace function public.jarvis_ai_key_status() returns json
language sql security definer set search_path = public as $$
  select coalesce((select json_build_object('configured', true, 'provider', provider, 'hint', right(api_key, 4), 'updated_at', updated_at) from public.jarvis_user_ai where owner = auth.uid()), json_build_object('configured', false));
$$;

grant execute on function public.jarvis_set_ai_key(text, text) to authenticated;
grant execute on function public.jarvis_ai_key_status() to authenticated;
