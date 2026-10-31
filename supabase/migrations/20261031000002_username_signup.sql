-- Cadastro por usuário e senha (sem e-mail de confirmação).
-- O e-mail interno <usuario>@u.jarvisultra.app nunca recebe mensagens.
create or replace function public.jarvis_register(p_username text, p_password text) returns json
language plpgsql security definer set search_path = public, extensions, auth as $$
declare
  v_user text := lower(trim(p_username));
  v_email text;
  v_id uuid := gen_random_uuid();
begin
  if v_user !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then
    raise exception 'Usuário inválido: use 3 a 30 letras, números, ponto, hífen ou sublinhado.';
  end if;
  if char_length(coalesce(p_password, '')) < 8 then
    raise exception 'A senha precisa ter pelo menos 8 caracteres.';
  end if;
  v_email := v_user || '@u.jarvisultra.app';
  if exists (select 1 from auth.users where email = v_email) then
    raise exception 'Esse usuário já existe.';
  end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    crypt(p_password, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"],"app":"jarvis-ultra"}', json_build_object('username', v_user)::jsonb, now(), now(),
    '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
    json_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true)::jsonb, 'email', now(), now(), now());
  insert into public.jarvis_relay_audit (owner, kind) values (v_id, 'account.created');
  return json_build_object('ok', true);
end $$;

grant execute on function public.jarvis_register(text, text) to anon, authenticated;
