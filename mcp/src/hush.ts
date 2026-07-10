// stdout is the MCP wire — anything printed there corrupts the JSON-RPC stream.
// pdf.js's warn()/info() print via console.log (its module-scope "use the legacy
// build" warning fires before any verbosity option applies), so console.log is
// redirected to stderr BEFORE any pdfjs-touching import resolves. Static imports
// hoist, which is why this lives in its own module that must stay the FIRST
// import of server.ts and pdf.ts. verbosity: 0 on getDocument is the second belt.
console.log = console.error.bind(console);

// pdf.js 4.x calls Promise.withResolvers, which Node grew in v22 — polyfill it
// so the engines floor stays Node 20 (harmless no-op on 22+).
if (typeof (Promise as { withResolvers?: unknown }).withResolvers !== "function") {
  (Promise as unknown as { withResolvers: <T>() => unknown }).withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}
export {};
