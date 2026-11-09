# Elo Evidence-to-Impact

**Evidence-first documentation for pediatric rehabilitation.**
**Documentação baseada em evidências para reabilitação infantil.**

Hack Brasil 2026 · Track: Health & well-being (Saúde & bem-estar) · **Status: in development / em desenvolvimento**

[English](#english) · [Português (Brasil)](#português-brasil)

---

## English

### The problem

AI can turn therapy notes into fluent reports, but fluency is not clinical evidence. A session observation made in a clinic must not become an unsupported claim that a child performs the same activity independently at home. Professionals need draft documentation they can inspect, correct and approve, and families deserve clear explanations of what is actually supported.

### Our approach

Elo Evidence-to-Impact is an independent prototype that turns **synthetic pediatric occupational therapy notes** into structured observations and auditable claims.

1. **Privacy Gate**: local patient registry, pseudonyms and pattern detectors; blocks on doubt.
2. **Structured extraction**: activity, action, environment, level of assistance, date and exact source passage.
3. **Evidence linking**: every statement links to its supporting observation, including who observed it or reported it.
4. **Context-Aware Evidence Verifier**: compares the constraints of a claim (environment, assistance, source of evidence, time) with those of the evidence and returns `supported`, `contradicted`, `insufficient_evidence` or `needs_review`.
5. **Human review**: a therapist approves, edits or rejects each statement, with an audit trail.
6. **Family summary**: built only from approved statements.
7. **Evidence gaps**: activity × environment (clinic, home, school) × period, showing what has not been directly observed.

> **Core principle:** *Not observed is not the same as achieved.* The software must be allowed to say "we don't know."

### Example (synthetic)

- Source: "In the clinic, the child completed the dressing task without physical assistance after verbal prompts."
- Unsupported claim: "The child dresses independently at home."
- Expected behavior: **insufficient evidence**. The source is from the clinic, not from home, and verbal prompts were required.

### Status

**Planning and early development.** Functionality, accuracy and clinical utility have **not** been validated. The example above describes target behavior, not a tested feature.

### Safety and boundaries

- **Synthetic data only** for development, demo and submission. No real patient data.
- No automatic diagnosis, treatment prescription or clinical prediction.
- Human professional approval is mandatory before documentation is finalized.
- Research prototype: not a medical device, not a production clinical record system, and not claimed to meet any regulatory or data-protection standard.
- Pseudonymization reduces risk but is not infallible anonymization.
- No proprietary instrument items or scoring schemes are reproduced.

### Technology plan

Next.js / React (bilingual UI) · Python, FastAPI, Pydantic · SQLite or PostgreSQL · pytest · optional language model through an API, with a deterministic fallback. Extensible through configurable *discipline packs* (occupational therapy first).

### Evaluation plan

A synthetic, adversarial benchmark (development and sealed evaluation split) with reported counts, denominators, confusion matrix, abstentions and false alarms. It is an engineering test, not clinical validation.

### Independence from Elo 1.0

This repository was created after the Hack Brasil 2026 opening session (2026-11-04 21:00 BRT) and contains new code only. It is related by idea to an earlier, separate prototype ("Elo 1.0") but does not reuse, import or depend on any of its code or history.

### Team

- Airton Justino de Oliveira Junior: product and engineering
- Raquel Cristina Delazari: occupational therapist, clinical domain

### Links

- Landing page: *to be added*
- Demo: *to be added*
- Video: *to be added*

### License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

---

## Português (Brasil)

### O problema

A IA transforma anotações de terapia em relatórios fluentes, mas fluência não é evidência clínica. Uma observação feita na clínica não pode virar a afirmação, sem sustentação, de que a criança realiza a mesma atividade com independência em casa. Profissionais precisam de rascunhos que possam inspecionar, corrigir e aprovar, e as famílias merecem explicações claras do que de fato está sustentado.

### Nossa abordagem

O Elo Evidence-to-Impact é um protótipo independente que transforma **notas sintéticas de terapia ocupacional pediátrica** em observações estruturadas e afirmações auditáveis.

1. **Privacy Gate**: cadastro local de pacientes, pseudônimos e detectores de padrão; bloqueia na dúvida.
2. **Extração estruturada**: atividade, ação, ambiente, nível de assistência, data e o trecho exato de origem.
3. **Vínculo de evidências**: cada afirmação aponta para a observação que a sustenta, incluindo quem observou ou relatou.
4. **Context-Aware Evidence Verifier**: compara as restrições da afirmação (ambiente, assistência, origem da evidência, tempo) com as da evidência e devolve `supported`, `contradicted`, `insufficient_evidence` ou `needs_review`.
5. **Revisão humana**: a terapeuta aprova, edita ou rejeita cada afirmação, com trilha de auditoria.
6. **Devolutiva para a família**: gerada apenas de afirmações aprovadas.
7. **Lacunas de evidência**: atividade × ambiente (clínica, casa, escola) × período, mostrando o que não foi observado diretamente.

> **Princípio central:** *não observado não é o mesmo que alcançado.* O software precisa poder dizer "não sabemos".

### Exemplo (sintético)

- Fonte: "Na clínica, a criança realizou a tarefa de vestir-se sem assistência física, após instruções verbais."
- Afirmação sem sustentação: "A criança se veste de forma independente em casa."
- Comportamento esperado: **evidência insuficiente**. A fonte é da clínica, não de casa, e houve instruções verbais.

### Estado

**Planejamento e desenvolvimento inicial.** Funcionalidade, acurácia e utilidade clínica **não foram validadas**. O exemplo acima descreve o comportamento-alvo, não um recurso testado.

### Segurança e limites

- **Somente dados sintéticos** em desenvolvimento, demonstração e submissão. Nenhum dado real de paciente.
- Sem diagnóstico, prescrição de tratamento ou previsão clínica automáticos.
- A aprovação de uma profissional é obrigatória antes de finalizar qualquer documentação.
- Protótipo de pesquisa: não é dispositivo médico, nem prontuário em produção, e não alegamos conformidade com norma regulatória ou de proteção de dados.
- Pseudonimização reduz risco, mas não é anonimização infalível.
- Nenhum item ou pontuação de instrumento proprietário é reproduzido.

### Plano de tecnologia

Next.js / React (interface bilíngue) · Python, FastAPI, Pydantic · SQLite ou PostgreSQL · pytest · modelo de linguagem opcional via API, com contingência determinística. Extensível por *discipline packs* configuráveis (terapia ocupacional primeiro).

### Plano de avaliação

Benchmark sintético adversarial (conjunto de desenvolvimento e conjunto de avaliação fechado) com contagens, denominadores, matriz de confusão, abstenções e falsos alertas. É um teste de engenharia, não validação clínica.

### Independência do Elo 1.0

Este repositório foi criado depois da sessão de abertura do Hack Brasil 2026 (04/11/2026, 21h BRT) e contém apenas código novo. Tem relação de ideia com um protótipo anterior e separado ("Elo 1.0"), mas não reutiliza, importa nem depende de nenhum código ou histórico dele.

### Equipe

- Airton Justino de Oliveira Junior: produto e engenharia
- Raquel Cristina Delazari: terapeuta ocupacional, domínio clínico

### Links

- Landing page: *a adicionar*
- Demo: *a adicionar*
- Vídeo: *a adicionar*

### Licença

Apache License 2.0. Veja [LICENSE](LICENSE) e [NOTICE](NOTICE).
