"""Privacy Gate: local patient registry, pseudonyms, fail-closed detectors and offset map.

Design intent (risk mitigation, not infallible anonymization):

* The registry lives locally and is never sent to any model.
* Registered names (and name parts) are replaced by pseudonyms before any model call.
* Pattern detectors look for identifiers that were not registered (CPF, phone, e-mail,
  postal code, addresses, birth dates, titles followed by a name...). On any doubt the
  gate BLOCKS: it raises ``PrivacyBlocked`` and no text is issued for the model.
* Only ``SanitizedText`` objects issued by the gate should reach a model client.
* Known limit: an unregistered first name written without any title or pattern cannot be
  detected. That is one reason the competition uses synthetic data only.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Literal

from .contract import Span

_GATE = object()
_STOP = {"de", "da", "do", "dos", "das", "e", "di", "du", "van", "von"}


class PrivacyError(Exception):
    pass


class PrivacyBlocked(PrivacyError):
    """Raised when the text may contain identifying data. Never carries the matched text."""

    def __init__(self, findings: list["Finding"]):
        self.findings = findings
        kinds = ", ".join(sorted({f.kind for f in findings}))
        super().__init__(f"blocked by the privacy gate: {kinds}")


# --- text folding (length preserving, so offsets stay valid) --------------------------


def _fold_char(ch: str) -> str:
    d = unicodedata.normalize("NFD", ch)
    base = d[0] if d else ch
    low = base.lower()
    return low[0] if low else base


def _fold(text: str) -> str:
    return "".join(_fold_char(c) for c in text)


fold_text = _fold  # public alias: length-preserving, case and accent insensitive


# --- registry -------------------------------------------------------------------------

Role = Literal["patient", "guardian"]


@dataclass(frozen=True)
class Person:
    role: Role
    full_name: str
    pseudonym: str
    aliases: tuple[str, ...] = ()

    def phrases(self) -> list[str]:
        out = {self.full_name, *self.aliases}
        for source in (self.full_name, *self.aliases):
            for token in re.split(r"\s+", source.strip()):
                if len(token) >= 3 and _fold(token) not in _STOP:
                    out.add(token)
        return sorted((p for p in out if p.strip()), key=len, reverse=True)


class PatientRegistry:
    """Local registry (kept out of model calls). In memory here; persisted locally later."""

    def __init__(self) -> None:
        self._people: list[Person] = []
        self._allowed: set[str] = set()

    def add(self, role: Role, full_name: str, pseudonym: str, aliases: tuple[str, ...] = ()) -> Person:
        if any(p.pseudonym == pseudonym for p in self._people):
            raise ValueError("pseudonym already in use")
        person = Person(role, full_name, pseudonym, tuple(aliases))
        self._people.append(person)
        return person

    def allow(self, term: str) -> None:
        """Mark a name that is safe to appear (for example a synthetic staff name)."""
        self._allowed.add(_fold(term.strip()))

    def is_allowed(self, term: str) -> bool:
        return _fold(term.strip()) in self._allowed

    def phrases(self) -> list[tuple[str, Person]]:
        pairs = [(phrase, person) for person in self._people for phrase in person.phrases()]
        return sorted(pairs, key=lambda pp: len(pp[0]), reverse=True)

    def restore(self, text: str) -> str:
        """Local display only: swap pseudonyms back to the registered full name."""
        for person in self._people:
            text = text.replace(person.pseudonym, person.full_name)
        return text


# --- results --------------------------------------------------------------------------


@dataclass(frozen=True)
class Replacement:
    original: Span
    sanitized: Span
    role: Role
    pseudonym: str


@dataclass(frozen=True)
class Finding:
    kind: str
    span: Span  # position in the ORIGINAL text; the matched text is never stored


def _shift(pos: int, segs: list[tuple[int, int, int, int]], is_end: bool) -> int:
    delta = 0
    for s0, s1, d0, d1 in segs:
        if pos <= s0:
            break
        if pos >= s1:
            delta += (d1 - d0) - (s1 - s0)
            continue
        return d1 if is_end else d0
    return pos + delta


@dataclass(frozen=True)
class SanitizedText:
    """Text that is allowed to leave the machine. Issued only by ``PrivacyGate``."""

    text: str
    replacements: tuple[Replacement, ...]
    _issued_by: object = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self._issued_by is not _GATE:
            raise PrivacyError("SanitizedText can only be issued by PrivacyGate")

    def _segs(self, inverse: bool) -> list[tuple[int, int, int, int]]:
        rows = [(r.original.start, r.original.end, r.sanitized.start, r.sanitized.end) for r in self.replacements]
        if inverse:
            rows = [(d0, d1, s0, s1) for s0, s1, d0, d1 in rows]
        return sorted(rows)

    def to_sanitized(self, span: Span) -> Span:
        """Original coordinates -> sanitized coordinates (a partial overlap expands to the whole pseudonym)."""
        segs = self._segs(inverse=False)
        return Span(start=_shift(span.start, segs, False), end=_shift(span.end, segs, True))

    def to_original(self, span: Span) -> Span:
        """Sanitized coordinates -> original coordinates (a partial overlap expands to the whole name)."""
        segs = self._segs(inverse=True)
        return Span(start=_shift(span.start, segs, False), end=_shift(span.end, segs, True))


# --- detectors ------------------------------------------------------------------------

_CAP = r"[A-ZÀ-Ý][\wÀ-ÿ'-]+"
_DETECTORS: list[tuple[str, re.Pattern[str], bool]] = [
    # (kind, pattern, is_name_based)
    ("email", re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"), False),
    ("rg", re.compile(r"(?<!\d)\d{1,2}\.\d{3}\.\d{3}-[\dXx](?!\d)"), False),
    ("cpf", re.compile(r"(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)"), False),
    ("postal_code", re.compile(r"(?<!\d)\d{5}-\d{3}(?!\d)"), False),
    (
        "phone",
        re.compile(r"(?<![\d/])(?:\+?55[\s-]?)?\(?\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}(?![\d/])"),
        False,
    ),
    ("long_number", re.compile(r"(?<!\d)\d{8,}(?!\d)"), False),
    ("social_handle", re.compile(r"(?<![\w@])@[A-Za-z0-9_.]{2,}"), False),
    (
        "birth_date",
        re.compile(
            r"(?i)\b(?:nasc(?:ido|ida|imento)?\.?|data\s+de\s+nascimento|born(?:\s+on)?|dob)\s*:?\s*(?:em\s+|on\s+)?"
            r"\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}"
        ),
        False,
    ),
    (
        "address",
        re.compile(
            r"(?i)\b(?:rua|avenida|av\.|travessa|alameda|estrada|rodovia|street|st\.|avenue|road)\s+"
            r"[^\n,.;]{2,60}?,?\s*(?:n[ºo°.]?\s*)?\d{1,5}\b"
        ),
        False,
    ),
    (
        "title_name",
        re.compile(rf"\b(?:Sr\.?|Sra\.?|Srta\.?|Dr\.?|Dra\.?|Prof\.?|Profa\.?|Mr\.?|Mrs\.?|Ms\.?)\s+({_CAP})"),
        True,
    ),
    (
        "relative_name",
        re.compile(
            rf"\b(?:mãe|mae|pai|avó|avo|avô|tia|tio|madrasta|padrasto|responsável|"
            rf"mother|father|grandmother|grandfather|aunt|uncle|guardian)\s+(?:da\s+|do\s+|de\s+|of\s+)?({_CAP})"
        ),
        True,
    ),
]


@dataclass(frozen=True)
class Inspection:
    replacements: tuple[Replacement, ...]
    findings: tuple[Finding, ...]
    text: str

    @property
    def blocked(self) -> bool:
        return bool(self.findings)


class PrivacyGate:
    def __init__(self, registry: PatientRegistry) -> None:
        self.registry = registry

    def _match_registry(self, text: str) -> list[tuple[int, int, Person]]:
        folded = _fold(text)
        taken: list[tuple[int, int, Person]] = []
        for phrase, person in self.registry.phrases():
            f = _fold(phrase)
            pattern = r"(?<![^\W_])" + r"\s+".join(re.escape(t) for t in f.split()) + r"(?![^\W_])"
            for m in re.finditer(pattern, folded):
                a, b = m.span()
                if any(a < e and s < b for s, e, _ in taken):
                    continue
                taken.append((a, b, person))
        return sorted(taken, key=lambda t: t[0])

    def inspect(self, text: str) -> Inspection:
        matches = self._match_registry(text)

        out: list[str] = []
        reps: list[Replacement] = []
        cursor = 0
        sanitized_len = 0
        for a, b, person in matches:
            chunk = text[cursor:a]
            out.append(chunk)
            sanitized_len += len(chunk)
            out.append(person.pseudonym)
            reps.append(
                Replacement(
                    original=Span(start=a, end=b),
                    sanitized=Span(start=sanitized_len, end=sanitized_len + len(person.pseudonym)),
                    role=person.role,
                    pseudonym=person.pseudonym,
                )
            )
            sanitized_len += len(person.pseudonym)
            cursor = b
        out.append(text[cursor:])
        sanitized = "".join(out)

        findings: list[Finding] = []
        for kind, pattern, name_based in _DETECTORS:
            for m in pattern.finditer(text):
                if name_based:
                    a, b = m.span(1)
                    name = text[a:b]
                    if any(a < e and s < b for s, e, _ in matches) or self.registry.is_allowed(name):
                        continue
                    findings.append(Finding(kind, Span(start=m.start(), end=m.end())))
                else:
                    a, b = m.span()
                    if any(a < e and s < b for s, e, _ in matches):
                        continue
                    findings.append(Finding(kind, Span(start=a, end=b)))
        findings.sort(key=lambda f: f.span.start)
        return Inspection(tuple(reps), tuple(findings), sanitized)

    def process(self, text: str) -> SanitizedText:
        """Issue text for a model, or raise ``PrivacyBlocked``. Fail closed."""
        result = self.inspect(text)
        if result.blocked:
            raise PrivacyBlocked(list(result.findings))
        return SanitizedText(text=result.text, replacements=result.replacements, _issued_by=_GATE)
