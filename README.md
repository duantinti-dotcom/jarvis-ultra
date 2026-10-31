# JARVIS ULTRA

Assistente pessoal de IA **local** para Windows, com site (Vercel) para acesso pelo celular.

| Parte | Onde | O que faz |
|---|---|---|
| `services/jarvis-core` | PC (Node 22) | Cérebro: roteador de modelos (Ollama), intenção/plano/execução/verificação, ferramentas, memória, LAB, voz, relay |
| `apps/web` | PC e Vercel | Interface única (Next.js estático). No PC fala com o core local; no site, com o PC pelo relay |
| `apps/desktop` | Windows | App Tauri 2: embarca `node.exe` + core + interface, bandeja com parada de emergência |
| `supabase/` | Nuvem | Relay seguro (vinculação, fila de comandos, revogação) com testes SQL |
| `packages/contracts` | todos | Tipos e validação compartilhados |

## Instalar no Windows
1. Baixe o instalador em **Actions → Windows installer → artefato** (ou Releases).
2. Instale o Ollama: `winget install Ollama.Ollama`
3. Baixe um modelo: `ollama pull qwen3:4b-instruct-2507-q4_K_M` (e opcionalmente `nomic-embed-text`)
4. Abra **JARVIS ULTRA**. A pasta `Documentos\JARVIS` é a única liberada por padrão (Central de Segurança para mais).

Se o core não iniciar, o log completo fica em `%LOCALAPPDATA%\JarvisUltra\logs\core-crash.log`.

## Desenvolvimento
```bash
pnpm install
pnpm --filter @jarvis/core dev        # core em http://127.0.0.1:7821
pnpm --filter @jarvis/core test       # 54 testes (segurança, ferramentas, memória, LAB, relay, API)
JARVIS_LLM_TESTS=1 pnpm --filter @jarvis/core test:llm   # cenários com modelo real (Ollama)
pnpm --filter @jarvis/core bench      # benchmark real do modelo local
```

## Segurança (resumo)
- Core escuta só em `127.0.0.1`, com token, proteção contra DNS rebinding e CORS restrito.
- Toda ferramenta passa pelo motor de permissões (pastas/apps autorizados, escopos por origem, aprovação para risco médio/alto, parada de emergência).
- Conteúdo de sites/documentos é tratado como dado não confiável (proteção contra prompt injection); nenhuma ferramenta altera permissões.
- Código gerado no LAB roda em processo isolado (Permission Model do Node), só é instalado após aprovação, com hash e rollback.
- Relay: só comandos de lista fechada, segredo do dispositivo ilegível pelo navegador, entrega única, expiração e revogação imediata.
