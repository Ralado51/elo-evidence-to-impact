// PO ratification: local retention is at most 7 days, and never longer than the tab's own sessionStorage.
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Pure: {expired, fullyConfirmed}. An expired stream with unconfirmed events is KEPT and flagged (never dropped silently). */
export function retentionState(record, now = Date.now()) {
  const first = record?.events?.[0]?.occurred_at;
  const expired = Boolean(first) && now - Date.parse(first) > RETENTION_MS;
  return { expired, fullyConfirmed: record.acknowledged === record.events.length };
}
