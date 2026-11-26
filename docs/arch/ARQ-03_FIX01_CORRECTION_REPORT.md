# ARQ-03 — FIX-01: relatório de correção

Baseline: ab0d753. Dados exclusivamente sintéticos. A2 permanece candidato (3.2.0), não congelado. ARQ-04 suspenso (somente o diagnóstico documental foi preservado). Sem push nem deploy.

## 1. Caracterização (antes) — `evidence/arq03_fix01_before.json`, sonda `arq03_fix01_probe.mjs`
- **FIX-38**: valor 100001 gerava requisição (1) e só a API recusava; o campo não recebia erro/aria/foco. O limite estava duplicado no HTML (`max="100000"`), que não é aplicado em formulário `novalidate`.
- **FIX-39**: **a hipótese null→zero foi refutada.** Com item numérico vazio e "não avaliado" desmarcado, o payload enviado e o persistido têm `value: null`, `not_assessed: false` (zero digitado persiste 0). Não há conversão silenciosa; o defeito real é que o campo vazio era interpretado como *desconhecido* sem escolha explícita.
- **FIX-40**: descrição vazia gerava requisição e erro genérico da API ("texto curto/longo"), sem erro no campo.
- **D01**: EN dizia "use the single stop button below".

## 2. Correções
- **FIX-38**: nova regra de servidor `goal.count_ceiling` (código existente `OUT_OF_RANGE`, `details={rule,path}`), limite lido de `goal-target-rules.v1.json`. O front usa o mesmo catálogo (sem constante duplicada): 100000 aceito, 100001 bloqueado antes da requisição com FieldError (`aria-invalid`, `aria-describedby`, foco). O atributo `max` passa a ser definido a partir do catálogo.
- **FIX-39**: o checkbox virou o select "Situação do valor": *Valor observado* (preenchimento obrigatório e compatível com o tipo; zero válido), *Desconhecido* (ausência explícita, `value` null, `not_assessed=false`), *Não avaliado* (`value` null, `not_assessed=true`). Valor desabilitado/limpo quando não observado. Campo vazio em "observado" é bloqueado com mensagem específica. P-05 e R1–R5 preservados; o servidor segue sem distinguir "observado vazio" de "desconhecido" (distinção só na UI).
- **FIX-40**: regra `goal.text_required` registrada em `createDomainRegistry` (ValidationRegistry) e exibida via `setFieldError`; mensagens PT/EN; limpeza ao corrigir e no reset de contexto.
- **D01**: só o texto de `pa.guide.4` (PT/EN) citando os dois botões distintos; sem mudança de regras de interrupção/sessão.

## 3. Decisões para ratificação do PO
1. Novo **rule id** `goal.count_ceiling` no A2 (sem código de erro novo, sem propriedade nova). Se preferir não estender o registro, o servidor pode voltar ao comportamento anterior (schema) e o limite fica só no front.
2. Regras de UI `goal.text_required` e `item.observed_requires_value` não existem no contrato (só front).

## 4. Resultados (depois) — `evidence/arq03_fix01_after.json`
- Python: 524 passaram, 1 pulado, 1 falha **preexistente** (`test_cl06_1_streams_fixtures_exact_parity`, fixture externa ausente).
- JS: 113/113.
- Navegador, suítes isoladas (demo reiniciada por suíte): `s1_arq03_fix01` 5/5, `s1_arq03_domain` 11/11 e as outras 17 suítes verdes.
- Teste legado alterado: apenas BR-A2-08/09 (checkbox → select), com justificativa acima; teste JS-A2-07 ajustado para `state`.

## 5. Limitações
- A verificação PT do FIX-40 no navegador é fraca (só confirma mensagem não vazia após troca); a sonda de evidência força EN, então o texto PT do D01 foi conferido direto em `i18n_pt.mjs`.
- Pendente I-01 (opções de unidade não retraduzem na troca de idioma): não tratado aqui, fora do escopo; segue no backlog do ARQ-04.

## 6. Revisão candidata
SHA e bundle: ver mensagem de entrega (`elo-arq03-fix01.bundle`).
