# Lume IA — reformulação: o que foi testado de verdade

Branch: `lume-redesign` (nada disso foi publicado em produção).
IA na nuvem usada nos testes: função `lume-ai` (separada da `jarvis-ai` de produção), com a chave Groq gratuita da conta.
Cada teste chamou a IA real; as respostas ficaram gravadas e foram executadas no Chromium (Playwright).

## Teste 1 — loja de roupas Aurea (catálogo, imagens, responsivo)
- Geração real: briefing (luxo minimalista, Playfair Display + Lato, paleta, 7 imagens coerentes), 5.815 tokens em 13 s; resposta cortada no admin.js → continuação automática completou.
- Verificação encontrou 4 problemas reais da IA: index.html não carregava data.js (ReferenceError), admin.html apontava para `../index.html`, painel gravava numa chave que o site não lia, erro de execução.
- 1ª correção real: corrigiu painel e chave, mas não o index.html. Causa: cota grátis de 8k tokens/min (entrada + saída) deixava pouco espaço para a resposta e o raciocínio do modelo consumia parte dele.
- Ajustes: o pedido de correção passou a listar os arquivos obrigatórios, a mandar completos só os arquivos envolvidos e a reduzir o raciocínio quando há pouco espaço. Nova correção real: adicionou data.js no index.html (5.471 caracteres, 4,6 s). O index.html veio cortado no formulário; no app, a continuação automática completa o arquivo.
- Imagens: `lume-image` gerou 686×858 em 7,2 s (proporção conferida no servidor). Não foi possível ver as imagens a partir deste ambiente.

## Teste 2 — app com login, banco de dados e painel admin (barbearia Navalha)
- 1ª geração (modelo menor, gpt-oss-20b): usava `import/export` em scripts comuns → app não rodava. Criada a verificação que acusa isso e a regra no prompt.
- 2ª geração (gpt-oss-120b, 17,7 mil caracteres, 13 s): 9 arquivos. A verificação (agora roda TODAS as páginas e preenche/envia os formulários) achou:
  dashboard.html e admin.html sem data.js, e o login do painel quebrando ao enviar (`admin.js:75 — e.target.password.value`).
- 1ª correção real: incluiu data.js; diagnosticou errado o erro do login. 2ª verificação isolou só esse erro; 2ª correção real (3 s) resolveu (`name="password"`).
- Fluxo executado no navegador, no celular (390 px): cadastro → agenda do cliente → agendamento → sair → senha errada recusada → login → painel (senha errada recusada, certa aceita) → confirmar e cancelar → cliente vê "confirmado". 0 erros JS, 0 px de estouro horizontal.
- Limitação: o "banco" é o localStorage do navegador. O dono só vê agendamentos feitos no mesmo navegador; senhas ficam em texto puro. Um backend multiusuário de verdade exige um banco por projeto (ex.: Supabase por projeto), que ainda não foi implementado.
- Visual simples; o título branco depende da imagem do topo (sem ela, fica com pouco contraste).

## Teste 3 — editar projeto existente ("deixe o cabeçalho mais bonito")
- CSS: só regras de cabeçalho/menu/logo mudaram (comparação linha a linha com o original).
- Risco real encontrado: a IA reescreveu o script.js inteiro para o efeito de rolagem e a resposta foi cortada — 7 funções do catálogo teriam sumido.
- Criada a proteção contra regressão: compara as funções de cada JS antes/depois do pedido e manda corrigir se algo sumiu (testada com os arquivos reais: acusa a reescrita, não acusa quando nada muda ou quando só se acrescenta código). Prompt: edições parciais devem criar um arquivo pequeno novo em vez de reescrever um script grande.

## Teste 4 — tarefa que não é site (conversor CSV de vendas → relatório JSON)
- Resposta real completa (7,4 s). Executada com CSV de verdade: totais por produto e por mês corretos (378,50), ticket médio, JSON baixado correto; também com quebras de linha do Windows.
- Limitação do código gerado: só CSV separado por vírgula (o padrão do Excel brasileiro, com ponto e vírgula, não funciona).

## Teste 5 — Chat e Voz
- Chat: 1,4 s no total, primeiro texto em 356 ms, Markdown com bloco de código.
- Voz: 0,75 s no total, primeiro texto em 288 ms, resposta curta, sem Markdown e sem emoji.
- Tela de voz: esfera e botões passaram para a identidade esmeralda (ainda estavam laranja). Neste ambiente a voz neural não baixa (sem acesso ao servidor do modelo), então a tela usa a voz do sistema.

## Defeitos da própria plataforma encontrados e corrigidos durante os testes
- Scripts `defer` embutidos rodavam antes do HTML (erro de `addEventListener` em null).
- DiffEditor descartava o modelo ("TextModel got disposed").
- `location.href = 'pagina.html'` dentro do preview abria o próprio Lume no iframe; agora vira troca de página do projeto.
- Verificação só rodava a página aberta; agora roda todas e testa os formulários.
- Erros apontavam a linha do documento montado; agora apontam arquivo:linha e o trecho do código.
- Falsos positivos da verificação (id `admin-login-form` lido como uso de `login`; painel comparado só com index.html).

## Limitações que continuam
- Cota grátis da Groq (8k tokens/min por modelo): respostas longas vêm em partes (a continuação automática junta). Adicionar uma chave grátis de Cerebras ou Gemini em Configurações → Inteligência aumenta muito esse limite.
- Sem terminal nem backend real para os apps gerados na versão web.
- `lume-ai`/`lume-image` estão só nesta branch; a produção continua na `jarvis-ai`.
