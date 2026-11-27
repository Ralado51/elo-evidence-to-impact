import { bindText, tm } from "../i18n.mjs";
import fixture from "./draft_fixture.mjs";

export function mountAssistedDraft(root) {
  const find = (id) => root.querySelector("#" + id);
  const body = find("draft-body");
  const fields = find("draft-fields");
  const source = find("draft-source");
  const status = find("draft-status");
  let context = "";
  const clear = () => {
    source.textContent = "";
    fields.replaceChildren();
    bindText(status, "");
    body.hidden = true;
  };

  find("btn-draft-load").addEventListener("click", () => {
    if (!context) return;
    clear();
    source.textContent = fixture.transcript_text;
    for (const proposal of fixture.proposals) {
      const field = document.createElement("div");
      field.className = "field";
      const label = document.createElement("label");
      const input = document.createElement("textarea");
      const marker = document.createElement("p");
      input.id = "s4-draft-" + proposal.field_key;
      input.rows = 2;
      input.maxLength = 500;
      input.value = proposal.proposed_value;
      marker.id = input.id + "-status";
      input.setAttribute("aria-describedby", marker.id);
      label.htmlFor = input.id;
      bindText(label, tm("th.s4." + proposal.field_key));
      bindText(marker, tm("th.s4." + proposal.state));
      input.addEventListener("input", () => {
        bindText(marker, tm("th.s4.manual"));
        bindText(status, "");
      });
      field.append(label, input, marker);
      fields.appendChild(field);
    }
    body.hidden = false;
  });
  find("btn-draft-reviewed").addEventListener("click", () => {
    if (context && !body.hidden) bindText(status, tm("th.s4.reviewed"));
  });
  return {
    setContext(next) {
      if (next !== context) clear();
      context = next;
      root.hidden = !context;
    },
  };
}
