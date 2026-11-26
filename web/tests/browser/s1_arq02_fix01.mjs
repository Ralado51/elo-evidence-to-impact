// ARQ-02 fix01 characterization (D04, S1-03, S1-08). SYNTHETIC data only. Must FAIL on baseline 5331e60 and PASS after the fix.
// Usage: ELO_PLAYWRIGHT_DIR=... node s1_arq02_fix01.mjs --origin http://127.0.0.1:8080
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const origin = args.origin || "http://127.0.0.1:8080";
const pwDir = process.env.ELO_PLAYWRIGHT_DIR || path.join(os.homedir(), "hackathons/elo-platform/workspace/tools/playwright");
const { chromium } = await import(pathToFileURL(path.join(pwDir, "node_modules/playwright-core/index.mjs")).href);
const browser = await chromium.launch({ headless: true, ...(process.env.ELO_CHROME ? { executablePath: process.env.ELO_CHROME, args: ["--no-sandbox"] } : {}) });
let failed = 0;
const check = async (id, fn) => { try { await fn(); console.log("PASS", id); } catch (e) { failed++; console.log("FAIL", id, "::", String(e.message).split("\n").slice(0, 2).join(" / ")); } };

async function therapistPage(alias) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await ctx.addInitScript(() => { try { localStorage.setItem("elo_lang", "en"); } catch {} });
  const t = await ctx.newPage();
  const writes = [];
  t.on("request", (r) => { if (/\/api\/v3\//.test(r.url()) && r.method() === "POST") writes.push({ path: new URL(r.url()).pathname, key: r.headers()["idempotency-key"] || null }); });
  await t.goto(origin + "/v3/therapist.html");
  await t.fill("#signin-username", "terapeuta_demo");
  await t.fill("#signin-password", "senha-sintetica-demo");
  await t.click("#btn-signin");
  await t.waitForSelector("#signin-result:not([hidden])");
  await t.fill("#participant-alias", alias);
  await t.click("#btn-create-participant");
  await t.waitForSelector("#participant-result:not([hidden])");
  const pid = await t.inputValue("#active-participant-id");
  const login = await ctx.request.post(origin + "/api/v3/auth/therapist", { data: { username: "terapeuta_demo", password: "senha-sintetica-demo" } });
  const H = { Authorization: `Bearer ${(await login.json()).token}` };
  const goalCount = async (id = pid) => { const b = await (await ctx.request.get(`${origin}/api/v3/participants/${id}/goals`, { headers: H })).json(); return (b.items ?? b.entities ?? b).length; };
  const goalReqs = () => writes.filter((w) => /\/goals$/.test(w.path));
  return { ctx, t, pid, goalCount, goalReqs, writes, H };
}
const edit = async (t) => { await t.focus("#goal-text"); await t.keyboard.press("End"); await t.keyboard.type("x"); await t.keyboard.press("Backspace"); };

// ---------- D04 ----------
{
  const { ctx, t, goalCount, goalReqs, writes } = await therapistPage("Fix01 D04");
  for (const delay of [0, 80, 600, 1500]) {
    await check(`FX-D04-a Enter seguido de clique (${delay} ms): 1 requisição, 1 chave, 1 registro`, async () => {
      await edit(t); // explicit new intention
      const base = await goalCount(); writes.length = 0;
      await t.focus("#goal-text"); await t.keyboard.press("Enter");
      if (delay) await t.waitForTimeout(delay);
      await t.click("#btn-create-goal"); await t.waitForTimeout(900);
      assert.equal(goalReqs().length, 1, `requisições=${goalReqs().length}`);
      assert.equal((await goalCount()) - base, 1, "efeitos persistidos");
    });
  }
  for (const delay of [0, 700]) {
    await check(`FX-D04-b clique seguido de Enter (${delay} ms): 1 requisição, 1 registro`, async () => {
      await edit(t);
      const base = await goalCount(); writes.length = 0;
      await t.click("#btn-create-goal");
      if (delay) await t.waitForTimeout(delay);
      await t.focus("#goal-text"); await t.keyboard.press("Enter"); await t.waitForTimeout(900);
      assert.equal(goalReqs().length, 1, `requisições=${goalReqs().length}`);
      assert.equal((await goalCount()) - base, 1);
    });
  }
  await check("FX-D04-c Enter repetido (3x, 700 ms): 1 requisição, 1 registro", async () => {
    await edit(t);
    const base = await goalCount(); writes.length = 0;
    await t.focus("#goal-text");
    for (let i = 0; i < 3; i++) { await t.keyboard.press("Enter"); await t.waitForTimeout(700); }
    assert.equal(goalReqs().length, 1);
    assert.equal((await goalCount()) - base, 1);
  });
  await check("FX-D04-d resposta lenta (1,2 s): Enter + clique durante o voo e clique depois: 1 requisição, 1 registro", async () => {
    await edit(t);
    await t.route("**/api/v3/participants/*/goals", async (route) => { try { if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 1200)); await route.continue(); } catch {} });
    const base = await goalCount(); writes.length = 0;
    await t.focus("#goal-text"); await t.keyboard.press("Enter"); await t.waitForTimeout(300);
    await t.click("#btn-create-goal"); await t.waitForTimeout(1600);
    await t.click("#btn-create-goal"); await t.waitForTimeout(500);
    await t.unroute("**/api/v3/participants/*/goals", undefined).catch(() => {});
    assert.equal(goalReqs().length, 1, `requisições=${goalReqs().length}`);
    assert.equal((await goalCount()) - base, 1);
  });
  await check("FX-D04-e nova intenção legítima com conteúdo idêntico (após edição explícita): 2 chaves distintas, +2 registros", async () => {
    await edit(t);
    const base = await goalCount(); writes.length = 0;
    await t.click("#btn-create-goal"); await t.waitForTimeout(900);
    await edit(t); // the user touches the form again; content is identical to the first goal
    await t.click("#btn-create-goal"); await t.waitForTimeout(900);
    const keys = goalReqs().map((w) => w.key);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.equal((await goalCount()) - base, 2);
  });
  await check("FX-D04-f chaves: toda requisição de meta leva Idempotency-Key UUID v4", async () => {
    assert.ok(goalReqs().every((w) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(w.key || "")));
  });
  await ctx.close();
}

// ---------- S1-08 ----------
{
  const { ctx, t, pid } = await therapistPage("Fix01 Alfa");
  const login = await ctx.request.post(origin + "/api/v3/auth/therapist", { data: { username: "terapeuta_demo", password: "senha-sintetica-demo" } });
  const H = { Authorization: `Bearer ${(await login.json()).token}` };
  // second participant (Beta) through the UI, then go back to Alfa
  await t.fill("#participant-alias", "Fix01 Beta");
  await t.click("#btn-create-participant");
  await t.waitForFunction((a) => document.querySelector("#active-participant-id").value !== a, pid);
  const betaId = await t.inputValue("#active-participant-id");
  const switchTo = async (id) => { await t.click(`#participant-list li[data-participant-id="${id}"] button`); await t.waitForFunction((x) => document.querySelector("#active-participant-id").value === x, id); await t.waitForTimeout(300); };
  const state = () => t.evaluate(() => { const i = document.querySelector("#assessment-date"); const n = document.getElementById("assessment-date-error"); return { invalid: i.getAttribute("aria-invalid"), described: i.getAttribute("aria-describedby"), value: i.value, errText: n ? n.textContent : "", errHidden: n ? n.hidden : true }; });
  await switchTo(pid);
  await check("FX-S108-a erro de data incompleta na troca de participante: mensagem, aria-invalid e aria-describedby limpos", async () => {
    await t.fill("#assessment-date", "");
    await t.click("#btn-create-assessment");
    let s = await state();
    assert.equal(s.invalid, "true", "erro deveria estar ativo antes da troca");
    assert.ok(s.errText.length > 0 && !s.errHidden);
    await switchTo(betaId);
    s = await state();
    assert.ok(s.value !== "", "data padrão restaurada");
    assert.equal(s.invalid, null, "aria-invalid residual");
    assert.ok(!s.described || !s.described.includes("assessment-date-error"), `aria-describedby residual: ${s.described}`);
    assert.equal(s.errText, "", "texto de erro residual");
    assert.equal(s.errHidden, true);
  });
  await check("FX-S108-b alternância PT/EN após a troca: sem estado residual e rótulos coerentes", async () => {
    await t.click('[data-lang-option="pt-BR"]'); await t.click('[data-lang-option="en"]');
    const s = await state();
    assert.equal(s.invalid, null);
    assert.equal(s.errText, "");
  });
  await check("FX-S108-c a validação continua funcionando depois da troca (campo reaproveitado)", async () => {
    await t.fill("#assessment-date", "");
    await t.click("#btn-create-assessment");
    const s = await state();
    assert.equal(s.invalid, "true");
    assert.ok(s.described.includes("assessment-date-error"));
  });
  await ctx.close();
}

// ---------- S1-03 (participant report) ----------
{
  const t = await therapistPage("Fix01 S103");
  await t.t.click("#btn-create-assessment"); await t.t.waitForSelector("#assessment-result:not([hidden])");
  await t.t.click("#btn-create-goal"); await t.t.waitForSelector("#goal-result:not([hidden])");
  await t.t.fill("#rx-valid-from", "2026-01-01"); await t.t.fill("#rx-valid-to", "2027-12-31");
  await t.t.click("#btn-publish-prescription"); await t.t.waitForSelector("#prescription-result:not([hidden])");
  const inv = await (await t.ctx.request.post(origin + "/api/v3/invites", { headers: t.H, data: { participant_id: t.pid, ttl_seconds: 86400 } })).json();
  const pctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await pctx.addInitScript(() => { try { localStorage.setItem("elo_lang", "en"); } catch {} });
  const p = await pctx.newPage();
  const events = [];
  p.on("request", (r) => { if (/\/api\/v3\/events/.test(r.url()) && r.method() === "POST") events.push(r.postData() || ""); });
  await p.goto(origin + "/v3/participant.html");
  await p.fill("#invite-token", inv.invite_token); await p.click("#btn-invite-signin");
  await p.waitForSelector("#signin-result:not([hidden])");
  await p.click("#btn-load-plan"); await p.waitForSelector('#prescription-view[data-prescription-loaded="true"]');
  const finishSession = async () => {
    await p.click("#btn-session-start"); await p.waitForSelector('#session-result[data-session-phase="active"]');
    await p.click("#btn-session-end"); await p.waitForSelector('#session-result[data-session-phase="ended"][data-end-action="end"]');
    await p.click('button[data-choice-group="execution"][data-choice-value="complete"]');
    await p.click('button[data-choice-group="assistance"][data-choice-value="some"]');
  };
  const banners = () => p.evaluate(() => ({ ok: !document.querySelector("#success-banner").hidden, err: !document.querySelector("#error-banner").hidden, errCode: document.querySelector("#error-banner").getAttribute("data-error-code") }));
  const reportEvents = () => events.filter((b) => b.includes("report.submitted")).length;
  for (const [name, act] of [
    ["clique duplo", () => p.dblclick("#btn-submit-report")],
    ["Enter seguido de clique", async () => { await p.focus("#btn-submit-report"); await p.keyboard.press("Enter"); await p.waitForTimeout(700); await p.click("#btn-submit-report", { force: true, timeout: 2000 }).catch(() => {}); }],
    ["clique seguido de clique (1,5 s)", async () => { await p.click("#btn-submit-report"); await p.waitForTimeout(1500); await p.click("#btn-submit-report", { force: true, timeout: 2000 }).catch(() => {}); }],
  ]) {
    await check(`FX-S103 relato: ${name}: 1 evento, resultado único (sem erro junto do sucesso)`, async () => {
      await finishSession();
      const before = reportEvents();
      await act(); await p.waitForTimeout(900);
      const b = await banners();
      assert.equal(reportEvents() - before, 1, `eventos report.submitted=${reportEvents() - before}`);
      assert.equal(b.ok, true, "sucesso esperado");
      assert.equal(b.err, false, `erro coexistindo: ${b.errCode}`);
    });
  }
  await pctx.close(); await t.ctx.close();
}
await browser.close();
console.log(failed ? `FAILED: ${failed}` : "ALL PASS");
process.exit(failed ? 1 : 0);
