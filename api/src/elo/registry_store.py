"""Local persistence for the patient registry (SQLite). The file stays on the machine, never in a model call."""

from __future__ import annotations

import json
import sqlite3

from .privacy import PatientRegistry


class PersistentRegistry(PatientRegistry):
    def __init__(self, path: str = ":memory:") -> None:
        super().__init__()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.executescript(
            "CREATE TABLE IF NOT EXISTS people (pseudonym TEXT PRIMARY KEY, role TEXT, full_name TEXT, aliases TEXT);"
            "CREATE TABLE IF NOT EXISTS allowed (term TEXT PRIMARY KEY);"
        )
        for pseudonym, role, full_name, aliases in self._db.execute("SELECT pseudonym, role, full_name, aliases FROM people"):
            super().add(role, full_name, pseudonym, tuple(json.loads(aliases)))
        for (term,) in self._db.execute("SELECT term FROM allowed"):
            super().allow(term)

    def add(self, role, full_name, pseudonym, aliases=()):
        person = super().add(role, full_name, pseudonym, aliases)
        self._db.execute("INSERT INTO people VALUES (?,?,?,?)", (pseudonym, role, full_name, json.dumps(list(aliases))))
        self._db.commit()
        return person

    def allow(self, term: str) -> None:
        super().allow(term)
        self._db.execute("INSERT OR IGNORE INTO allowed VALUES (?)", (term.strip(),))
        self._db.commit()

    def pseudonyms(self) -> list[dict]:
        return [{"pseudonym": p.pseudonym, "role": p.role} for p in self._people]
