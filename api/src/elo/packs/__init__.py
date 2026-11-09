"""Discipline packs: vocabulary and cues per discipline (occupational therapy first)."""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel

from ..contract import Assistance, Environment, SourceType


class ActivityDef(BaseModel):
    label: dict[str, str]
    keywords: list[str]


class Pack(BaseModel):
    name: str
    discipline: str
    activities: dict[str, ActivityDef]
    assistance_cues: dict[Assistance, list[str]]
    independence_cues: list[str]
    independence_not_before: list[str]
    negation_words: list[str]
    environment_cues: dict[Environment, list[str]]
    report_cues: dict[SourceType, list[str]]


def load_pack(name: str = "ot_pediatric") -> Pack:
    path = Path(__file__).parent / f"{name}.json"
    return Pack.model_validate(json.loads(path.read_text(encoding="utf-8")))
