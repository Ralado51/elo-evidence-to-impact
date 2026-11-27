# ARQ-05 — Matriz de decisões do PO

Recomendação em **negrito**. Nenhuma decisão foi tomada pelo agente. "Contrato" indica se a opção exigiria mudança normativa (nesse caso, A3/novo release; **nada disso está no caminho recomendado**).

| ID | Decisão | Opções | Recomendação e razão | Contrato |
|---|---|---|---|---|
| D-ARQ5-01 | Fonte da recuperação | (a) **local** (outbox no navegador); (b) servidor (nova rota de leitura da própria sessão); (c) ambos | **(a)**: atende FIX-14/15 e US-037/013 sem tocar contrato; (b)/(c) só se a recuperação entre dispositivos for requisito | (a) não; (b)/(c) sim |
| D-ARQ5-02 | Persistência e tecnologia | (a) `sessionStorage` (recarga); (b) **`localStorage` (recarga + fechamento)**; (c) IndexedDB | **interface assíncrona + (a) ou (b) na v1**; (b) só se D-ARQ5-04 aceitar dados de saúde no aparelho e o fechamento da aba for cenário real (exige novo convite, ver D-ARQ5-10). IndexedDB: **adiar** (sem ganho para ≈4 eventos/sessão) | não |
| D-ARQ5-03 | Nova sessão com relato pendente | (a) **bloquear até responder ou "dispensar relato" explícito**; (b) permitir e empilhar pendências; (c) permitir e descartar com aviso | **(a)**: US-031-CA03/US-037-CA04; "dispensar" é local e não gera evento (a sessão fica `ended` sem relato no servidor) | não |
| D-ARQ5-04 | Retenção e logout com pendência | (a) **perguntar: enviar / manter / descartar; manter até N dias**; (b) descartar sempre; (c) manter sempre | **(a)**, N a definir (sugestão: ≤ a retenção do servidor, 7 dias, com limpeza automática); revisão LGPD antes de dados reais | não |
| D-ARQ5-05 | Conflito (`HASH_CONFLICT`/`CHAIN_BROKEN`) | (a) **preservar, avisar, oferecer "tentar de novo" e "descartar neste aparelho"**; (b) reconstruir cadeia automaticamente | **(a)**; reconstruir mudaria hashes e violaria a imutabilidade | não |
| D-ARQ5-06 | Política de reenvio | backoff 2→60 s, N tentativas por janela, gatilho `online` + manual | **sim**, parâmetros a calibrar na Fase 0 | não |
| D-ARQ5-07 | Chaves de idempotência do terapeuta após recarga | (a) **persistir só `{slot,key,startedAt}`; intenção vira `unknown`, sem reenvio automático**; (b) persistir payload para reenvio automático; (c) rota de consulta por chave | **(a)**: (b) coloca dado clínico no navegador; (c) exige contrato. Consequência: reconciliação manual após recarga | (c) sim |
| D-ARQ5-08 | Sessão órfã (estado local perdido com sessão `active`) | (a) aceitar e sinalizar ao terapeuta; (b) **regra de expiração no servidor (a especificar no ARQ-06)**; (c) nada | **(a) agora, (b) no ARQ-06**; não mexer em `session_rules` neste pacote | (b) sim |
| D-ARQ5-09 | FIX-16 (painel × jornada) | (a) **fora do ARQ-05; decidir depois do ARQ-04**; (b) incluir | **(a)**: melhoria "a definir", depende do seletor autorizado único | não |
| D-ARQ5-10 | Participante após fechar a aba (token 1 h, convite único) | (a) **exigir novo convite** (comportamento atual; outbox permanece por escopo e é recuperado no novo login do mesmo principal); (b) renovação/refresh de token | **(a)** até a política do ARQ-06 | (b) sim |
| D-ARQ5-11 | Multi-aba | (a) **versão no registro (compare-and-set) + aviso "esta sessão está aberta em outra aba"**; (b) bloqueio por Web Locks; (c) ignorar | **(a)**; (b) como reforço se o teste mostrar corrida | não |
| D-ARQ5-12 | Texto de pendência/conflito/dispensa | PT/EN, termos para a participante | a validar com a terapeuta (linguagem clara, sem alarme) | não |
| D-ARQ5-13 | Revisão de ameaça do armazenamento local (XSS, aparelho compartilhado) | executar antes da liberação | **obrigatória** antes de dados reais | não |
| D-ARQ5-14 | Pausa/retomada na UI do participante (S-08) | (a) **fora do ARQ-05 (sem sensor)**; (b) incluir | **(a)** | não |
