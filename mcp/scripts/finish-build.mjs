// Finishes the build after esbuild has produced dist/server-core.js:
// copies bin.js to dist/server.js as the actual npm "bin" entry point, and
// marks it executable so `npx opentakeoff-mcp` works on Unix.
//
// This replaces a shell tail of `cp bin.js dist/server.js && chmod +x
// dist/server.js`, which fails on Windows (`cp`/`chmod` aren't shell
// builtins there). fs.copyFileSync/fs.chmodSync are cross-platform: chmod
// on Windows is a harmless no-op (Windows doesn't use POSIX permission
// bits), so this script behaves identically to the old one on Unix while
// no longer breaking `npm run build` on Windows.

import { chmodSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mcpDir = fileURLToPath(new URL("..", import.meta.url));
const src = `${mcpDir}bin.js`;
const dest = `${mcpDir}dist/server.js`;

copyFileSync(src, dest);
chmodSync(dest, 0o755);
