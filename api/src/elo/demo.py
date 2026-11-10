"""Synthetic demo case written for this project. Every name and fact is invented."""

DEMO_CASE = {"id": "demo", "label": "Paciente A"}
DEMO_PERSON = {"role": "patient", "full_name": "Davi Demonstração", "pseudonym": "Paciente A", "aliases": ["Davi"]}

DEMO_NOTES = [
    ("2026-09-01", "Davi vestiu a camiseta na clínica com ajuda física parcial."),
    ("2026-09-08", "Davi vestiu a camiseta na clínica com dicas gestuais."),
    ("2026-09-15", "Davi vestiu a camiseta na clínica sem ajuda física, apenas com instruções verbais."),
    ("2026-09-22", "Davi usou a colher na clínica com instruções verbais."),
    ("2026-09-29", "A mãe relatou que em casa Davi vestiu a camiseta sozinho."),
    ("2026-10-06", "Davi escovou os dentes na clínica com dicas gestuais."),
    ("2026-10-13", "Davi vestiu a camiseta na clínica sozinho."),
    ("2026-10-20", "A professora relatou que na escola Davi usou o banheiro com instruções verbais."),
]

DEMO_GOALS = [
    ("dressing_upper", "home", "verbal_prompt", "Vestir a parte de cima com instruções verbais, observado em casa"),
    ("feeding", "school", "verbal_prompt", "Usar a colher com ajuda verbal no lanche, na escola"),
    ("toothbrushing", "home", "gesture_prompt", "Escovar os dentes com dicas gestuais, em casa"),
    ("dressing_lower", "clinic", "independent", "Vestir a calça sem ajuda física, na clínica"),
    ("toileting", "school", "verbal_prompt", "Usar o banheiro com instruções verbais, na escola"),
]

DEMO_ATTENDANCE = [
    ("2026-09-01", "attended"), ("2026-09-08", "attended"), ("2026-09-15", "attended"), ("2026-09-22", "attended"),
    ("2026-09-29", "absent_justified"), ("2026-10-06", "attended"), ("2026-10-13", "attended"), ("2026-10-20", "not_held"),
]
