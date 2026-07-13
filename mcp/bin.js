#!/usr/bin/env node
// stdout is the MCP wire. pdf.js prints its module-scope "legacy build" warning
// via console.log, and in the bundled dist the external pdfjs-dist import hoists
// ABOVE any inlined hush code — so the redirect must live in a separate entry
// module that defers the server (and its hoisted externals) behind a dynamic
// import. Same belt as src/hush.ts, one module earlier.
console.log = console.error.bind(console);
const tracingEnabled = process.env.OPENTAKEOFF_MCP_TRACE === '1';
if (tracingEnabled) {
  const originalConsoleError = console.error;
  console.error = (...args) => {
    const toolCallLog = args.map(arg => JSON.stringify(arg)).join(' ');
    originalConsoleError(`TOOL_CALL ${toolCallLog}`);
  };
}
// pdf.js 4.x needs Promise.withResolvers (Node 22+); polyfill here so the
// engines floor stays Node 20 — must exist before pdfjs-dist evaluates.
if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

// server-core keeps upstream's run-only-as-entry guard (import.meta.url vs
// argv[1]); satisfy it so the guard sees the core as the entry.
import { fileURLToPath } from "node:url";
process.argv[1] = fileURLToPath(new URL("./server-core.js", import.meta.url));

await import("./server-core.js");
