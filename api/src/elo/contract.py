"""Data contract: what counts as an evidence, a claim and a verdict.

Everything here is synthetic-data tooling. No diagnosis, no prescription, no prediction.
"""

from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Environment(str, Enum):
    CLINIC = "clinic"
    HOME = "home"
    SCHOOL = "school"
    OTHER = "other"


class Assistance(str, Enum):
    """Level of assistance, ordered from most independent to most assisted."""

    INDEPENDENT = "independent"
    VERBAL_PROMPT = "verbal_prompt"
    GESTURE_PROMPT = "gesture_prompt"
    PHYSICAL_PARTIAL = "physical_partial"
    PHYSICAL_TOTAL = "physical_total"

    @property
    def rank(self) -> int:
        return list(Assistance).index(self)


class SourceType(str, Enum):
    DIRECT_OBSERVATION = "direct_observation"
    CAREGIVER_REPORT = "caregiver_report"
    PROFESSIONAL_REPORT = "professional_report"


class Verdict(str, Enum):
    SUPPORTED = "supported"
    CONTRADICTED = "contradicted"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"
    NEEDS_REVIEW = "needs_review"


class ReviewState(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    EDITED = "edited"
    REJECTED = "rejected"


class Relation(str, Enum):
    SUPPORTS = "supports"
    CONTRADICTS = "contradicts"


class Span(BaseModel):
    """Half-open character range [start, end) inside a text."""

    model_config = ConfigDict(frozen=True)

    start: int = Field(ge=0)
    end: int = Field(gt=0)

    @model_validator(mode="after")
    def _ordered(self) -> "Span":
        if self.end <= self.start:
            raise ValueError("span end must be greater than start")
        return self


class Note(BaseModel):
    """A session note. Keeps both the original text and the text the model saw."""

    id: str
    session_id: str
    version: int = Field(ge=1, default=1)
    original_text: str
    sanitized_text: str


class Observation(BaseModel):
    """A fact extracted from a note, linked to its exact source passage."""

    id: str
    note_id: str
    note_version: int = Field(ge=1)
    activity: str = Field(min_length=1)
    action: str = Field(min_length=1)
    environment: Environment
    assistance: Assistance
    observed_on: date
    source_type: SourceType
    observed_by: str | None = None
    reported_by: str | None = None
    span_original: Span
    span_sanitized: Span | None = None
    quote: str = Field(min_length=1)  # exact text in the ORIGINAL note (stays local)
    quote_sanitized: str | None = None  # exact text in the sanitized note (safe for a model)
    extracted_by: Literal["rules", "llm"] = "rules"

    @model_validator(mode="after")
    def _source_is_named(self) -> "Observation":
        if self.source_type is SourceType.DIRECT_OBSERVATION and not self.observed_by:
            raise ValueError("direct observation requires observed_by")
        if self.source_type is not SourceType.DIRECT_OBSERVATION and not self.reported_by:
            raise ValueError("a report requires reported_by")
        return self

    @property
    def is_direct(self) -> bool:
        return self.source_type is SourceType.DIRECT_OBSERVATION

    def check_against(self, note: Note) -> None:
        """Prove the span exists in the right note version and quotes the original text.

        A valid span only proves the passage exists; it does not prove the passage
        supports a claim. Semantic support is decided by the verifier.
        """
        if self.note_id != note.id or self.note_version != note.version:
            raise ValueError("observation refers to a different note or note version")
        if self.span_original.end > len(note.original_text):
            raise ValueError("span_original is outside the original text")
        if note.original_text[self.span_original.start : self.span_original.end] != self.quote:
            raise ValueError("quote does not match the original text at span_original")
        if self.span_sanitized is not None:
            if self.span_sanitized.end > len(note.sanitized_text):
                raise ValueError("span_sanitized is outside the sanitized text")
            if self.quote_sanitized is not None and (
                note.sanitized_text[self.span_sanitized.start : self.span_sanitized.end] != self.quote_sanitized
            ):
                raise ValueError("quote_sanitized does not match the sanitized text at span_sanitized")


class Claim(BaseModel):
    """A statement to verify. `as_of` anchors it to a specific day when it refers to one."""

    id: str
    session_id: str
    text: str = Field(min_length=1)
    activity: str = Field(min_length=1)
    environment: Environment
    assistance: Assistance
    as_of: date | None = None
    origin: Literal["generated", "human"] = "generated"
    review_state: ReviewState = ReviewState.PENDING


class ConstraintResult(BaseModel):
    name: Literal["activity", "environment", "assistance", "source", "time"]
    met: bool | None  # None = not evaluable
    detail: str


class EvidenceLink(BaseModel):
    claim_id: str
    observation_id: str
    relation: Relation
    rule_id: str


class VerdictResult(BaseModel):
    claim_id: str
    verdict: Verdict
    rule_id: str
    constraints: list[ConstraintResult]
    links: list[EvidenceLink] = Field(default_factory=list)
    rationale: dict[str, str]

    @model_validator(mode="after")
    def _bilingual(self) -> "VerdictResult":
        if not {"pt", "en"} <= set(self.rationale):
            raise ValueError("rationale must exist in pt and en")
        return self
