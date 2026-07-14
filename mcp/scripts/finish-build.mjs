import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "bin.js");
const target = resolve(root, "dist", "server.js");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
chmodSync(target, 0o755);
