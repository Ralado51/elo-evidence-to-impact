// Design System contrast check (WCAG 2.2 AA): text >= 4.5:1 (large >= 3:1), UI components / focus >= 3:1. Pure, no deps.
const lum = (hex) => { const c = hex.replace("#", ""); const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const PAIRS = [
  // [name, fg, bg, min]
  ["text on page", "#1C1C1C", "#F6F5F1", 4.5], ["text on surface", "#1C1C1C", "#FFFFFF", 4.5],
  ["muted text on surface", "#4A4A46", "#FFFFFF", 4.5], ["muted text on page", "#4A4A46", "#F6F5F1", 4.5],
  ["text on graphite header", "#FFFFFF", "#262626", 4.5], ["muted text on graphite", "#D4D4D0", "#262626", 4.5],
  ["primary button text (ink on yellow)", "#1C1C1C", "#FFF56B", 4.5], ["yellow on graphite (accent text)", "#FFF56B", "#262626", 4.5],
  ["secondary button (ink on white)", "#1C1C1C", "#FFFFFF", 4.5], ["dark button text", "#FFFFFF", "#262626", 4.5],
  ["selected nav (ink on yellow)", "#1C1C1C", "#FFF56B", 4.5], ["yellow-soft panel text", "#1C1C1C", "#FFFBC7", 4.5],
  ["link on surface", "#1C1C1C", "#FFFFFF", 4.5],
  ["success text", "#0F5E55", "#D9EEEA", 4.5], ["error text", "#8F2A20", "#F6DEDB", 4.5], ["warning text", "#6F4504", "#F5E8CC", 4.5], ["info text", "#1F3F66", "#E3ECF7", 4.5],
  ["disabled text (informational, exempt) on surface", "#6B6B66", "#FFFFFF", 3.0],
  // non-text (>= 3:1)
  ["input border on surface", "#6B6760", "#FFFFFF", 3.0], ["input border on page", "#6B6760", "#F6F5F1", 3.0],
  ["focus ring ink on white", "#1C1C1C", "#FFFFFF", 3.0], ["focus ring ink on yellow", "#1C1C1C", "#FFF56B", 3.0], ["focus ring yellow on graphite", "#FFF56B", "#262626", 3.0],
  ["focus ring ink on page", "#1C1C1C", "#F6F5F1", 3.0],
  ["success border", "#17766B", "#FFFFFF", 3.0], ["error border", "#B4372C", "#FFFFFF", 3.0], ["warning border", "#9A6208", "#FFFFFF", 3.0], ["info border", "#3A6EA5", "#FFFFFF", 3.0],
];
if (import.meta.url === `file://${process.argv[1]}`) {
  let bad = 0;
  for (const [n, f, b, min] of PAIRS) { const r = ratio(f, b); const ok = r >= min; if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"}  ${r.toFixed(2).padStart(5)}:1  (min ${min})  ${n}  ${f} on ${b}`); }
  console.log(bad ? `\n${bad} failing pair(s)` : "\nall pairs pass"); process.exit(bad ? 1 : 0);
}
