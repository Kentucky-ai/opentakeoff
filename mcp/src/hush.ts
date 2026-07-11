// stdout is the MCP wire — anything printed there corrupts the JSON-RPC stream.
// pdf.js's warn()/info() print via console.log (its module-scope "use the legacy
// build" warning fires before any verbosity option applies), so console.log is
// redirected to stderr BEFORE any pdfjs-touching import resolves. Static imports
// hoist, which is why this lives in its own module that must stay the FIRST
// import of server.ts and pdf.ts. verbosity: 0 on getDocument is the second belt.
console.log = console.error.bind(console);

// pdf.js 4.x calls Promise.withResolvers, which Node grew unflagged in v22 —
// the package.json engines floor is now Node >=24 (see .github/workflows/ci.yml),
// so every supported runtime has it natively and the polyfill that used to sit
// here (for a Node 20 floor) is dead code. Removed rather than kept "harmless":
// a stale rationale comment ("keeps the floor at 20") would actively mislead
// the next reader once the floor moved to 24.
export {};
