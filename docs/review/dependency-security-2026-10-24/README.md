# Dependency security refresh — October 24, 2026

Baseline `e334dc55`. GitHub reported three high-severity alerts: body-parser below 2.4.0 in MCP, Zod below 4.6.6 in MCP, and Vite through 6.4.3 in the web toolchain. Lower-severity transitive advisories also affected dependency locks.

The patch raises MCP SDK and Zod requirements, migrates `z.record(value)` to the Zod 4 `z.record(z.string(), value)` signature, raises the minimum Vite patch version, and refreshes compatible vulnerable transitive packages in MCP, web and protocol locks. No tools or output fields are added or removed.

| Check | Expected | Observed |
|---|---|---|
| `npm audit` in MCP, web and protocol | Zero known advisories | Zero across all three locks; [audit.json](audit.json) |
| `npm run typecheck --prefix mcp` | Schema migration compiles | Passed |
| `npm test --prefix mcp` | Existing tool and output contracts pass | 295 passed, zero failed |
| `npm run check --prefix web` | Typecheck, lint, ORT, tests, benchmark, build, OCR distribution | Passed; 3,564 tests passed, four skipped, zero failed |
| `npm run check --prefix protocol` | Protocol tests/docs/matrix | 61 passed; 11 schemas and 16 transport cases checked |
| `npm run build --prefix mcp && npm run smoke:dist --prefix mcp` | Installable distribution still negotiates its tools and resources | 58 flat tools, 12 staged tools, 11 protocol schemas, 9 wiki pages verified over stdio |

Reproduce using `npm ci --ignore-scripts` inside each of `web`, `mcp`, and `protocol`, then run the commands above. These are dependency/schema changes with no visible UI change, so expected-versus-observed engine/tool evidence is provided instead of an unrelated screenshot.

Audits are advisory-database snapshots, not proof of exploitability or absence of all defects. In particular, an HTTP body-parser issue in the dependency graph does not demonstrate that the stdio entry point is remotely reachable. The review branch reserves MCP 0.9.100 consistently across all seven version fields. No npm package or release tag was published. Existing installed packages are not repaired by this branch alone.

This overlaps the dependency updates proposed in #557, #556, #564 and #565, plus the protocol fast-uri update in #563; it adds the Zod API migration and integrated local evidence. Those PRs have not been closed or merged by this work.
