// Live calculator wiring. The page already carries a rendered worked example
// (build time); this re-renders on input and keeps the URL shareable.
import { CALCS } from "./calc-view.js";

for (const root of document.querySelectorAll("[data-calc]")) {
  const id = root.dataset.calc;
  const calc = CALCS[id];
  const form = root.querySelector("form");
  const out = root.querySelector(".readout-body");
  if (!calc || !form || !out) continue;

  const params = new URLSearchParams(location.search);
  for (const fd of calc.fields) {
    const v = params.get(fd.name);
    if (v !== null && v !== "" && Number.isFinite(Number(v))) form.elements[fd.name].value = v;
  }

  const read = () => Object.fromEntries(calc.fields.map((fd) => [fd.name, Number(form.elements[fd.name].value) || 0]));
  const syncPresets = (vals) => {
    for (const seg of form.querySelectorAll(".seg")) {
      for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(Number(b.dataset.v) === vals[seg.dataset.for]));
    }
  };
  const update = (push = true) => {
    const vals = read();
    out.innerHTML = calc.render(vals);
    syncPresets(vals);
    if (push) {
      const q = new URLSearchParams(Object.entries(vals).map(([k, v]) => [k, String(v)]));
      history.replaceState(null, "", `${location.pathname}?${q}`);
    }
  };

  form.addEventListener("input", () => update());
  form.addEventListener("submit", (e) => e.preventDefault());
  form.addEventListener("click", (e) => {
    const b = e.target.closest(".seg button");
    if (!b) return;
    form.elements[b.parentElement.dataset.for].value = b.dataset.v;
    update();
  });

  const share = root.querySelector(".share");
  if (share && navigator.clipboard) {
    share.hidden = false;
    share.addEventListener("click", async () => {
      await navigator.clipboard.writeText(location.href).catch(() => {});
      share.textContent = "Link copied";
      setTimeout(() => (share.textContent = "Copy link to this result"), 1600);
    });
  }
  update(params.size > 0);
}
