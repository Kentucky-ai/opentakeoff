// Node tests import pure libraries that resolve translated labels at module
// evaluation time. The browser uses i18next-http-backend; tests preload the
// same public JSON source so those libraries remain deterministic and offline.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import i18n from "../src/i18n/index.js";

const root = resolve(import.meta.dirname, "..", "public", "locales");
for (const lng of ["en", "pt-br"]) {
  for (const ns of ["canvas", "report", "panels", "guide", "lib"]) {
    const raw = await readFile(resolve(root, lng, `${ns}.json`), "utf8");
    i18n.addResourceBundle(lng, ns, JSON.parse(raw), true, true);
  }
}

await i18n.changeLanguage("en");
