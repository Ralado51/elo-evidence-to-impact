import assert from "node:assert/strict";
import test from "node:test";
import { createLocalSpeech } from "./local_speech.mjs";
import { mountAssistedDraft } from "./assisted_draft.mjs";

test("speech ignores remote voices and aborts the local utterance", async () => {
  let request, stops = 0;
  let voices = [{ lang: "pt-BR", localService: false }];
  const engine = {
    getVoices: () => voices,
    speak: (value) => { request = value; },
    cancel: () => { stops++; },
  };
  class Utterance { constructor(text) { this.text = text; } }
  const port = createLocalSpeech(engine, Utterance, () => "pt-BR");
  const control = new AbortController();
  await assert.rejects(port.play("Instrução", { signal: control.signal }));
  assert.equal(request, undefined);
  voices.push({ lang: "pt-BR", localService: true });
  const play = port.play("Instrução", { signal: control.signal });
  assert.equal(request.voice, voices[1]);
  assert.equal(request.text, "Instrução");
  control.abort();
  await play;
  assert.equal(stops, 1);
  assert.equal(request.onend, null);
});

test("synthetic draft keeps original text, allows edits, and clears on context change", () => {
  function node() {
    return {
      events: {}, children: [], hidden: false, textContent: "",
      addEventListener(name, fn) { this.events[name] = fn; },
      setAttribute() {},
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.append(child); },
      replaceChildren() { this.children = []; },
    };
  }
  const nodes = new Map();
  const root = { querySelector(key) {
    if (!nodes.has(key)) nodes.set(key, node());
    return nodes.get(key);
  } };
  const at = (name) => root.querySelector("#" + name);
  const previous = globalThis.document;
  globalThis.document = { createElement: node };
  try {
    const preview = mountAssistedDraft(root);
    preview.setContext("p_fixture01");
    at("btn-draft-load").events.click();
    assert.match(at("draft-source").textContent, /Não completou.*esquerda/);
    const rows = at("draft-fields").children;
    assert.equal(rows.length, 3);
    assert.notEqual(rows[1].children[2].textContent, rows[2].children[2].textContent);
    at("btn-draft-reviewed").events.click();
    assert.ok(at("draft-status").textContent);
    const input = rows[0].children[1];
    input.value = "Edição sintética";
    input.events.input();
    assert.equal(at("draft-status").textContent, "");
    assert.match(at("draft-source").textContent, /Não completou/);
    preview.setContext("p_fixture02");
    assert.equal(at("draft-source").textContent, "");
    assert.equal(at("draft-fields").children.length, 0);
    preview.setContext("");
    assert.equal(root.hidden, true);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
