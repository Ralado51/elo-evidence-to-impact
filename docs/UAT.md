# Roteiro de teste de aceite (UAT) da plataforma

Dados 100% sintéticos. Preencha as colunas **Resultado** (OK / Falhou / Bloqueado) e **Obs.** Cada falha: anote o ID do caso e o que apareceu na tela.
Perfis: **T** = terapeuta, **P** = participante. Login da terapeuta: `terapeuta_demo` / `senha-sintetica-demo`.

## Preparação
1. No WSL, na raiz do repositório: `scripts/demo_up.sh` (veja o topo do script). Para criar o caso pronto, antes: `export ELO_PLAYWRIGHT_DIR="$HOME/hackathons/elo-platform/workspace/tools/playwright"`.
2. Anote o `participant_id` e o `invite_token` impressos. O convite vale 1 hora; gere outro pelo fluxo UAT-14 se expirar.
3. Para parar: `scripts/demo_up.sh down`.

## Casos
| ID | Perfil | Passos | Resultado esperado | Resultado | Obs. |
|---|---|---|---|---|---|
| UAT-01 | Visitante | Abrir `/`. Alternar Português/English. Clicar nos 3 cartões de demonstração. | Textos trocam de idioma. Os 3 links abrem as telas. Aviso de dados sintéticos visível. | | |
| UAT-02 | T | `/v3/painel.html`: entrar com senha errada, depois com a certa. | Senha errada: mensagem de erro, sem acesso. Senha certa: tela de escolher pessoa. | | |
| UAT-03 | T | Abrir `/v3/painel.html?participant=<id>` (ou colar o id). | Resumo com indicadores, gráfico de evolução (ajuda total → sem ajuda), lista de transições, lista de sessões e linha do tempo. | | |
| UAT-04 | T | Seção Verificador: tocar "fiel". | Resultado "aceito", com o texto e as limitações. | | |
| UAT-05 | T | Seção Verificador: tocar "exagerado". | Resultado "bloqueado" com explicação em português (`RECOMPUTE_MISMATCH`). | | |
| UAT-06 | T | Navegar pelo menu do painel só com o teclado (Tab, Enter). | Ordem lógica, foco sempre visível, nada fora de alcance. | | |
| UAT-07 | P | `/v3/participant.html`: colar um convite inválido. | Erro claro em português, sem entrar. | | |
| UAT-08 | P | Colar o convite válido. | Entra, o plano e as metas aparecem sozinhos, passo 3 fica em destaque. | | |
| UAT-09 | P | Passo 3: Iniciar sessão, depois Concluir. | Botões Concluir/Parar só ativos durante a prática. Passo 4 passa a destaque. | | |
| UAT-10 | P | Iniciar e tocar "Parar por dor" (repetir com "Parar por cansaço"). | Sessão encerra na hora e segue para o relato. | | |
| UAT-11 | P | Passo 4: tentar enviar sem responder; responder só uma pergunta; responder as duas e enviar. | Enviar fica desativado até as duas respostas. Depois: "Relato registrado com sucesso". | | |
| UAT-12 | P | Passo 5: colar `summary_id` e `evolution_id` do caso demo; depois um código inexistente. | Resumo e evolução aparecem; código inexistente dá erro claro. | | |
| UAT-13 | P | Em tela estreita (320 px) e com zoom 200%. | Sem rolagem lateral, textos legíveis, botões tocáveis. | | |
| UAT-14 | T | Fluxo completo em `/v3/therapist.html`: criar pessoa, avaliação, meta, prescrição, convite, aprovar fatos após a sessão do P, publicar resumo. | Cada etapa confirma sucesso; a pessoa nova aparece no painel (UAT-03). | | |
| UAT-15 | P (S2, prévia fora do aceite S1) | `/s2/contador.html`: "Ver demonstração", esperar 15 s, "Parar". | Contagem sobe (~5 em 15 s), tabela de repetições aparece. | | |
| UAT-16 | P (S2, prévia fora do aceite S1) | Contador com **câmera real** (precisa de `web/s2/vendor/`, veja HANDOFF_DEMO). Abrir e fechar a mão 10 vezes, calibrar uma vez. | Conta perto de 10. Só o esqueleto aparece, nenhuma imagem. Câmera desliga em "Parar". | | |
| UAT-17 | Todos | Procurar dado real em qualquer tela. | Nenhum. Selo "[Dados sintéticos]" presente. | | |
| UAT-18 | Dev | `node --test web/tests/*.test.mjs`, `node web/test_counter.js`, `node web/tests/browser/run.mjs` | Tudo passa. | | |

## Critério de aceite
Todos os casos OK, exceto UAT-16 se não houver câmera ou pasta `vendor/` (registrar como Bloqueado e gravar o vídeo só com a demonstração).
