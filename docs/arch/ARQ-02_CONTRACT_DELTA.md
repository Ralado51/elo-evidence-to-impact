# ARQ-02 — Delta normativo proposto: idempotência de comandos (PD-02)

**Status:** PROPOSTA PARA APROVAÇÃO DO PO. Nenhum arquivo de `contracts/` foi alterado e nenhum código de ARQ-02 foi escrito.
**Base:** `ed5099356…` / `eaeaf30` · contratos CL06.3-r1 (`contracts_version 3.0.0`) · proposta de contrato do PO de 26/11/2026.

## 0. Fontes consultadas (Drive) e compatibilidade com a arquitetura aprovada
| Documento | O que condiciona este delta |
|---|---|
| ARCHITECTURE_V2 / ARCHITECTURE_FREEZE_V2 | A1 núcleo de confiança único (eventos append-only, hash, um verificador); A4 entidades declaradas com validação estrutural, autorização, autoria, auditoria e integridade; A2 contratos independentes de linguagem, evolução por pacote formal |
| CONTRACT_EVOLUTION_PLAN §1, §3 | "Nada congelado é editado em silêncio"; **permanecem idênticos à v1: canonicalização RFC 8785 (subconjunto), `event_id` determinístico, lote idempotente, hash de conteúdo na revisão** |
| PO_DECISIONS_RATIFIED PD-10 | Preservar contratos históricos; definir versionamento e compatibilidade; sem implementações normativas concorrentes |
| BUSINESS_RULES | RN004 (preservar versões), RN016 (correções rastreáveis sujeitas à retenção), RN020 (hash = integridade, não autenticidade), RN002 (acesso por vínculo) |
| ACCEPTANCE CA-BTS-01 | "reenvio idempotente e conflito detectado" |
| IMPLEMENTATION_SEQUENCE_V2 | Nenhuma fatia nova; trabalho é fundação (S0/S1) |

**Consequência de projeto:** a idempotência por chave é **aditiva e de camada de comando**. Ela **não substitui nem duplica** os mecanismos já normativos, que permanecem como estão: `event_id` determinístico + cadeia de hash (`events:batch`), `summary_id` + `content_hash` (`summaries.publish`), `(entity_id, version)` único (`ENTITY_VERSION_CONFLICT`), `CONFLICT_IMMUTABLE` (prescrições). Isso evita um segundo verificador/segunda fonte de verdade.

## 1. Mecanismos existentes (inventário para reuso)
| Mecanismo | Onde | Reuso em ARQ-02 |
|---|---|---|
| Tx `BEGIN IMMEDIATE` + `_tx_lock` (RLock), commit/rollback no store | `store.py` `insert_entity_version`, `ledger.py` `publish_summary_event`/`append` | **Reusado**: gravação do efeito + registro de idempotência no mesmo commit |
| `elo.canonical` (RFC 8785 subconjunto, `hash_canonical`) | `elo/canonical.py` | **Reusado** para o fingerprint (sem novo canonicalizador) |
| `Principal(id, org_id, role)`, `authorize(...)`, `authorize_create/authorize_revise` | `authz.py`, `clinical.py` | **Reusado** para reavaliar autorização no replay |
| `V3Error` + catálogo `error-codes.v3.json` | `errors.py` | **Estendido** com 2 códigos (§3.3) |
| PK `(entity_id, version)`, `event_id`, `summary_id`, `invite_hash`, `username` UNIQUE | `store.py`, `ledger.py` | **Preservados sem alteração** (item 11 da proposta) |

Novo: tabela `v3_command_dedup` e `CommandDedupStore` (CMP-08); **nenhuma** tabela clínica é tocada.

## 2. Semântica normativa (texto proposto)
### 2.1 Header
`Idempotency-Key: <UUID v4>` — forma canônica minúscula `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`. Um único valor por requisição (lista/duplicata ⇒ 400). **Uma chave por intenção de negócio.** O servidor nunca gera nem reescreve a chave.

### 2.2 Operações cobertas (política por operação — campo novo `idempotency` em cada endpoint do `api-contract`)
| Operação | `idempotency` | Estratégia de replay (reconstrução a partir do registro imutável) |
|---|---|---|
| participants.create | `keyed` | participante v1 (+ care_link v1) |
| care_links.revoke | `keyed` | `care_link` versão criada |
| assessments.create / .revise | `keyed` | `(entity_id, version)` |
| goals.create / .revise | `keyed` | `(entity_id, version)` |
| encounters.create, reassessments.create, instrumental.create | `keyed` | `(entity_id, version)` |
| drafts.create / .confirm / .discard | `keyed` | `(entity_id, version)` |
| prescriptions.publish | `keyed` | `{prescription_id, revision, event_id}` |
| reviews.record | `keyed` | `event_id` do `review.recorded` |
| summaries.publish | `keyed` (coexiste com idempotência natural por `summary_id`) | `{summary_id, content_hash, event_id}` |
| evolution.publish | `keyed` | `evolution_id`/`event_id` |
| events.batch | `natural` — header **aceito e ignorado** | já idempotente por `event_id` + hash chain (inalterado) |
| invites.create | `excluded` | resposta contém segredo de uso único (`invite_token`); nunca é persistida para replay. Reenvio gera outro convite (expira, sem efeito clínico) |
| auth.therapist, auth.invite | `excluded` | anônimas (sem principal) e retornam credencial |
| facts.verify | `excluded` | sem efeito persistente |
| todas as `GET` | `n/a` | header ignorado |

### 2.3 Escopo e identidade da chave
Registro único por `(org_id, principal.id, operation_id, resource_key, idempotency_key)`.
`resource_key` = identificadores do recurso-alvo vindos do path (ex.: `participant_id`, `entity_id`) ou, quando o contrato diz "path or body", do campo `participant_id` do corpo; vazio se a operação não tem recurso-alvo. A mesma chave em escopo diferente é **independente** (sem conflito, sem vazamento entre principais/organizações).

### 2.4 Fingerprint
`sha256_hex( canonicalize({ "v":1, "op": operation_id, "resource": resource_key, "body": <JSON do corpo, parseado> }) )` com `elo.canonical`. O header não entra. Qualquer diferença semântica do corpo muda o fingerprint; diferença apenas de formatação/ordem de chaves, não.

### 2.5 Ordem de avaliação (por requisição com header, em operação `keyed`)
1. Autenticação (`401 UNAUTHENTICATED`, como hoje).
2. Sintaxe do header (`400 IDEMPOTENCY_KEY_INVALID`).
3. Leitura do corpo (erros `TYPE`/`BATCH_TOO_LARGE` como hoje).
4. **Autorização completa da operação, reavaliada sobre o estado atual** (papel, vínculo ativo, organização, consentimento — exatamente a cadeia de hoje). Falha ⇒ erro normal (`403/404`); **o resultado armazenado nunca é divulgado a quem perdeu acesso**.
5. Consulta ao registro `(escopo, chave)`; registro expirado é tratado como inexistente.
   - existe e fingerprint igual ⇒ **replay** (§2.6);
   - existe e fingerprint diferente ⇒ `409 IDEMPOTENCY_KEY_REUSED`;
   - não existe ⇒ passo 6.
6. Validação de domínio e efeito, como hoje. Em sucesso, **efeito + registro de idempotência no mesmo commit** (§2.7).

### 2.6 Replay
- Status HTTP **idêntico ao original** (200/201) e corpo reconstruído do registro imutável (versões/eventos imutáveis ⇒ corpo equivalente byte a byte); header de resposta `Idempotency-Replayed: true`. Respostas originais não levam o header.
- Replay **não grava nada**, não gera novo evento/versão/auditoria e não reexecuta regras de domínio (uma regra/versão de limites alterada depois não invalida um resultado já produzido).
- Nova intenção legítima com conteúdo idêntico: **nova chave ⇒ novo efeito** (o contrato não deduplica por conteúdo).

### 2.7 Atomicidade e concorrência
- Efeito e registro de idempotência são persistidos **na mesma transação**; falha em qualquer um ⇒ rollback de ambos (retry com a mesma chave reexecuta).
- Não existe estado "em andamento" visível: o commit é o ponto de linearização. Duas requisições simultâneas com a mesma chave e mesmo corpo: uma executa, a outra recebe replay (mesmo status, header `Replayed`). Mesma chave e corpos diferentes: uma executa, a outra `409 IDEMPOTENCY_KEY_REUSED`. Chaves diferentes: ambas executam (restrições permanentes de unicidade do domínio continuam valendo e produzem seus 409 atuais).
- Arbitragem final por índice único `(org_id, principal_id, operation_id, resource_key, key)`; perdedor de corrida faz rollback e re-lê (portável a banco multi-escritor futuro, T4).
- **Somente sucessos (2xx) são registrados.** Erros 4xx/5xx não são armazenados (não deixam efeito); a mesma chave pode ser reutilizada após corrigir a causa.

### 2.8 Retenção e expiração
- `expires_at = created_at + retenção` (fixado na criação). Padrão **7 dias**, configurável (`ELO_V3_IDEMPOTENCY_RETENTION_DAYS`, inteiro 1–90; valor inválido ⇒ falha de inicialização). Mudar a configuração não altera registros existentes.
- Registro expirado é ignorado na leitura e removido por varredura oportunista. A varredura **só toca `v3_command_dedup`**; registros clínicos, eventos, entidades, resumos e ledger têm retenção própria e não são afetados.
- Efeito da expiração: após `expires_at` a mesma chave é uma **nova intenção** (um retry tardio pode duplicar). Obrigação do cliente: descartar chaves com idade ≥ retenção − margem (a CommandController usa janela de 24 h; chaves de relatos pendentes fora de `events.batch` não são previstas).

### 2.9 Dados armazenados
`v3_command_dedup(org_id, principal_id, operation_id, resource_key, idem_key, fingerprint, status_code, result_ref(JSON mínimo: ids/versão/hash), created_at, expires_at)`. **Não** armazena corpo da requisição nem da resposta (evita cópia de dado clínico com retenção diferente — RN016/LGPD).

## 3. Texto exato das mudanças em `contracts/` (somente após aprovação)
### 3.1 `contracts/api/api-contract.v3.json`
Novo bloco de topo:
```json
"idempotency": {
  "header": "Idempotency-Key",
  "format": "UUIDv4 canonical lowercase",
  "replay_response_header": "Idempotency-Replayed: true",
  "scope": ["org_id", "principal_id", "operation_id", "resource_key"],
  "fingerprint": "sha256(canonical({v:1,op,resource,body}))",
  "record_only_success": true,
  "atomic_with_effect": true,
  "retention_days_default": 7,
  "retention_days_range": [1, 90],
  "header_required": false
}
```
Em cada endpoint: `"idempotency": "keyed" | "natural" | "excluded"` (tabela §2.2) e, nos `keyed`, `errors` acrescidos de `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_REUSED`. `notes` de `events.batch` e `summaries.publish` ganham: "idempotência natural inalterada".
### 3.2 `contracts/catalogs/error-codes.v3.json`
```json
"IDEMPOTENCY_KEY_INVALID": {"http": 400, "layer": "command", "meaning": "Idempotency-Key header is not a single canonical UUID v4."},
"IDEMPOTENCY_KEY_REUSED":  {"http": 409, "layer": "command", "meaning": "Same Idempotency-Key and scope already used with a different request fingerprint."}
```
(+ `added_in_3_1: ["IDEMPOTENCY_KEY_INVALID","IDEMPOTENCY_KEY_REUSED"]`; `IDEMPOTENCY_KEY_REQUIRED` (400) só será adicionado se o PO decidir tornar o header obrigatório — Q2.)
### 3.3 `contracts/VERSIONS.json`
`"contracts_version": "3.1.0"` (mudança aditiva, minor). `api_version` permanece `v3`; `schema_version`, catálogos de fatos/eventos e `limits_version` inalterados.
### 3.4 Demais artefatos
`INTEGRITY_MANIFEST.sha256` regenerado; `docs/TRACEABILITY_P0.*` (BTS10: "Idempotency semantics need a server" → especificada e testada); novo `docs/AMENDMENT_A1_IDEMPOTENCY.md` com este texto normativo; `RELEASE_NOTE.md` com entrada 3.1.0. Os schemas de entidade/evento **não mudam**.

## 4. Compatibilidade
- Aditiva: cliente sem o header tem comportamento **idêntico ao atual** (as 420 provas atuais de API devem passar sem alteração).
- Respostas originais não mudam de formato; só replays ganham `Idempotency-Replayed`.
- Dados históricos e hashes existentes não são afetados; nenhuma migração de dados clínicos. Migração de esquema: `CREATE TABLE IF NOT EXISTS v3_command_dedup`.
- Gateway de demonstração (`scripts/gateway.mjs`): hoje repassa só `content-type` na resposta; passará a repassar `Idempotency-Replayed` (infra de demo, fora do contrato).

## 5. Implementação (após aprovação)
Backend: `api/src/elo/v3/command_dedup.py` (CMP-08), ponto único de commit em `store.py`/`ledger.py` (hook que grava o registro antes do COMMIT), dependência no router para as operações `keyed`, split `authorize_*` nas operações que ainda misturam autorização e efeito. Frontend: `web/v3/command_controller.mjs` (CMP-07): single-flight por formulário, UUID v4 por intenção via `crypto.randomUUID`, **mesma chave** em retry após falha ambígua (rede/timeout/5xx), **nova chave** a cada nova intenção, estado de resultado exclusivo (sucesso XOR erro), contexto capturado no envio (guarda contra resposta tardia, cf. ARQ-04); migrar os handlers de submit de therapist/participant/painel; um único contrato com `api_client`.
Testes (positivos e negativos): replay idêntico sem novas linhas; payload diferente ⇒ 409; N threads/mesma chave ⇒ exatamente 1 efeito; chaves diferentes/mesmo conteúdo ⇒ 2 efeitos; vínculo revogado entre original e replay ⇒ 403/404 sem corpo; expiração com relógio injetado e retenção configurável; varredura não toca tabelas clínicas; falha injetada entre efeito e registro ⇒ rollback de ambos; 4xx não registrado; escopo isolado por principal/org/operação/recurso; header inválido; `events.batch` ignora o header; unicidades existentes inalteradas; navegador: duplo clique/Enter ⇒ 1 requisição, retry de rede reutiliza chave, FIX-02/D04 reproduzido antes e corrigido depois.

## 6. Decisões que preciso que você ratifique
| # | Pergunta | Recomendação |
|---|---|---|
| Q1 | Replay reconstruído de **referências** (sem guardar corpo) | Sim — evita segunda cópia de dado clínico com retenção diferente |
| Q2 | Header **opcional** no contrato (obrigatório só no cliente próprio, via CommandController) | Opcional agora; tornar obrigatório depois por flag, com `IDEMPOTENCY_KEY_REQUIRED` |
| Q3 | Registrar **apenas 2xx** (erros não cacheados) | Sim |
| Q4 | `invites.create` fora do escopo (segredo de uso único) | Sim |
| Q5 | Forma de versionamento: **adendo A1 em CL06.3-r1 → `3.1.0`** (aditivo) versus novo pacote r2 | Adendo A1 / 3.1.0 — mudança aditiva, sem quebra |
| Q6 | Após expiração a mesma chave vira nova intenção (risco de retry tardio duplicar), mitigado por janela de 24 h no cliente | Aceitar o risco documentado |

Pendências PD-01, PD-05, PD-07 e PD-08 permanecem inalteradas e fora deste delta. ARQ-03 e S2 não foram iniciados.
