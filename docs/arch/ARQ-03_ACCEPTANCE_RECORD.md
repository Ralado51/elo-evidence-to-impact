# ARQ-03 — Registro formal de aceite e congelamento do A2

Data: 26/11/2026. Decisões do PO (mensagem "GATE ARQ-03 — ACCEPTED / ARQ-04 — RELEASED"). Dados exclusivamente sintéticos.

## 1. Revisão aceita
`2cf4babe516bc806ff89f87d28ae3f3ac608e730` (ARQ-03 + FIX-01). Evidência independente: **Gemini** 4/4 cenários dirigidos e regressões aprovadas; **Codex** 10/10 cenários funcionais aprovados. (Os relatórios dos revisores são os informados pelo PO; não foram anexados a este repositório.)

## 2. Decisões formalizadas
| # | Decisão | Resultado |
|---|---|---|
| 1 | `goal.count_ceiling` | **Ratificado**, reutilizando `OUT_OF_RANGE`; limite derivado do catálogo versionado `goal-target-rules.v1`; sem código de erro nem propriedade novos |
| 2 | Vetores V-G14 e V-G15 | **Ratificados** (`session_count` 100001 e `repetitions` 100001 → `goal.count_ceiling`) |
| 3 | Ressalva P-07 | **Aceita**: compatibilidade preservada em leitura histórica e replay idempotente pré-A2; **sem garantia de retrocompatibilidade integral em escrita** (clientes com schema estrito `additionalProperties:false` rejeitam `deadline`; metas e avaliações legadas só passam a ser revalidadas ao gerar nova versão, P-08) |
| 4 | FIX-38, FIX-39, FIX-40, FIX-17/D01 | **Aceitos nos escopos homologados** (limite superior; quatro estados do item; descrição de meta vazia; texto PT/EN da parada). Não equivalem a validação integral de outras superfícies |
| 5 | Decisões clínicas pendentes | **Preservadas**: matriz tipo/unidade/instrumento (limites e status de validação clínica), R6 dormante, `measure_value` oculto na UI, dose conforme `limits-v1`. Nenhuma regra clínica nova foi criada |
| 6 | Congelamento do pacote `CL06_3-A2` 3.2.0 | **Executado** (§4) |

Regras de interface mantidas **fora** do contrato: `goal.text_required`, `item.observed_requires_value`.

## 3. Verificações antes do congelamento
| Verificação | Resultado |
|---|---|
| `sha256sum -c contracts/CL06_3-A2/INTEGRITY_MANIFEST.sha256` | 0 divergências (9 arquivos) |
| `test_frozen_packages_untouched` (r1 3.0.0, A1 3.1.0) | íntegros |
| `scripts/sync_catalogs.py --check` | catálogos web em paridade com o pacote |
| `test_rules_registry_adds_no_error_codes`, `test_vectors_reference_registered_rules` | verdes |
| Python `test_v3_a2_package` + `test_v3_a2_domain_rules` | 43 passam |
| JS `node --test web/tests/*.test.mjs` | 113 passam |
| Suíte completa e navegador na revisão aceita | resultados do FIX-01 (Python 524 + 1 pulado + 1 falha externa preexistente `test_cl06_1_streams_fixtures_exact_parity`; navegador 20 suítes verdes, cada uma isolada) |

## 4. Auditoria dos commits documentais posteriores
Comando: `git diff --name-only 2cf4bab b1d21fc | grep -v '^docs/'` → **vazio**. Os commits posteriores (`67bc619` ratificação FIX-01, planejamento ARQ-04/05, `b1d21fc` status) alteram **somente `docs/arch/`**: nenhuma alteração funcional, de teste ou contratual não homologada. (A única exceção é o próprio commit de encerramento abaixo, que altera metadados do pacote A2 e um teste de integridade, ambos descritos aqui.)

## 5. Congelamento do A2 (alterações do commit de encerramento)
- `contracts/CL06_3-A2/contracts/VERSIONS.json`: `status` passa de "CANDIDATE … NOT frozen" para "FROZEN by PO on 2026-11-26, accepted revision 2cf4bab…; not declared fully backward-compatible for writes"; acrescentado `base_manifest_sha256` = SHA-256 de `contracts/CL06_3-A1/INTEGRITY_MANIFEST.sha256` (`e9e19aae…9e46`), no padrão do A1. Nenhum outro campo (versões de contrato, catálogos) alterado.
- `docs/AMENDMENT_A2_DOMAIN_VALIDATION.md`: cabeçalho "FROZEN", texto de compatibilidade (P-07) e nota de ratificação.
- `INTEGRITY_MANIFEST.sha256` regenerado (SHA-256 do manifesto: `49eb8b25…12d9`). Conteúdo normativo (catálogos, vetores, schema, registros) **inalterado** em relação à revisão aceita.
- `api/tests/test_v3_a2_package.py`: `test_frozen_packages_untouched` passa a verificar também o A2; o teste de versões exige `FROZEN`, a ressalva P-07 e o `base_manifest_sha256`.

Daqui em diante qualquer alteração em `contracts/CL06_3-A2/` exige novo adendo (A3) com ratificação do PO; o teste de integridade falha caso contrário.

## 6. Histórico contratual
| Pacote | Versão | Estado |
|---|---|---|
| CL06_3-r1 | 3.0.0 | congelado |
| CL06_3-A1 (idempotência) | 3.1.0 | congelado |
| **CL06_3-A2 (validação de domínio)** | **3.2.0** | **congelado em 26/11/2026** (revisão aceita `2cf4bab`) |
