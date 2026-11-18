import { readFileSync, writeFileSync } from "node:fs";
const json = new URL("../src/lib/i18n/ru.json", import.meta.url);
const output = new URL("../src/lib/i18n/ru.js", import.meta.url);
writeFileSync(output, "// Generated from ru.json. Keep the catalog pair in sync.\nexport default " + JSON.stringify(JSON.parse(readFileSync(json, "utf8")), null, 2) + ";\n");
