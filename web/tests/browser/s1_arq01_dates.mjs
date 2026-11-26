// ARQ-01 DateField + backend civil-date rule, in a real browser (SYNTHETIC data). Usage: node s1_arq01_dates.mjs --origin URL
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const origin = args.origin || "http://127.0.0.1:8080";
const pwDir = process.env.ELO_PLAYWRIGHT_DIR || path.join(os.homedir(), "hackathons/elo-platform/workspace/tools/playwright");
const { chromium } = await import(pathToFileURL(path.join(pwDir, "node_modules/playwright-core/index.mjs")).href);
const browser = await chromium.launch({ headless: true });
const results = [];
const check = async (id, fn) => { try { await fn(); results.push({ id, ok: true }); } catch (e) { results.push({ id, ok: false, error: String(e.message).split("\n")[0] }); console.error("FAIL", id, String(e.message).split("\n").slice(0, 3).join(" / ")); } };

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
await ctx.addInitScript(() => { try { localStorage.setItem("elo_lang", "en"); } catch {} });
const t = await ctx.newPage();
const writes = []; // every business write the page performs
t.on("request", (r) => { if (/\/api\/v3\//.test(r.url()) && r.method() !== "GET") writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
const count = (re) => writes.filter((w) => re.test(w)).length;

// Type digits into the native date control in the BROWSER's segment order (no ISO text can be typed into it).
async function typeDate(sel, iso) {
  const digits = await t.evaluate((i) => {
    const [y, m, d] = i.split("-");
    const order = new Intl.DateTimeFormat(navigator.language).formatToParts(new Date(Date.UTC(2001, 10, 22))).filter((p) => ["year", "month", "day"].includes(p.type)).map((p) => p.type);
    return order.map((k) => ({ year: y, month: m, day: d })[k]).join("");
  }, iso);
  await t.focus(sel);
  await t.keyboard.press("Control+A").catch(() => {});
  await t.keyboard.type(digits);
}
const valueOf = (sel) => t.inputValue(sel);

await t.goto(origin + "/v3/therapist.html");
await t.fill("#signin-username", "terapeuta_demo");
await t.fill("#signin-password", "senha-sintetica-demo");
await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");
await t.fill("#participant-alias", "Data Teste");
await t.click("#btn-create-participant");
await t.waitForSelector("#participant-result:not([hidden])");
const pid = await t.inputValue("#active-participant-id");

// token for direct API probes (bypasses every UI guard)
const login = await ctx.request.post(origin + "/api/v3/auth/therapist", { data: { username: "terapeuta_demo", password: "senha-sintetica-demo" } });
const token = (await login.json()).token;
const H = { Authorization: `Bearer ${token}` };
const assessments = async () => (await (await ctx.request.get(`${origin}/api/v3/participants/${pid}/assessments`, { headers: H })).json());
const listLen = async () => { const b = await assessments(); return (b.items ?? b.entities ?? b).length; };

await check("DF-1 controles de data são nativos (type=date), com rótulo e sem máscara de texto", async () => {
  for (const id of ["assessment-date", "rx-valid-from", "rx-valid-to", "summary-period-from", "summary-period-to", "evolution-period-from", "evolution-period-to"]) {
    assert.equal(await t.getAttribute(`#${id}`, "type"), "date", id);
    assert.equal(await t.getAttribute(`#${id}`, "pattern"), null, id);
    assert.ok((await t.locator(`label[for="${id}"]`).textContent()).trim().length > 3, id);
  }
});

const baseCount = await listLen();
await check("DF-2 data impossível digitada (30/02/2026): erro no campo, foco, nada é enviado, nada persiste", async () => {
  await typeDate("#assessment-date", "2026-02-30");
  const before = count(/assessments/);
  await t.click("#btn-create-assessment");
  await t.waitForSelector("#assessment-date-error:not([hidden])");
  assert.match(await t.textContent("#assessment-date-error"), /does not exist/i);
  assert.equal(await t.getAttribute("#assessment-date", "aria-invalid"), "true");
  assert.match(await t.getAttribute("#assessment-date", "aria-describedby"), /assessment-date-error/);
  assert.equal(await t.evaluate(() => document.activeElement.id), "assessment-date", "foco no campo com erro");
  assert.equal(count(/assessments/), before, "nenhuma escrita foi enviada");
  assert.equal(await listLen(), baseCount, "nada persistido");
});
await check("DF-3 o erro troca de idioma sem requisição e sem perder o campo; some ao editar", async () => {
  const before = writes.length;
  await t.click('[data-lang-option="pt-BR"]');
  assert.match(await t.textContent("#assessment-date-error"), /não existe/i);
  await t.click('[data-lang-option="en"]');
  assert.match(await t.textContent("#assessment-date-error"), /does not exist/i);
  assert.equal(writes.length, before);
  await typeDate("#assessment-date", "2026-02-27");
  assert.equal(await t.locator("#assessment-date-error").isHidden(), true);
  assert.equal(await t.getAttribute("#assessment-date", "aria-invalid"), null);
});
await check("DF-4 ano não bissexto: 29/02/2026 bloqueado; campo vazio obrigatório bloqueado", async () => {
  await typeDate("#assessment-date", "2026-02-29");
  await t.click("#btn-create-assessment");
  await t.waitForSelector("#assessment-date-error:not([hidden])");
  assert.equal(await listLen(), baseCount);
  await t.focus("#assessment-date");
  await t.keyboard.press("Control+A").catch(() => {});
  await t.keyboard.press("Backspace");
  await t.click("#btn-create-assessment");
  await t.waitForSelector("#assessment-date-error:not([hidden])");
  assert.match(await t.textContent("#assessment-date-error"), /Enter the date|does not exist/i);
  assert.equal(await listLen(), baseCount);
});
await check("DF-5 ano bissexto 29/02/2024 é aceito e persiste exatamente 2024-02-29", async () => {
  await typeDate("#assessment-date", "2024-02-29");
  assert.equal(await valueOf("#assessment-date"), "2024-02-29");
  await t.click("#btn-create-assessment");
  await t.waitForSelector("#assessment-result:not([hidden])");
  const items = await assessments();
  const rows = items.items ?? items.entities ?? items;
  assert.ok(rows.some((e) => e.payload.assessment_date === "2024-02-29"), JSON.stringify(rows).slice(0, 200));
  assert.equal(await listLen(), baseCount + 1);
  await t.click('[data-lang-option="pt-BR"]');
  assert.match(await t.textContent("#assessment-result"), /29\/02\/2024/);
  await t.click('[data-lang-option="en"]');
});
await check("DF-6 intervalo invertido na prescrição: erro no campo final, nada é enviado", async () => {
  await typeDate("#rx-valid-from", "2026-10-31");
  await typeDate("#rx-valid-to", "2026-10-01");
  const before = count(/prescriptions/);
  await t.click("#btn-publish-prescription");
  await t.waitForSelector("#rx-valid-to-error:not([hidden])");
  assert.match(await t.textContent("#rx-valid-to-error"), /cannot be earlier/i);
  assert.equal(count(/prescriptions/), before);
});
await check("DF-7 prescrição: data final opcional vazia é aceita; mesmo dia é um intervalo válido", async () => {
  await typeDate("#rx-valid-from", "2026-10-01");
  await typeDate("#rx-valid-to", "2026-10-01");
  await t.click("#btn-publish-prescription");
  await t.waitForSelector("#prescription-result:not([hidden])");
});
await check("DF-8 backend é a autoridade: chamada direta com datas impossíveis é recusada (400) e não persiste", async () => {
  const before = await listLen();
  for (const bad of ["2026-02-30", "2026-04-31", "2026-13-10", "2026-00-10"]) {
    const body = { assessment_date: bad, body_segment: "hand", side: "right", instrument: { instrument_id: "custom_unvalidated", instrument_version: "0", status: "unvalidated_custom" }, items: [], therapist_note: null };
    const r = await ctx.request.post(`${origin}/api/v3/participants/${pid}/assessments`, { headers: H, data: body });
    assert.equal(r.status(), 400, `${bad} -> ${r.status()}`);
  }
  assert.equal(await listLen(), before);
});
await check("DF-9 teclado: o foco chega ao campo de data e Enter no formulário com data inválida não envia", async () => {
  await typeDate("#assessment-date", "2026-04-31");
  const before = count(/assessments/);
  await t.keyboard.press("Enter");
  await t.waitForSelector("#assessment-date-error:not([hidden])");
  assert.equal(count(/assessments/), before);
});
await check("DF-10 data histórica inválida só é exibida como armazenada, nunca deslocada", async () => {
  const shown = await t.evaluate(async () => (await import("/v3/i18n.mjs")).formatIsoDate("2026-02-30"));
  assert.equal(shown, "2026-02-30");
});
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ passed: failed.length === 0, results }, null, 2));
process.exit(failed.length ? 1 : 0);
