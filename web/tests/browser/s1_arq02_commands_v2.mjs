// ARQ-02 fix01 — v2 of s1_arq02_commands.mjs: IDENTICAL scenarios; the only change is that each new intention starts with an
// explicit user edit (touch) because fix01 defines intention identity by edit, not by elapsed time (see ARQ-02_CORRECTION_REPORT.md §6).
// The original file is kept untouched.
// ARQ-02 CommandController + transactional idempotency in a real browser (SYNTHETIC data).
// Usage: node s1_arq02_commands.mjs --origin URL     (exit code != 0 when any check fails)
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
const check = async (id, fn) => { try { await fn(); results.push({ id, ok: true }); console.log("PASS", id); } catch (e) { results.push({ id, ok: false, error: String(e.message).split("\n")[0] }); console.log("FAIL", id, "::", String(e.message).split("\n").slice(0, 2).join(" / ")); } };

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
await ctx.addInitScript(() => {
  try { localStorage.setItem("elo_lang", "en"); } catch {}
  const real = Date.now.bind(Date); window.__skew = 0; Date.now = () => real() + (window.__skew || 0);
});
const t = await ctx.newPage();
let writes = [];
t.on("request", (r) => { if (/\/api\/v3\//.test(r.url()) && r.method() !== "GET") writes.push({ path: new URL(r.url()).pathname, key: r.headers()["idempotency-key"] || null }); });
const count = (re) => writes.filter((w) => re.test(w.path)).length;
const settle = () => t.waitForTimeout(900);

await t.goto(origin + "/v3/therapist.html");
await t.fill("#signin-username", "terapeuta_demo");
await t.fill("#signin-password", "senha-sintetica-demo");
await t.click("#btn-signin");
await t.waitForSelector("#signin-result:not([hidden])");
await t.fill("#participant-alias", "Comando Teste");
await t.click("#btn-create-participant");
await t.waitForSelector("#participant-result:not([hidden])");
const pid = await t.inputValue("#active-participant-id");
const login = await ctx.request.post(origin + "/api/v3/auth/therapist", { data: { username: "terapeuta_demo", password: "senha-sintetica-demo" } });
const H = { Authorization: `Bearer ${(await login.json()).token}` };
const goalCount = async () => { const b = await (await ctx.request.get(`${origin}/api/v3/participants/${pid}/goals`, { headers: H })).json(); return (b.items ?? b.entities ?? b).length; };
const successVisible = () => t.locator("#success-banner").isVisible();
const errorVisible = () => t.locator("#error-banner").isVisible();
const errorCode = () => t.getAttribute("#error-banner", "data-error-code");
const touch = async () => { await t.focus("#goal-text"); await t.keyboard.press("End"); await t.keyboard.type("x"); await t.keyboard.press("Backspace"); };
await t.fill("#goal-text", "Meta sintética de teste de comando");

let base = await goalCount();
await check("CC-1 duplo clique em 'Salvar meta': 1 envio, 1 registro (D04/S1-03)", async () => {
  writes = [];
  await t.dblclick("#btn-create-goal");
  await settle();
  assert.equal(count(/\/goals$/), 1, `envios=${count(/\/goals$/)}`);
  assert.equal((await goalCount()) - base, 1);
});

await check("CC-2 Enter + clique simultâneos: 1 envio, 1 registro", async () => {
  await touch();
  base = await goalCount(); writes = [];
  await t.focus("#goal-text");
  await Promise.all([t.keyboard.press("Enter"), t.click("#btn-create-goal")]);
  await settle();
  assert.equal(count(/\/goals$/), 1, `envios=${count(/\/goals$/)}`);
  assert.equal((await goalCount()) - base, 1);
});

await check("CC-3 chave Idempotency-Key enviada e nova a cada intenção", async () => {
  await touch();
  writes = [];
  await t.click("#btn-create-goal"); await settle();
  await touch();
  await t.click("#btn-create-goal"); await settle();
  const k = writes.filter((w) => /\/goals$/.test(w.path)).map((w) => w.key);
  assert.equal(k.length, 2);
  assert.ok(k.every((x) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x)), String(k));
  assert.notEqual(k[0], k[1]);
});

await check("CC-4 resposta perdida após commit: mesma chave no reenvio, replay, sem duplicata, sem sucesso+erro juntos", async () => {
  await touch();
  base = await goalCount(); writes = [];
  let first = true;
  await t.route("**/api/v3/participants/*/goals", async (route) => {
    if (route.request().method() === "POST" && first) { first = false; await route.fetch(); await route.abort("connectionreset"); } else await route.continue();
  });
  await t.click("#btn-create-goal"); await settle();
  assert.equal(await goalCount() - base, 1, "efeito deveria ter sido commitado");
  assert.ok(await errorVisible() && !(await successVisible()), "estado exclusivo: erro");
  const replies = [];
  t.on("response", (r) => { if (/\/goals$/.test(r.url()) && r.request().method() === "POST") replies.push(r.headers()["idempotency-replayed"] || null); });
  await t.click("#btn-create-goal"); await settle();
  await t.unroute("**/api/v3/participants/*/goals");
  const k = writes.filter((w) => /\/goals$/.test(w.path)).map((w) => w.key);
  assert.equal(k.length, 2); assert.equal(k[0], k[1], "mesma chave no reenvio");
  assert.equal(await goalCount() - base, 1, "sem duplicata");
  assert.deepEqual(replies, ["true"], "Idempotency-Replayed deve atravessar o gateway");
  assert.ok((await successVisible()) && !(await errorVisible()), "estado exclusivo: sucesso");
});

await check("CC-5 falha antes do commit (erro 5xx simulado sem chegar à API): reenvio com mesma chave cria 1 registro", async () => {
  await touch();
  base = await goalCount(); writes = [];
  let first = true;
  await t.route("**/api/v3/participants/*/goals", async (route) => {
    if (route.request().method() === "POST" && first) { first = false; await route.abort("connectionreset"); } else await route.continue();
  });
  await t.click("#btn-create-goal"); await settle();
  assert.equal(await goalCount() - base, 0);
  await t.click("#btn-create-goal"); await settle();
  await t.unroute("**/api/v3/participants/*/goals");
  assert.equal(await goalCount() - base, 1);
});

await check("CC-6 após a janela segura: sem reenvio automático, estado 'resultado desconhecido', nova tentativa só por ação explícita", async () => {
  await touch();
  writes = [];
  let first = true;
  await t.route("**/api/v3/participants/*/goals", async (route) => {
    if (route.request().method() === "POST" && first) { first = false; await route.abort("connectionreset"); } else await route.continue();
  });
  await t.click("#btn-create-goal"); await settle();
  const sentBefore = count(/\/goals$/);
  await t.evaluate(() => { window.__skew = 25 * 3600 * 1000; });
  await t.click("#btn-create-goal"); await settle();
  assert.equal(count(/\/goals$/), sentBefore, "nenhum reenvio após a janela");
  assert.equal(await errorCode(), "RESULT_UNKNOWN");
  assert.ok(await t.locator("#btn-cmd-new-intention").isVisible());
  await t.click("#btn-cmd-new-intention");
  base = await goalCount();
  await t.click("#btn-create-goal"); await settle();
  await t.unroute("**/api/v3/participants/*/goals");
  const k = writes.filter((w) => /\/goals$/.test(w.path)).map((w) => w.key);
  assert.equal(k.length, sentBefore + 1); assert.notEqual(k[k.length - 1], k[0], "nova chave só após intenção explícita");
  assert.equal(await goalCount() - base, 1);
  await t.evaluate(() => { window.__skew = 0; });
});

await check("CC-7 erro definitivo do servidor: só erro visível; depois sucesso: só sucesso (FIX-18)", async () => {
  await touch();
  await t.route("**/api/v3/participants/*/goals", async (route) => {
    if (route.request().method() === "POST") await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "TYPE", message: "bad" } }) });
    else await route.continue();
  });
  await t.click("#btn-create-goal"); await settle();
  assert.ok((await errorVisible()) && !(await successVisible()));
  await t.unroute("**/api/v3/participants/*/goals");
  await t.click("#btn-create-goal"); await settle();
  assert.ok((await successVisible()) && !(await errorVisible()));
});

await check("CC-8 geração de convite: duplo clique gera 1 convite; segredo não vai ao registro de idempotência", async () => {
  writes = [];
  await t.dblclick("#btn-create-invite"); await settle();
  assert.equal(count(/\/invites$/), 1);
  assert.equal(writes.find((w) => /\/invites$/.test(w.path)).key, null, "invites.create não envia chave");
});

await check("CC-9 cabeçalhos pelo gateway: Idempotency-Retention-Days em /health e Replayed em chamada direta", async () => {
  const h = await ctx.request.get(origin + "/api/v3/health");
  assert.ok(Number(h.headers()["idempotency-retention-days"]) >= 1, JSON.stringify(h.headers()));
  const key = "3f1c2a40-7d1e-4b8a-9c11-0a1b2c3d4e5f";
  const body = { goal_text: "direta", body_segment: "hand", target: { kind: "descriptive_text", value: null, unit: null }, status: "active", confirmed_by: null, confirmed_at: null };
  const a = await ctx.request.post(`${origin}/api/v3/participants/${pid}/goals`, { headers: { ...H, "Idempotency-Key": key }, data: body });
  const b = await ctx.request.post(`${origin}/api/v3/participants/${pid}/goals`, { headers: { ...H, "Idempotency-Key": key }, data: body });
  assert.equal(a.status(), 201); assert.equal(b.status(), 201);
  assert.equal(b.headers()["idempotency-replayed"], "true");
  assert.equal(a.headers()["idempotency-replayed"], undefined);
  const c = await ctx.request.post(`${origin}/api/v3/participants/${pid}/goals`, { headers: { ...H, "Idempotency-Key": key }, data: { ...body, goal_text: "outra" } });
  assert.equal(c.status(), 409);
  const d = await ctx.request.post(`${origin}/api/v3/participants/${pid}/goals`, { headers: { ...H, "Idempotency-Key": "not-a-uuid" }, data: body });
  assert.equal(d.status(), 400);
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.id) }));
process.exit(failed.length ? 1 : 0);
