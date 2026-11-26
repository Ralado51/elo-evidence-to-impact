/**
 * Elo i18n engine (pt-BR default, en alternative). UI text lives only in the catalogs
 * (i18n_pt.mjs, i18n_en.mjs). Contract values (enums, ids, error codes) are never translated:
 * labels are looked up from them. User-typed text is never translated.
 */
import { parseCivilDate } from "./civil_date.mjs";
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

/**
 * Structured, re-renderable message: a translation key plus parameters. Parameters are LITERALS by default
 * (user data such as an alias is never interpreted as a key or label). Only explicit refs are translated:
 *   lref(group, value) -> label of a contract enum value;  kref(key) -> a catalog text.
 * The message is bound to the component that shows it (see bindText) and rendered again on language change.
 */
class Ref { constructor(kind, a, b) { this.kind = kind; this.a = a; this.b = b; } render() { return this.kind === "label" ? label(this.a, this.b) : t(this.a); } }
export const lref = (group, value) => new Ref("label", group, value);
export const kref = (key) => new Ref("key", key);
export class Msg {
  constructor(key, params) { this.key = key; this.params = params; Object.freeze(this); }
  render() {
    if (!this.params) return t(this.key);
    const p = {};
    for (const [k, v] of Object.entries(this.params)) p[k] = v instanceof Ref ? v.render() : v;
    return t(this.key, p);
  }
  toString() { return this.render(); }
}
export const tm = (key, params) => new Msg(key, params);

/** Show text in a node; a Msg is remembered on the node so it can be re-rendered on language change. Plain strings stay static. */
export function bindText(node, value) {
  if (!node) return;
  node.eloMsg = value instanceof Msg ? value : null;
  node.textContent = String(value ?? "");
}

/** Re-render every node showing a bound Msg in the current language (text only; no requests, no re-announcement). */
export function retranslateMessages(root = document) {
  for (const node of root.querySelectorAll("*")) {
    if (node.eloMsg instanceof Msg) node.textContent = node.eloMsg.render();
  }
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
  const p = parseCivilDate(iso);
  // An invalid or legacy value is shown exactly as stored: it is never shifted to another real day.
  if (!p) return String(iso ?? "");
  return formatDate(new Date(Date.UTC(p.year, p.month - 1, p.day, 12)), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
}

export function formatNumber(n, opts) {
  return new Intl.NumberFormat(current, opts).format(n);
}

/** Application-managed defaults: replaced only while the person has never edited the field (explicit flag, never a content comparison). */
export function applyManagedDefaults(root = document) {
  for (const el of root.querySelectorAll("[data-i18n-value]")) {
    if (el.dataset.userEdited === "true") continue;
    el.value = t(el.getAttribute("data-i18n-value"));
  }
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
  applyManagedDefaults(root);
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
    retranslateMessages();
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
    // Explicit edit tracking: any user input on a managed default (typing, paste, delete) marks it as person-owned.
    document.addEventListener("input", (e) => {
      const el = e.target;
      if (el && el.matches && el.matches("[data-i18n-value]")) el.dataset.userEdited = "true";
    }, true);
    // A form reset restores application defaults, which are managed again (localized) afterwards.
    document.addEventListener("reset", (e) => {
      for (const el of e.target.querySelectorAll?.("[data-i18n-value]") || []) delete el.dataset.userEdited;
      queueMicrotask(() => applyManagedDefaults());
    }, true);
    mountLanguageSelector();
    setLang(current, { persist: Boolean(stored) });
    mountRevisionInfo();
  }
}
