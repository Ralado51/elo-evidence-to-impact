// Elo v3 accessibility static & unit tests (Node built-ins only; zero external deps).
// Run: node --test web/tests/*.test.mjs  (signals pass/fail strictly via process exit code).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LIVE_REGION_ID, announce, getLiveRegion } from "../v3/a11y.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const V3_DIR = path.join(REPO_ROOT, "web", "v3");
const TOKENS_JSON = JSON.parse(fs.readFileSync(path.join(V3_DIR, "tokens.json"), "utf8"));
const TOKENS_CSS = fs.readFileSync(path.join(V3_DIR, "tokens.css"), "utf8");
const BASE_CSS = fs.readFileSync(path.join(V3_DIR, "base.css"), "utf8");
const INDEX_HTML = fs.readFileSync(path.join(V3_DIR, "index.html"), "utf8");
const A11Y_MJS = fs.readFileSync(path.join(V3_DIR, "a11y.mjs"), "utf8");

// --- WCAG 2.x sRGB relative luminance & contrast math ------------------------------------

function parseOpaqueHex(hex) {
  assert.equal(typeof hex, "string", `Expected hex colour string, got ${typeof hex}`);
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  assert.ok(m, `Colour token must be opaque 6-digit hex (no alpha): ${hex}`);
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function srgbChannelToLinear(c255) {
  const s = c255 / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const [r, g, b] = parseOpaqueHex(hex);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

function contrastRatio(fgHex, bgHex) {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// --- Lightweight CSS parser (no external deps) -------------------------------------------

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseDeclarations(blockBody) {
  const decls = [];
  for (const raw of blockBody.split(";")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    decls.push({
      prop: trimmed.slice(0, idx).trim().toLowerCase(),
      value: trimmed.slice(idx + 1).trim(),
    });
  }
  return decls;
}

function parseTopLevelCss(css) {
  const clean = stripCssComments(css);
  const rules = [];
  const mediaBlocks = [];
  let i = 0;
  const n = clean.length;

  function readBlock(startIdx) {
    let depth = 0;
    let j = startIdx;
    while (j < n) {
      if (clean[j] === "{") depth++;
      else if (clean[j] === "}") {
        depth--;
        if (depth === 0) return j;
      }
      j++;
    }
    return n;
  }

  while (i < n) {
    while (i < n && /\s/.test(clean[i])) i++;
    if (i >= n) break;
    const brace = clean.indexOf("{", i);
    if (brace === -1) break;
    const prelude = clean.slice(i, brace).trim();
    const end = readBlock(brace);
    const body = clean.slice(brace + 1, end).trim();
    if (prelude.startsWith("@media")) {
      const inner = parseTopLevelCss(body);
      mediaBlocks.push({ query: prelude, rules: inner.rules });
    } else if (!prelude.startsWith("@")) {
      const selectors = prelude.split(",").map((s) => s.trim()).filter(Boolean);
      rules.push({ selectors, decls: parseDeclarations(body) });
    }
    i = end + 1;
  }
  return { rules, mediaBlocks };
}

function resolveVar(val, tokens) {
  return val.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/g, (_, name) => {
    assert.ok(name in tokens, `Undefined CSS custom property referenced: ${name}`);
    return tokens[name];
  });
}

function toPx(val, tokens) {
  const resolved = resolveVar(val, tokens).replace(/!important/g, "").trim();
  const mRem = /^(-?[0-9]*\.?[0-9]+)rem$/i.exec(resolved);
  if (mRem) return parseFloat(mRem[1]) * 16;
  const mPx = /^(-?[0-9]*\.?[0-9]+)px$/i.exec(resolved);
  if (mPx) return parseFloat(mPx[1]);
  return null;
}

// --- Row 1: Single token source (tokens.json <-> tokens.css bidirectional equality) ------

test("Row 1: tokens.css custom properties match tokens.json bidirectionally", () => {
  const parsed = parseTopLevelCss(TOKENS_CSS);
  const rootRules = parsed.rules.filter((r) => r.selectors.includes(":root"));
  assert.ok(rootRules.length >= 1, "tokens.css must define a :root block");

  const cssTokens = {};
  for (const r of rootRules) {
    for (const d of r.decls) {
      if (d.prop.startsWith("--")) {
        assert.ok(!(d.prop in cssTokens), `Duplicate CSS token ${d.prop}`);
        cssTokens[d.prop] = d.value;
      }
    }
  }
  assert.deepEqual(cssTokens, TOKENS_JSON.tokens);
});

// --- Row 2: Text and large-text contrast + large-text CSS usage --------------------------

test("Row 2: text pairs >= 4.5:1 and large-text pairs >= 3:1 used only on large text", () => {
  const { tokens, pairs } = TOKENS_JSON;
  const textPairs = pairs.filter((p) => p.role === "text");
  const largeTextPairs = pairs.filter((p) => p.role === "large-text");
  assert.ok(textPairs.length > 0, "Expected at least one text pair");
  assert.ok(largeTextPairs.length > 0, "Expected at least one large-text pair");

  for (const pair of textPairs) {
    const ratio = contrastRatio(tokens[pair.foreground], tokens[pair.background]);
    assert.ok(
      ratio >= 4.5,
      `Text pair ${pair.foreground} on ${pair.background} ratio ${ratio.toFixed(2)} < 4.5`,
    );
  }

  const largeOnlyFgTokens = new Set(
    largeTextPairs
      .map((p) => p.foreground)
      .filter((fg) => !textPairs.some((tp) => tp.foreground === fg)),
  );
  for (const pair of largeTextPairs) {
    const ratio = contrastRatio(tokens[pair.foreground], tokens[pair.background]);
    assert.ok(
      ratio >= 3.0,
      `Large-text pair ${pair.foreground} on ${pair.background} ratio ${ratio.toFixed(2)} < 3.0`,
    );
  }

  // Verify every CSS rule using a large-text-only foreground token sets >= 1.5rem or >= 1.1875rem bold
  const parsed = parseTopLevelCss(BASE_CSS);
  for (const rule of parsed.rules) {
    const colorDecl = rule.decls.find((d) => d.prop === "color");
    if (!colorDecl) continue;
    const m = /var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/.exec(colorDecl.value);
    if (!m || !largeOnlyFgTokens.has(m[1])) continue;
    const fsDecl = rule.decls.find((d) => d.prop === "font-size");
    assert.ok(fsDecl, `Rule ${rule.selectors.join(",")} using large-text token ${m[1]} must set font-size`);
    const px = toPx(fsDecl.value, tokens);
    const fwDecl = rule.decls.find((d) => d.prop === "font-weight");
    const isBold = fwDecl && (fwDecl.value === "bold" || parseInt(fwDecl.value, 10) >= 700);
    const okLarge = px !== null && (px >= 24 || (isBold && px >= 19));
    assert.ok(
      okLarge,
      `Rule ${rule.selectors.join(",")} uses large-text token ${m[1]} on text below large threshold (${px}px, bold=${Boolean(isBold)})`,
    );
  }
});

// --- Row 3: UI and focus contrast (>= 3:1; focus >= 3:1 against EVERY background) --------

test("Row 3: UI pairs >= 3:1 and focus token >= 3:1 against every background token", () => {
  const { tokens, pairs, backgrounds, focusToken } = TOKENS_JSON;
  assert.ok(focusToken && focusToken in tokens, "focusToken must exist in tokens");

  // Every --elo-bg-* token must be listed in backgrounds
  const allBgTokens = Object.keys(tokens).filter((k) => k.startsWith("--elo-bg-"));
  assert.deepEqual([...backgrounds].sort(), [...allBgTokens].sort());

  const uiPairs = pairs.filter((p) => p.role === "ui");
  assert.ok(uiPairs.length > 0, "Expected at least one ui pair");
  for (const pair of uiPairs) {
    const ratio = contrastRatio(tokens[pair.foreground], tokens[pair.background]);
    assert.ok(
      ratio >= 3.0,
      `UI pair ${pair.foreground} on ${pair.background} ratio ${ratio.toFixed(2)} < 3.0`,
    );
  }

  for (const bgToken of allBgTokens) {
    const ratio = contrastRatio(tokens[focusToken], tokens[bgToken]);
    assert.ok(
      ratio >= 3.0,
      `Focus token ${focusToken} against ${bgToken} ratio ${ratio.toFixed(2)} < 3.0`,
    );
    assert.ok(
      pairs.some((p) => p.role === "focus" && p.foreground === focusToken && p.background === bgToken),
      `Missing declared focus pair for ${focusToken} on ${bgToken}`,
    );
  }
});

// --- Row 4: Pairs derived from base.css are completely declared in tokens.json -----------

test("Row 4: every colour/border pair used in base.css is declared in tokens.json", () => {
  const declared = new Set(TOKENS_JSON.pairs.map((p) => `${p.foreground}|${p.background}`));
  const parsed = parseTopLevelCss(BASE_CSS);
  const derivedPairs = [];

  for (const rule of parsed.rules) {
    const bgDecl = rule.decls.find((d) => d.prop === "background-color");
    const bgVar = bgDecl ? (/var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/.exec(bgDecl.value)?.[1] ?? null) : "--elo-bg-page";

    for (const d of rule.decls) {
      if (d.prop === "color") {
        const fgVar = /var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/.exec(d.value)?.[1];
        assert.ok(fgVar, `Raw non-token color in ${rule.selectors.join(",")}: ${d.value}`);
        derivedPairs.push({ fg: fgVar, bg: bgVar, context: `${rule.selectors.join(",")} color` });
      }
      if (["border", "border-top", "border-bottom", "border-left", "border-right", "border-color"].includes(d.prop)) {
        if (d.value === "0" || d.value === "none") continue;
        const borderVars = [...d.value.matchAll(/var\(\s*(--elo-color-[a-zA-Z0-9_-]+)\s*\)/g)].map((m) => m[1]);
        for (const bVar of borderVars) {
          derivedPairs.push({ fg: bVar, bg: bgVar, context: `${rule.selectors.join(",")} ${d.prop}` });
        }
      }
    }
  }

  assert.ok(derivedPairs.length > 0, "Expected derived pairs from base.css");
  for (const { fg, bg, context } of derivedPairs) {
    assert.ok(
      declared.has(`${fg}|${bg}`),
      `Undeclared pair (${fg}, ${bg}) derived from CSS (${context})`,
    );
  }
});

// --- Row 5: Target size >= 3rem (48x48 CSS px) -------------------------------------------

test("Row 5: interactive selectors have min-height and min-width >= 3rem (48px)", () => {
  const parsed = parseTopLevelCss(BASE_CSS);
  const requiredSelectors = [
    "button",
    "a.button",
    'input:not([type="hidden"])',
    "select",
    "textarea",
    '[role="button"]',
    'label:has(input[type="checkbox"])',
    'label:has(input[type="radio"])',
    ".target",
  ];

  for (const sel of requiredSelectors) {
    let minH = null;
    let minW = null;
    for (const rule of parsed.rules) {
      if (rule.selectors.includes(sel)) {
        for (const d of rule.decls) {
          if (d.prop === "min-height") minH = toPx(d.value, TOKENS_JSON.tokens);
          if (d.prop === "min-width") minW = toPx(d.value, TOKENS_JSON.tokens);
        }
      }
    }
    assert.ok(minH !== null && minH >= 48, `Selector ${sel} min-height ${minH}px < 48px (3rem)`);
    assert.ok(minW !== null && minW >= 48, `Selector ${sel} min-width ${minW}px < 48px (3rem)`);
  }
});

// --- Row 6: Visible focus >= 3px solid with offset; zero outline:none/0 ------------------

test("Row 6: visible :focus-visible outline >= 3px solid with offset and no outline suppression", () => {
  for (const [name, css] of [["tokens.css", TOKENS_CSS], ["base.css", BASE_CSS]]) {
    const clean = stripCssComments(css);
    assert.doesNotMatch(clean, /outline\s*:\s*(none|0(\b|px|rem|em))/i, `${name} must not suppress outline`);
  }

  const parsed = parseTopLevelCss(BASE_CSS);
  const fv = parsed.rules.find((r) => r.selectors.includes(":focus-visible"));
  assert.ok(fv, "base.css must define :focus-visible");
  const outlineDecl = fv.decls.find((d) => d.prop === "outline");
  const offsetDecl = fv.decls.find((d) => d.prop === "outline-offset");
  assert.ok(outlineDecl, ":focus-visible must set outline");
  assert.ok(offsetDecl, ":focus-visible must set outline-offset");

  assert.ok(
    outlineDecl.value.includes(`var(${TOKENS_JSON.focusToken})`),
    ":focus-visible outline must reference the focus token",
  );
  const resolvedOutline = resolveVar(outlineDecl.value, TOKENS_JSON.tokens);
  assert.match(resolvedOutline, /\bsolid\b/i, ":focus-visible outline must be solid");
  const widthToken = resolvedOutline.split(/\s+/)[0];
  const widthPx = toPx(widthToken, TOKENS_JSON.tokens);
  assert.ok(widthPx !== null && widthPx >= 3, `:focus-visible outline width ${widthPx}px < 3px`);

  const offsetPx = toPx(offsetDecl.value, TOKENS_JSON.tokens);
  assert.ok(offsetPx !== null && offsetPx > 0, `:focus-visible outline-offset must be > 0`);
});

// --- Row 7: Reduced motion ---------------------------------------------------------------

test("Row 7: prefers-reduced-motion neutralises animation, transition, and scroll-behavior", () => {
  const parsed = parseTopLevelCss(BASE_CSS);
  const rm = parsed.mediaBlocks.find((m) => /prefers-reduced-motion\s*:\s*reduce/i.test(m.query));
  assert.ok(rm, "base.css must include @media (prefers-reduced-motion: reduce)");

  const targetRule = rm.rules.find(
    (r) => r.selectors.includes("*") && r.selectors.includes("*::before") && r.selectors.includes("*::after"),
  );
  assert.ok(targetRule, "Reduced motion must target *, *::before, *::after");

  const getVal = (prop) => targetRule.decls.find((d) => d.prop === prop)?.value.replace(/!important/g, "").trim();
  const parseMs = (v) => {
    const m = /^([0-9]*\.?[0-9]+)(ms|s)$/i.exec(v || "");
    if (!m) return null;
    return m[2].toLowerCase() === "s" ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
  };
  const animMs = parseMs(getVal("animation-duration"));
  const transMs = parseMs(getVal("transition-duration"));
  assert.ok(animMs !== null && animMs <= 0.01, `animation-duration ${animMs}ms > 0.01ms`);
  assert.ok(transMs !== null && transMs <= 0.01, `transition-duration ${transMs}ms > 0.01ms`);
  assert.equal(getVal("scroll-behavior"), "auto");
});

// --- Row 8: Zoom-friendly units, containers, and viewport meta ---------------------------

test("Row 8: zoom-friendly rem font sizes, no wide fixed containers, unlocked viewport", () => {
  for (const [name, css] of [["tokens.css", TOKENS_CSS], ["base.css", BASE_CSS]]) {
    const parsed = parseTopLevelCss(css);
    for (const rule of parsed.rules) {
      for (const d of rule.decls) {
        if (d.prop === "font-size") {
          const resolved = resolveVar(d.value, TOKENS_JSON.tokens);
          assert.doesNotMatch(resolved, /\dpx\b/i, `${name} (${rule.selectors.join(",")}) uses px font-size: ${resolved}`);
        }
        if (d.prop === "width" || d.prop === "min-width") {
          const px = toPx(d.value, TOKENS_JSON.tokens);
          if (px !== null) {
            assert.ok(px <= 320, `${name} (${rule.selectors.join(",")}) sets ${d.prop}: ${d.value} (> 20rem)`);
          }
        }
      }
    }
  }

  // Root font-size not set in px
  assert.doesNotMatch(stripCssComments(TOKENS_CSS + BASE_CSS), /(html|:root)[^{]*\{[^}]*font-size\s*:\s*[^;]*px/i);

  // Viewport meta does not lock zoom
  const vpMatch = /<meta[^>]*name=["']viewport["'][^>]*>/i.exec(INDEX_HTML);
  assert.ok(vpMatch, "index.html must include a viewport meta tag");
  assert.doesNotMatch(vpMatch[0], /maximum-scale/i, "viewport meta must not set maximum-scale");
  assert.doesNotMatch(vpMatch[0], /user-scalable\s*=\s*no/i, "viewport meta must not disable user scaling");
});

// --- Row 9: Shell structure --------------------------------------------------------------

test("Row 9: shell structure (pt-BR, skip link first, landmarks, single h1, ordered headings)", () => {
  assert.match(INDEX_HTML, /<html[^>]*\blang=["']pt-BR["']/i);

  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(INDEX_HTML);
  assert.ok(bodyMatch, "index.html must have a <body>");
  const body = bodyMatch[1];

  // First focusable element is skip link to #main
  const firstFocusable = /<(a\b[^>]*href=|button\b|input\b|select\b|textarea\b)[^>]*>/i.exec(body);
  assert.ok(firstFocusable, "Expected focusable elements in body");
  assert.match(firstFocusable[0], /^<a\b[^>]*href=["']#main["']/i, `First focusable must link to #main, got ${firstFocusable[0]}`);

  assert.equal((body.match(/<main\b[^>]*\bid=["']main["'][^>]*>/gi) || []).length, 1, "Exactly one <main id='main'>");
  assert.equal((body.match(/<main\b/gi) || []).length, 1, "Exactly one <main>");
  assert.equal((body.match(/<header\b/gi) || []).length, 1, "Exactly one <header>");

  const navMatches = body.match(/<nav\b[^>]*>/gi) || [];
  assert.ok(navMatches.length >= 1, "Expected at least one <nav>");
  for (const navTag of navMatches) {
    assert.match(navTag, /\baria-label=["'][^"']+["']/i, `<nav> must have non-empty aria-label: ${navTag}`);
  }

  // Heading hierarchy: exactly one h1, never skips a level
  const headings = [...body.matchAll(/<h([1-6])\b/gi)].map((m) => parseInt(m[1], 10));
  assert.equal(headings.filter((h) => h === 1).length, 1, "Exactly one <h1>");
  assert.equal(headings[0], 1, "First heading must be <h1>");
  for (let i = 1; i < headings.length; i++) {
    assert.ok(
      headings[i] <= headings[i - 1] + 1,
      `Heading level skipped from h${headings[i - 1]} to h${headings[i]}`,
    );
  }
});

// --- Row 10: Accessible names & decorative icons -----------------------------------------

function stripVisibleText(htmlFragment) {
  const withoutHidden = htmlFragment.replace(/<([a-z0-9-]+)\b[^>]*aria-hidden=["']true["'][^>]*>[\s\S]*?<\/\1>/gi, "");
  return withoutHidden.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

test("Row 10: every control has a non-empty accessible name and decorative icons sit with visible text", () => {
  // Collect <label for="id"> text
  const labelFor = new Map();
  for (const m of INDEX_HTML.matchAll(/<label\b[^>]*\bfor=["']([^"']+)["'][^>]*>([\s\S]*?)<\/label>/gi)) {
    labelFor.set(m[1], stripVisibleText(m[2]));
  }
  // Collect id -> visible text for aria-labelledby resolution
  const textById = new Map();
  for (const m of INDEX_HTML.matchAll(/<([a-z0-9-]+)\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi)) {
    textById.set(m[2], stripVisibleText(m[3]));
  }

  // Buttons and links
  for (const tag of ["button", "a"]) {
    const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "gi");
    for (const m of INDEX_HTML.matchAll(re)) {
      const attrs = m[1];
      if (tag === "a" && !/\bhref=/i.test(attrs)) continue;
      const ariaLabel = /\baria-label=["']([^"']+)["']/i.exec(attrs)?.[1]?.trim() || "";
      const labelledBy = /\baria-labelledby=["']([^"']+)["']/i.exec(attrs)?.[1]?.trim() || "";
      const resolvedBy = labelledBy ? (textById.get(labelledBy) || "") : "";
      const innerText = stripVisibleText(m[2]);
      const name = ariaLabel || resolvedBy || innerText;
      assert.ok(name.length > 0, `<${tag}${attrs}> lacks an accessible name`);
    }
  }

  // Form controls (input, select, textarea)
  const wrappedControls = new Set();
  for (const m of INDEX_HTML.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)) {
    const lblText = stripVisibleText(m[1]);
    if (lblText.length > 0) {
      for (const ctrl of m[1].matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
        wrappedControls.add(ctrl[0]);
      }
    }
  }
  for (const m of INDEX_HTML.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const fullTag = m[0];
    const attrs = m[2];
    if (/\btype=["']hidden["']/i.test(attrs)) continue;
    const id = /\bid=["']([^"']+)["']/i.exec(attrs)?.[1];
    const ariaLabel = /\baria-label=["']([^"']+)["']/i.exec(attrs)?.[1]?.trim() || "";
    const fromFor = id ? (labelFor.get(id) || "") : "";
    const isWrapped = wrappedControls.has(fullTag);
    assert.ok(
      ariaLabel.length > 0 || fromFor.length > 0 || isWrapped,
      `Form control lacks accessible name: ${fullTag}`,
    );
  }

  // Every <img> has alt
  for (const m of INDEX_HTML.matchAll(/<img\b([^>]*)>/gi)) {
    assert.match(m[1], /\balt=["'][^"']*["']/i, `<img> missing alt: ${m[0]}`);
  }

  // Decorative icons are aria-hidden="true" and sit inside a parent with visible text (ACC02)
  const iconParentRe = /<(a|button|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let iconCount = 0;
  for (const m of INDEX_HTML.matchAll(iconParentRe)) {
    if (/class=["'][^"']*elo-icon[^"']*["']/i.test(m[2])) {
      iconCount++;
      assert.match(m[2], /<span\b[^>]*class=["'][^"']*elo-icon[^"']*["'][^>]*aria-hidden=["']true["']/i);
      assert.ok(stripVisibleText(m[2]).length > 0, `Decorative icon parent must contain visible text: ${m[0]}`);
    }
  }
  assert.ok(iconCount >= 6, `Expected labelled icon examples in shell, found ${iconCount}`);
});

// --- Row 11: Keyboard & native controls --------------------------------------------------

test("Row 11: native interactive controls, no tabindex > 0, no click handler on non-interactive elements", () => {
  assert.doesNotMatch(INDEX_HTML, /\brole=["'](button|link|checkbox|radio|textbox|combobox)["']/i);
  for (const m of INDEX_HTML.matchAll(/\btabindex=["'](-?\d+)["']/gi)) {
    assert.ok(parseInt(m[1], 10) <= 0, `Positive tabindex is forbidden: ${m[0]}`);
  }
  assert.doesNotMatch(INDEX_HTML, /\bonclick\s*=/i, "No inline onclick handlers");
  assert.doesNotMatch(A11Y_MJS, /addEventListener\(\s*["']click["']/i, "a11y.mjs must not bind click on non-interactive elements");
});

// --- Row 12: Not colour alone (status variants have icon + distinct text + colour) -------

test("Row 12: status pattern includes icon + colour + distinct text label per variant", () => {
  const items = [...INDEX_HTML.matchAll(/<li\b([^>]*data-status=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/li>/gi)];
  assert.ok(items.length >= 4, `Expected >= 4 status variants, found ${items.length}`);

  const labels = new Set();
  const variants = new Set();
  for (const m of items) {
    const attrs = m[1];
    const variant = m[2];
    const inner = m[3];
    variants.add(variant);
    assert.match(attrs, new RegExp(`elo-status--${variant}`), `Missing colour variant class for ${variant}`);
    assert.match(inner, /aria-hidden=["']true["']/i, `Status ${variant} must include an aria-hidden icon`);
    const text = stripVisibleText(inner);
    assert.ok(text.length > 0, `Status ${variant} must have visible text`);
    labels.add(text);
  }
  assert.equal(labels.size, items.length, "Each status variant must have a distinct text label");
  assert.equal(variants.size, items.length, "Each status variant must have a distinct data-status key");
});

// --- Row 13: Single live region & announce() DOM-stub unit tests -------------------------

test("Row 13: single live region in shell and announce() clears/re-sets polite and assertive messages", () => {
  const liveRegions = INDEX_HTML.match(/<[^>]+(\brole=["'](status|alert)["']|\baria-live=["'][^"']+["'])[^>]*>/gi) || [];
  assert.equal(liveRegions.length, 1, `Expected exactly 1 live region in index.html, found ${liveRegions.length}`);
  assert.match(liveRegions[0], new RegExp(`\\bid=["']${LIVE_REGION_ID}["']`));

  // Minimal DOM stub (no jsdom) tracking every write and attribute mutation
  const writes = [];
  const otherElementWrites = [];
  const attrs = new Map([
    ["role", "status"],
    ["aria-live", "polite"],
    ["aria-atomic", "true"],
  ]);
  const liveStub = {
    id: LIVE_REGION_ID,
    _text: "",
    get textContent() {
      return this._text;
    },
    set textContent(v) {
      this._text = v;
      writes.push(v);
    },
    setAttribute(k, v) {
      attrs.set(k, v);
    },
    getAttribute(k) {
      return attrs.get(k);
    },
  };
  const unrelatedStub = {
    id: "main",
    set textContent(v) {
      otherElementWrites.push(v);
    },
  };
  const docStub = {
    getElementById(id) {
      if (id === LIVE_REGION_ID) return liveStub;
      if (id === "main") return unrelatedStub;
      return null;
    },
    querySelector(sel) {
      return sel.includes("status") ? liveStub : null;
    },
  };

  assert.equal(getLiveRegion(docStub), liveStub);

  // Polite announcement
  assert.equal(announce("Relato salvo com sucesso.", { doc: docStub }), "Relato salvo com sucesso.");
  assert.equal(attrs.get("aria-live"), "polite");
  assert.equal(liveStub.textContent, "Relato salvo com sucesso.");
  assert.deepEqual(writes, ["", "Relato salvo com sucesso."]);

  // Repeated identical announcement clears first so screen readers announce it again
  announce("Relato salvo com sucesso.", { doc: docStub });
  assert.deepEqual(writes, ["", "Relato salvo com sucesso.", "", "Relato salvo com sucesso."]);

  // Assertive announcement
  announce("Sessão interrompida.", { politeness: "assertive", doc: docStub });
  assert.equal(attrs.get("aria-live"), "assertive");
  assert.equal(liveStub.textContent, "Sessão interrompida.");
  assert.deepEqual(writes.slice(-2), ["", "Sessão interrompida."]);

  // Only the live region was written to
  assert.deepEqual(otherElementWrites, []);

  // Invalid politeness rejected
  assert.throws(() => announce("Teste", { politeness: "loud", doc: docStub }), RangeError);
});

// --- Row 16: No new dependency (no package.json / lockfiles, browser built-ins only) -----

test("Row 16: no package.json or lock files and a11y.mjs uses browser built-ins only", () => {
  for (const rel of [
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "web/package.json",
    "web/package-lock.json",
    "web/v3/package.json",
  ]) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, rel)), false, `Unexpected file: ${rel}`);
  }
  assert.doesNotMatch(A11Y_MJS, /\bfrom\s+["']node:/i, "a11y.mjs must not import Node built-ins");
  assert.doesNotMatch(A11Y_MJS, /\bimport\s+.*from\s+["'][^./]/i, "a11y.mjs must not import external packages");
});
