# ARQ-03 — Matriz de domínio

Legenda: **R** = ratificado; **I** = indefinido (depende do PO); **S** = comportamento atual (sonda).

## Metas (`goal.target`)
| kind | value | unit | obrigatório | Hoje (S) | Regra (R/I) |
|---|---|---|---|---|---|
| descriptive_text | null (proposto) | null (proposto) | texto descritivo | aceita 5 + `kg` | **I** (D-03) |
| session_count | inteiro ≥1? | null / "sessions"? | valor | aceita `kg`, 2.5, 0 (D06) | **I** (D-02) |
| repetitions | inteiro ≥1? | null / "reps"? | valor | aceita `kg`, 10.5, 5000 | **I** (D-02) |
| measure_value | número | unidade do catálogo | valor + unidade | aceita null/null e `banana` | **I** (D-04); registry só tem "1" e "deg" |
| qualquer | ≥0, ≤100000 | token `^[a-z0-9%/.-]{1,12}$` | — | negativo → 400 `OUT_OF_RANGE` | **R** (schema 3.0.0) |

## Instrumento / item
| Aspecto | Hoje | Regra |
|---|---|---|
| status de validação | declarado livremente | deve ser derivado do catálogo — **I** (D-06) |
| versão | livre (99 aceita) | derivada do catálogo — **I** |
| catálogo | só `custom_unvalidated` v0 | sem fonte clínica — **I**; não inventar |
| `value_type`↔valor/unidade | não verificado | **I** (D-08) |
| `not_assessed=true` com valor | aceito | **I** (D-08) |
| `item_key` duplicado | aceito | **I** (D-08) |

## Medição
| Caso | Regra |
|---|---|
| desconhecido nunca vira zero | **R** (RN008) |
| zero × ausente × desconhecido distintos | **R** (princípio) / representação **I** (D-04) |
| unidade×movimento (US-052) | **I** (D-07) |

## Dose
| Limite | Valor | Estado |
|---|---|---|
| séries | ≤10 | **R** (`limits-v1`), servidor aplica |
| repetições | ≤100 | **R**, servidor aplica |
| produto | ≤100 | **R**, servidor aplica; front sem guarda (UX) |
| sessions_per_week | 1..14 | contrato 3.0.0 (evento); catálogos de exercício/movimento **I** (D-09) |
