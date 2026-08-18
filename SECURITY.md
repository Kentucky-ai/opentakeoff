# Security policy

## Reporting

Use GitHub's **[private vulnerability reporting](https://github.com/Kentucky-ai/opentakeoff/security/advisories/new)**—Security tab → Report a vulnerability. It is enabled on this repo, it keeps the report private until there's a fix, and it gets a real answer. Don't open a public issue for something you believe is exploitable.

Expect a first response within about a week. If a report is valid we'll agree on a disclosure date with you and credit you in the advisory unless you'd rather not be named.

## What this software is, structurally

Most of the reports this project receives are about caller-supplied file paths. Whether that's a vulnerability depends entirely on where the trust boundary sits, so here it is explicitly.

**The web app (`web/`) is client-only.** React + Vite in the browser: no backend, no database, no accounts, no server-side storage. Plans are parsed by pdf.js in the tab and persisted to IndexedDB on the same machine. Nothing you open is uploaded anywhere.

**The MCP server (`mcp/`) is a local stdio subprocess.** It is launched by your own agent host, runs as your own user, and speaks JSON-RPC over stdin/stdout. It opens no socket and listens on no port. Reaching your filesystem is the entire function: `load_plan` reads the plan wherever your plans live, and `export_marked_pdf` writes the marked set wherever the job folder is.

**The optional Python backend (`server/`) is a local development sandbox** for the scale/room/finish AI seams. The `/ai` endpoints are key-gated, it is not deployed with the demo, and it is not intended to be exposed to a network.

## In scope

- Anything crossing a real boundary: the Netlify functions in `web/netlify/functions/`, token or audience validation, secrets reachable from a build or a published artifact.
- Remote input controlling local execution—a crafted PDF or takeoff file that achieves code execution, prototype pollution, or XSS in the browser app.
- Path handling where the path comes from **file content or a remote response** rather than from the caller. A sheet name or schedule cell that reaches a filesystem sink is a real finding; a `path` argument is not.
- Dependency vulnerabilities **with a reachable path through this code.** Say which of our call sites reaches it. We patch unreachable ones as hygiene, but the reachability argument is what makes it a report rather than a Dependabot alert we already have.
- Denial of service that a normal-sized plan set can trigger. A 4,000-page adversarial PDF is not interesting; a 40-sheet real one that hangs the tab is.

## Not vulnerabilities

- **`path` arguments on MCP tools writing or reading where you asked.** `export_takeoff`, `export_report`, `export_marked_pdf`, `load_plan`, and `import_takeoff` all take a caller-supplied path by design, and the README documents them doing exactly that. Confining them to the working directory would break the deliverable the tool exists to produce—an estimator's marked set belongs in the job folder, not in whatever directory the agent host happened to start in.
- **Prompt injection reaching a tool.** If an attacker can make a model call our tools with arguments of their choosing, they are inside the host's trust boundary, and that host's own file and shell tools are already available to them. Constraining one MCP server does not change that exposure. Tool-call approval is the host's job, and the protocol is designed that way.
- **The server acting with the privileges of the user who started it.** There is no privilege boundary between you and a subprocess you launched.
- Missing hardening headers on a static demo site that stores nothing and authenticates no one.
- Findings from an automated scanner with no dataflow pass behind them. We read every report, but one that flags a sink without tracing whether the input is attacker-controlled will be closed without much discussion. If you traced it by hand, say so and we'll dig in with you.

**Where we do care about destructive writes:** losing an unrelated file is a real defect even when it isn't a security boundary, so the export tools refuse to overwrite a file they didn't write. Re-exporting over a previous export is silent; anything else needs an explicit `overwrite: true`. That's data-loss protection, not a sandbox, and we don't claim otherwise.

## Supported versions

The latest `main` and the most recent published `opentakeoff-mcp` on npm. There are no maintained release branches—fixes ship forward.
