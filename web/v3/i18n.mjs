/**
 * Elo i18n engine (pt-BR default, en alternative). UI text lives only in the catalogs
 * (i18n_pt.mjs, i18n_en.mjs). Contract values (enums, ids, error codes) are never translated:
 * labels are looked up from them. User-typed text is never translated.
 */
import { PT } from "./i18n_pt.mjs";
import { EN } from "./i18n_en.mjs";

export const LANGS = Object.freeze(["pt-BR", "en"]);
export const DEFAULT_LANG = "pt-BR";
const STORAGE_KEY = "elo_lang";
const CATALOGS = { "pt-BR": PT, en: EN };

let current = DEFAULT_LANG;

export function normalizeLang(value) {
  const v = String(value || "").toLowerCase();
  if (v.startsWith("en")) return "en";
  if (v.startsWith("pt")) return "pt-BR";
  return DEFAULT_LANG;
}

export function getLang() {
  return current;
}

function readStored() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/** Interpolate {name} placeholders. Unknown placeholders are kept visible to make gaps obvious in tests. */
export function format(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m));
}

/** Translate a key. Falls back to pt-BR, then to the key itself (never silently empty). */
export function t(key, params) {
  const cat = CATALOGS[current];
  const raw = Object.prototype.hasOwnProperty.call(cat, key) ? cat[key] : Object.prototype.hasOwnProperty.call(PT, key) ? PT[key] : key;
  return params ? format(raw, params) : raw;
}

/** Label for a contract enum value, e.g. label("side", "right") -> "Direito". Unknown values show a neutral text, not the code. */
export function label(group, value) {
  const key = `enum.${group}.${value}`;
  const cat = CATALOGS[current];
  if (Object.prototype.hasOwnProperty.call(cat, key)) return cat[key];
  return t("enum.unknown");
}

export function formatDate(value, opts = { dateStyle: "medium" }) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value ?? "");
  return new Intl.DateTimeFormat(current, opts).format(d);
}

export function formatDateTime(value) {
  return formatDate(value, { dateStyle: "medium", timeStyle: "short" });
}

/** ISO calendar date (YYYY-MM-DD) shown in the language's convention, without timezone shifts. */
export function formatIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return String(iso ?? "");
  return formatDate(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
}

export function formatNumber(n, opts) {
  return new Intl.NumberFormat(current, opts).format(n);
}

/** Apply translations to static markup: data-i18n (text), data-i18n-attr="attr:key;attr:key", data-i18n-value (untouched defaults). */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.getAttribute("data-i18n"));
  }
  for (const el of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of el.getAttribute("data-i18n-attr").split(";")) {
      const [attr, key] = pair.split(":");
      if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
    }
  }
  for (const el of root.querySelectorAll("[data-i18n-value]")) {
    // Only replace a sample default the person has not edited.
    const prev = el.getAttribute("data-i18n-last") ?? "";
    const key0 = el.getAttribute("data-i18n-value");
    if (el.value === prev || el.value === "" || el.value === PT[key0] || el.value === EN[key0]) {
      const next = t(el.getAttribute("data-i18n-value"));
      el.value = next;
      el.setAttribute("data-i18n-last", next);
    }
  }
  const titleKey = document.documentElement.getAttribute("data-i18n-title");
  if (titleKey) document.title = t(titleKey);
}

function syncSelector() {
  for (const b of document.querySelectorAll("[data-lang-option]")) {
    b.setAttribute("aria-pressed", String(b.dataset.langOption === current));
  }
}

export function setLang(lang, { persist = true } = {}) {
  current = normalizeLang(lang);
  if (persist) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, current);
    } catch {
      // Storage unavailable: the choice lasts until reload.
    }
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = current === "en" ? "en" : "pt-BR";
    applyI18n();
    syncSelector();
    document.dispatchEvent(new CustomEvent("elo:lang", { detail: { lang: current } }));
  }
}

/** Create the language switch inside the page header (one per page). */
export function mountLanguageSelector(host = document.querySelector(".site-header-inner, .painel-header-inner")) {
  if (!host || host.querySelector("[data-lang-switch]")) return;
  const wrap = document.createElement("div");
  wrap.setAttribute("data-lang-switch", "");
  wrap.className = "lang-switch";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("data-i18n-attr", "aria-label:lang.group");
  for (const [code, key] of [["pt-BR", "lang.pt"], ["en", "lang.en"]]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-secondary target";
    b.dataset.langOption = code;
    b.setAttribute("lang", code === "en" ? "en" : "pt-BR");
    b.setAttribute("data-i18n", key);
    b.addEventListener("click", () => setLang(code));
    wrap.appendChild(b);
  }
  host.appendChild(wrap);
}

/**
 * Discreet application revision (commit) inside a collapsed "technical information" block, so the build under
 * homologation can be confirmed. Read from build-info.json served next to this module; silent when absent.
 */
export async function mountRevisionInfo() {
  if (typeof document === "undefined" || document.querySelector("[data-build-info]")) return;
  const box = document.createElement("details");
  box.setAttribute("data-build-info", "");
  box.className = "audit-details build-info";
  const sum = document.createElement("summary");
  sum.setAttribute("data-i18n", "tech.summary");
  const p = document.createElement("p");
  p.className = "mono";
  const info = document.createElement("span");
  info.setAttribute("data-build-commit", "");
  info.textContent = "—";
  p.append(document.createTextNode(""), info);
  const lbl = document.createElement("span");
  lbl.setAttribute("data-i18n", "tech.revision");
  p.prepend(lbl, document.createTextNode(" "));
  box.append(sum, p);
  document.body.appendChild(box);
  applyI18n(box);
  try {
    const res = await fetch(new URL("build-info.json", import.meta.url), { cache: "no-store" });
    if (res.ok) {
      const d = await res.json();
      info.textContent = `${d.commit_short || "—"}${d.dirty ? " (+local)" : ""}${d.branch ? " · " + d.branch : ""}`;
      box.dataset.commit = d.commit || "";
    }
  } catch {
    // Not served here (e.g. static review): keep the placeholder.
  }
}

/** Initialize from storage (or the browser language on first visit). Call once per page before rendering dynamic content. */
export function initI18n() {
  const stored = readStored();
  current = normalizeLang(stored || DEFAULT_LANG);
  if (typeof document !== "undefined") {
    mountLanguageSelector();
    setLang(current, { persist: Boolean(stored) });
    mountRevisionInfo();
  }
}
