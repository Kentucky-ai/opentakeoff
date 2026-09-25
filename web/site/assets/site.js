// Progressive enhancement for the static pages: a copy button on code blocks.
// Everything on these pages reads fine without it.
document.addEventListener("DOMContentLoaded", () => {
  if (!navigator.clipboard) return;
  for (const pre of document.querySelectorAll("pre")) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "copy";
    b.textContent = "Copy";
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector("code")?.innerText ?? pre.innerText);
        b.textContent = "Copied";
      } catch {
        b.textContent = "Select + copy";
      }
      setTimeout(() => (b.textContent = "Copy"), 1600);
    });
    pre.classList.add("has-copy");
    pre.appendChild(b);
  }
});
