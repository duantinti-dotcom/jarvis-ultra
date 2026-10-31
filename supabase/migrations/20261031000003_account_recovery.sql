-- Recuperação de conta sem e-mail: código de recuperação (hash bcrypt), uso único,
-- 5 tentativas e bloqueio de 30 minutos; limite global de 30 cadastros/hora.
-- (Mesmo conteúdo aplicado no projeto via migrações jarvis_account_recovery e jarvis_new_recovery_code.)
create table public.jarvis_account_recovery (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code_hash text not null,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.jarvis_account_recovery enable row level security;
create table public.jarvis_signup_log (id bigserial primary key, created_at timestamptz not null default now());
alter table public.jarvis_signup_log enable row level security;
-- Funções: jarvis_register (devolve recovery_code), jarvis_reset_password, jarvis_new_recovery_code.
-- Corpo completo idêntico ao aplicado; ver histórico do projeto Supabase (list_migrations).
