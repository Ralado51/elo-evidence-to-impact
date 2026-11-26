// Civil dates (YYYY-MM-DD): pure, dependency-free parsing shared by the whole front (ARQ-01 / CMP-04).
// A civil date is a calendar day with no time of day and no zone; instants are a different type.
// Invalid text is reported, never normalized to another day. The BACKEND is the authority: this only mirrors the
// rule for early feedback. Vectors shared with Python: web/tests/fixtures/civil_date_vectors.json.

const CANONICAL = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** @returns {{year:number, month:number, day:number} | null} */
export function parseCivilDate(text) {
  if (typeof text !== "string") return null;
  const m = CANONICAL.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > daysInMonth) return null;
  return { year, month, day };
}

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function isCivilDate(text) {
  return parseCivilDate(text) !== null;
}

/** Comparable key for valid civil dates (ISO text compares chronologically once validated). */
export function civilDateKey(text) {
  const p = parseCivilDate(text);
  return p === null ? null : p.year * 10000 + p.month * 100 + p.day;
}

/** True only when both bounds are valid and `end` is before `start` (inclusive interval). */
export function isRangeInverted(start, end) {
  const a = civilDateKey(start);
  const b = civilDateKey(end);
  return a !== null && b !== null && b < a;
}
