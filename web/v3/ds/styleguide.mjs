for (const [btn, dlg] of [["sg-open-confirm", "sg-confirm"], ["sg-open-danger", "sg-danger"]]) {
  document.getElementById(btn)?.addEventListener("click", () => document.getElementById(dlg)?.showModal());
}
