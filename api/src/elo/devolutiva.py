"""Draft feedback report (.docx). It pre-fills evidence; the therapist writes every judgment.

Left blank on purpose: conclusion per goal, GAS rating, conduct and guidance to the family,
signature. The document never says a goal was achieved or rates progress.
"""

from __future__ import annotations

import io
from datetime import date

from docx import Document
from docx.shared import Pt

from .attendance import adherence
from .contract import Claim, Observation, SourceType
from .gaps import evidence_map
from .goals import Goal, check_goal, render_check
from .packs import Pack
from .summary import _ASSIST, _ENV, build_family_summary

_T = {
    "pt": {
        "title": "Devolutiva — rascunho para revisão da terapeuta",
        "synthetic": "Documento gerado a partir de dados sintéticos de demonstração. Não é um laudo.",
        "case": "Caso", "asof": "Posição em",
        "adh": "Adesão", "adh_line": "Compareceu a {a} de {o} sessões oferecidas ({pct}).",
        "adh_none": "Sem sessões registradas.", "adh_extra": "Justificadas: {j}. Não realizadas pelo serviço (fora da conta): {n}.",
        "adh_rule": "Regra: oferecidas = compareceu + faltou + falta justificada; sessões não realizadas ficam fora.",
        "reviewed": "Registros revisados pela equipe",
        "goals": "Metas e evidências", "no_goals": "Nenhuma meta cadastrada.",
        "evidence": "Evidências", "cols": ("Data", "Ambiente", "Nível de ajuda", "Fonte", "Trecho"),
        "direct": "observação direta", "caregiver": "relato do responsável", "professional": "relato de profissional",
        "none_ev": "Sem evidências para esta atividade.",
        "map": "Mapa de evidências", "mapcols": ("Atividade", "Ambiente", "Situação", "Última direta"),
        "st": {"direct": "observação direta", "report_only": "só relato", "none": "sem registro"},
        "concl": "Conclusão da terapeuta:", "gas": "Pontuação GAS (−2 a +2), da terapeuta:",
        "conduct": "Conduta e orientações à família (terapeuta)", "sign": "Assinatura e registro profissional:",
        "blank": "______________________________________________",
        "fn": "O sistema organiza evidências e lacunas. Conclusões, pontuações e condutas são da terapeuta.",
    },
    "en": {
        "title": "Feedback report — draft for therapist review",
        "synthetic": "Document generated from synthetic demonstration data. It is not a clinical report.",
        "case": "Case", "asof": "As of",
        "adh": "Attendance", "adh_line": "Attended {a} of {o} sessions offered ({pct}).",
        "adh_none": "No sessions recorded.", "adh_extra": "Excused: {j}. Not held by the service (left out): {n}.",
        "adh_rule": "Rule: offered = attended + absent + excused absence; sessions not held are excluded.",
        "reviewed": "Records reviewed by the team",
        "goals": "Goals and evidence", "no_goals": "No goals registered.",
        "evidence": "Evidence", "cols": ("Date", "Setting", "Assistance", "Source", "Excerpt"),
        "direct": "direct observation", "caregiver": "caregiver report", "professional": "professional report",
        "none_ev": "No evidence for this activity.",
        "map": "Evidence map", "mapcols": ("Activity", "Setting", "Status", "Last direct"),
        "st": {"direct": "direct observation", "report_only": "report only", "none": "no record"},
        "concl": "Therapist's conclusion:", "gas": "GAS rating (−2 to +2), by the therapist:",
        "conduct": "Conduct and guidance to the family (therapist)", "sign": "Signature and professional registration:",
        "blank": "______________________________________________",
        "fn": "The system organizes evidence and gaps. Conclusions, ratings and conduct belong to the therapist.",
    },
}
_SRC = {SourceType.DIRECT_OBSERVATION: "direct", SourceType.CAREGIVER_REPORT: "caregiver", SourceType.PROFESSIONAL_REPORT: "professional"}


def _table(doc, header, rows):
    t = doc.add_table(rows=1, cols=len(header))
    t.style = "Table Grid"
    for i, h in enumerate(header):
        t.rows[0].cells[i].text = h
        for r in t.rows[0].cells[i].paragraphs[0].runs:
            r.bold = True
    for row in rows:
        cells = t.add_row().cells
        for i, v in enumerate(row):
            cells[i].text = str(v)
    return t


def build_devolutiva(case_label: str, goals: list[Goal], observations: list[Observation], approved: list[Claim],
                     attendance: list[dict], pack: Pack, locale: str, as_of: date, stale_days: int = 14) -> bytes:
    t = _T[locale]
    doc = Document()
    doc.styles["Normal"].font.size = Pt(10.5)
    doc.add_heading(t["title"], 0)
    p = doc.add_paragraph(t["synthetic"])
    p.runs[0].italic = True
    doc.add_paragraph(f"{t['case']}: {case_label}    {t['asof']}: {as_of.isoformat()}")

    doc.add_heading(t["adh"], 1)
    a = adherence(attendance)
    if a["rate"] is None:
        doc.add_paragraph(t["adh_none"])
    else:
        doc.add_paragraph(t["adh_line"].format(a=a["attended"], o=a["offered"], pct=f"{a['rate'] * 100:.0f}%"))
        doc.add_paragraph(t["adh_extra"].format(j=a["absent_justified"], n=a["not_held"]))
    doc.add_paragraph(t["adh_rule"]).runs[0].italic = True

    doc.add_heading(t["reviewed"], 1)
    summary = build_family_summary(approved, pack, locale, case_label)
    if summary.empty_message:
        doc.add_paragraph(summary.empty_message)
    for line in summary.lines:
        doc.add_paragraph(line.text, style="List Bullet")

    doc.add_heading(t["goals"], 1)
    if not goals:
        doc.add_paragraph(t["no_goals"])
    for i, g in enumerate(goals, 1):
        chk = check_goal(g, observations, as_of, pack, stale_days)
        label = pack.activities[g.activity].label[locale]
        doc.add_heading(f"{i}. {label} — {_ENV[locale][g.environment]}", 2)
        doc.add_paragraph(g.measure)
        for line in render_check(g, chk, pack, locale).splitlines():
            doc.add_paragraph(line.removeprefix("- "), style="List Bullet")
        doc.add_paragraph(t["evidence"] + ":").runs[0].bold = True
        if chk.evidence:
            _table(doc, t["cols"], [(e.observed_on.isoformat(), _ENV[locale][e.environment], _ASSIST[locale][e.assistance],
                                     t[_SRC[e.source_type]], e.quote) for e in chk.evidence])
        else:
            doc.add_paragraph(t["none_ev"])
        doc.add_paragraph(f"{t['concl']} {t['blank']}")
        doc.add_paragraph(f"{t['gas']} ____")

    doc.add_heading(t["map"], 1)
    rows = [(pack.activities[r["activity"]].label[locale], _ENV[locale][r["environment"]], t["st"][r["status"]],
             r["last_direct"].isoformat() if r["last_direct"] else "—")
            for r in evidence_map(observations, pack, as_of)]
    _table(doc, t["mapcols"], rows)

    doc.add_heading(t["conduct"], 1)
    doc.add_paragraph(t["blank"])
    doc.add_paragraph(t["blank"])
    doc.add_paragraph(f"{t['sign']} {t['blank']}")
    doc.add_paragraph(t["fn"]).runs[0].italic = True
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
