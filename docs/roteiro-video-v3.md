# Roteiro do vídeo v3 (até 3 min, bilíngue) / Video script v3 (max 3 min, bilingual)

> Regras: até 3 min, **pt-BR + inglês**, os dois integrantes, só dados sintéticos. Nada foi gravado ainda.
> Divisão sugerida: Raquel em português (clínica); Airton em inglês (o que o sistema garante). Legendas nas duas línguas.
> Honestidade: nesta versão **não há modelo de linguagem no produto**. Os textos vêm de modelos fixos e o "rascunho exagerado" é injetado de propósito. Dizer isso em voz alta na cena 4. Não afirmar que "a IA escreve" o relatório.
> Preparação: `node web/tests/browser/seed_demo.mjs --origin http://127.0.0.1:8080` cria o caso "Caso Demonstrativo 01" (5 sessões). Entrar no painel com `terapeuta_demo` / `senha-sintetica-demo`.

| Tempo | Quem | Tela | Fala (pt-BR) | Speech (EN) |
|---|---|---|---|---|
| 0:00–0:20 | Raquel | Rosto + landing (`landing/index.html`) | "Sou terapeuta ocupacional. Entre uma sessão e outra eu não vejo o que a pessoa fez em casa. Um texto bem escrito pode preencher esse vazio com algo que ninguém viu." | Subtitle |
| 0:20–0:35 | Airton | Landing, frase central | — | "Fluent text is not evidence. Our rule: a report can only claim what the record proves." |
| 0:35–1:00 | Raquel | Tela do participante (`/v3/participant.html`): entrar com convite, plano carregado, iniciar, concluir, responder as duas perguntas | "A pessoa pratica no ritmo dela. Se sentir dor ou cansaço, para com um toque. No fim, ela só toca nas respostas, sem digitar." | Subtitle |
| 1:00–1:20 | Airton | Contador de mãos (`/v3/contador.html`): demonstração e, se testado, câmera | Legenda | "The camera counts repetitions on the device. It draws only a skeleton. No image is stored or sent. Only numbers remain." |
| 1:20–1:45 | Raquel | Painel: resumo, gráfico de evolução, lista de transições | "Aqui está a evolução em cinco sessões: de ajuda total para sem ajuda. Cada ponto aponta para o registro que o sustenta." | Subtitle |
| 1:45–2:20 | Airton | Painel, seção Verificador: botão "fiel" (aceito) e botão "exagerado" (bloqueado, RECOMPUTE_MISMATCH) | Legenda | "Now the key moment. A faithful sentence passes. We then inject an exaggerated one: 'without help' when the record shows some help. The verifier recomputes from the evidence and blocks it. In this demo texts come from fixed templates; a local language model drafting is the next step, and this same check would apply to it." |
| 2:20–2:40 | Raquel | Painel: registro de sessões e linha do tempo | "A conclusão e a conduta continuam sendo minhas. O sistema só me mostra o que dá para provar, e diz onde faltam dados." | Subtitle |
| 2:40–2:55 | Airton | Landing, seção "Como foi feito" | Legenda | "We built it with an agent factory: architect, implementer and verifier on different models. Whoever writes the code does not approve it." |
| 2:55–3:00 | Os dois | Landing + GitHub | "Dados sintéticos, sem diagnóstico, com revisão da terapeuta." | "Synthetic data only. No diagnosis. Therapist review." |

## Antes de gravar
- Subir API e gateway, rodar o `seed_demo.mjs` do zero (caso novo).
- Testar `contador.html` com câmera real e com a pasta `web/v3/vendor/` instalada. Se falhar, gravar só a demonstração sem câmera e dizer que é sinal sintético.
- Conferir que nenhuma tela mostra dado real.
- Confirmar o consentimento da Raquel para aparecer e ser citada.
- Cronometrar. Se passar de 3 min, cortar a cena 2:20–2:40.
