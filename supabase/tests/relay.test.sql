-- Testes do relay: cada bloco falha com exceção se a regra não for respeitada.
\set ON_ERROR_STOP on
insert into auth.users values ('11111111-1111-1111-1111-111111111111', 'dono@x.com'), ('22222222-2222-2222-2222-222222222222', 'intruso@x.com');

-- 1. Dono gera código; dispositivo (anon) vincula.
set role authenticated; select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
create temp table t_code as select (public.jarvis_create_pairing_code()->>'code') as code;
grant select on t_code to anon;
reset role;
set role anon; select set_config('request.jwt.claim.sub', '', false);
create temp table t_dev as select public.jarvis_claim_pairing((select code from t_code), 'PC-Teste', 'win32-x64') as r;
grant select on t_dev to authenticated;
do $$ begin
  begin perform public.jarvis_claim_pairing((select code from t_code), 'Outro', 'x'); raise exception 'FALHA: código reutilizado';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
end $$;
reset role;

-- 2. anon não lê tabelas diretamente.
set role anon;
do $$ begin
  begin
    if (select count(*) from public.jarvis_devices) + (select count(*) from public.jarvis_device_secrets) <> 0 then raise exception 'FALHA: anon leu devices'; end if;
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 3. Segredo errado é rejeitado; certo sincroniza e recebe comandos.
set role anon;
do $$ declare d uuid := ((select r from t_dev)->>'device_id')::uuid; begin
  begin perform public.jarvis_device_sync(d, 'errado', '{}', '[]', '[]'); raise exception 'FALHA: segredo errado aceito';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
end $$;
reset role;

set role authenticated; select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
insert into public.jarvis_relay_commands (device_id, payload) values (((select r from t_dev)->>'device_id')::uuid, '{"kind":"status.get"}');
do $$ begin
  begin insert into public.jarvis_relay_commands (device_id, payload) values (((select r from t_dev)->>'device_id')::uuid, '{"kind":"shell","cmd":"del *"}'); raise exception 'FALHA: comando fora da lista aceito';
  exception when check_violation then null; end;
end $$;
do $$ begin
  if (select count(*) from public.jarvis_device_secrets) <> 0 then raise exception 'FALHA: segredo legível pelo navegador'; end if;

end $$;
reset role;

-- intruso não vê nem comanda o dispositivo do dono
set role authenticated; select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
do $$ begin
  if (select count(*) from public.jarvis_devices) <> 0 then raise exception 'FALHA: intruso vê dispositivo'; end if;
  if (select count(*) from public.jarvis_relay_commands) <> 0 then raise exception 'FALHA: intruso vê comandos'; end if;
  begin insert into public.jarvis_relay_commands (device_id, payload) values (((select r from t_dev)->>'device_id')::uuid, '{"kind":"status.get"}'); raise exception 'FALHA: intruso comandou';
  exception when insufficient_privilege then null; when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  begin perform public.jarvis_revoke_device(((select r from t_dev)->>'device_id')::uuid); raise exception 'FALHA: intruso revogou';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
end $$;
reset role;

set role anon;
do $$ declare d uuid := ((select r from t_dev)->>'device_id')::uuid; s text := (select r from t_dev)->>'device_secret'; res json; id uuid; begin
  res := public.jarvis_device_sync(d, s, '{"hostname":"pc"}', '[{"type":"agent.state","state":"idle"}]', '[]');
  if json_array_length(res->'commands') <> 1 then raise exception 'FALHA: comando não entregue %', res; end if;
  id := (res->'commands'->0->>'id')::uuid;
  res := public.jarvis_device_sync(d, s, '{}', '[]', '[]');
  if json_array_length(res->'commands') <> 0 then raise exception 'FALHA: comando entregue duas vezes'; end if;
  res := public.jarvis_device_sync(d, s, '{}', '[]', json_build_array(json_build_object('id', id, 'status', 'done', 'result', json_build_object('ok', true)))::jsonb);
end $$;
reset role;

set role authenticated; select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
do $$ begin
  if (select status from public.jarvis_relay_commands limit 1) <> 'done' then raise exception 'FALHA: resultado não registrado'; end if;
  if (select count(*) from public.jarvis_relay_events) <> 1 then raise exception 'FALHA: evento não visível ao dono'; end if;
  if (select last_seen_at from public.jarvis_devices limit 1) is null then raise exception 'FALHA: heartbeat ausente'; end if;
end $$;
-- 4. Revogação: novos comandos não são aceitos e o PC é avisado.
select public.jarvis_revoke_device(((select r from t_dev)->>'device_id')::uuid);
do $$ begin
  begin insert into public.jarvis_relay_commands (device_id, payload) values (((select r from t_dev)->>'device_id')::uuid, '{"kind":"status.get"}'); raise exception 'FALHA: comando aceito após revogação';
  exception when insufficient_privilege then null; when others then if sqlerrm like 'FALHA%' then raise; end if; end;
end $$;
reset role;
set role anon;
do $$ declare res json; begin
  res := public.jarvis_device_sync(((select r from t_dev)->>'device_id')::uuid, (select r from t_dev)->>'device_secret', '{}', '[]', '[]');
  if (res->>'revoked')::boolean is not true then raise exception 'FALHA: PC não soube da revogação'; end if;
end $$;
reset role;
select 'RELAY SQL: TODOS OS TESTES PASSARAM' as resultado;
