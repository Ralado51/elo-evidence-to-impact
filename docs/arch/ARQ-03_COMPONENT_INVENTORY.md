# ARQ-03 — Inventário de componentes e consumidores (AS-IS / TO-BE)

TO-BE depende das decisões D-01..D-10; nada abaixo está implementado.

| Consumidor | Campos | Validador front (AS-IS) | Validador back (AS-IS) | Campo técnico exposto | TO-BE proposto (condicionado) |
|---|---|---|---|---|---|
| Formulário de meta (`therapist.html`/`therapist_app.mjs`) | kind, value, unit | min/max do input; unidade texto livre | schema: kind enum, value 0..100000, unit token | unidade como token livre | **GoalTargetField** (CMP-06): tipo define campos aplicáveis, obrigatoriedade, tipo de valor, unidade (select de catálogo), erros por campo, serialização; servidor valida semântica (D06) |
| Formulário de avaliação | instrument id/version, validation_status, item | nenhum | schema estrutural | id, versão e status de validação como entrada livre | **InstrumentSelector**: instrumento→itens aplicáveis; versão/unidade/status derivados do catálogo (somente leitura); padrão/personalizado |
| Item de avaliação | value_type, value, unit, not_assessed, source | item fixo | schema estrutural | `category`, `unit` null, `source` fixos | **MeasurementField**: zero × ausente × desconhecido; preservar origem e versão do método; sem inferência S2/Motion |
| Medição instrumental | method/quantity/value/unit/movement | **sem UI** | schema estrutural | — | MeasurementField (somente após D-04/D-07; UI só se escopo ratificado) |
| Prescrição | séries, reps, sessions_per_week | min/max por campo; sem produto | `limits-v1` completo | — | **DoseField**: guarda de produto ≤100 derivada do mesmo catálogo; nunca ajusta silenciosamente |
| Participante (`participant_app.mjs` ~381) | exibição de meta | — | — | rótulo de unidade | consumir serialização única; sem alterar dose |

Reutilização: CMP-05 (FormController/ValidationRegistry), DateField (ARQ-01), CommandController/CommandDedupStore (ARQ-02, sem mudança). Sem novas bibliotecas.

Um dono por regra: regra semântica no servidor (`entities.py` + catálogo versionado); front mantém apenas guardas de UX derivadas do mesmo catálogo.
