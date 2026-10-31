-- Bucket público das imagens geradas pelo Jarvis (upload só pela Edge Function).
insert into storage.buckets (id, name, public) values ('jarvis-images', 'jarvis-images', true) on conflict (id) do nothing;
