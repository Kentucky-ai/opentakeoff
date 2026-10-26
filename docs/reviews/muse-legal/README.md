# Public legal pages — review evidence

Adds `/privacy/` and `/terms/` as static documents, with explicit Netlify rewrites before the SPA fallback and links in the in-app guide. The terms cover the measurement/review layer used by agents for externally commissioned estimating work; they do not claim a hosted bounty or payment service exists.

## Visual evidence

- [Privacy page](privacy-desktop.png)
- [Terms page](terms-desktop.png)
- [In-app guide links](guide-links.png)

Screenshots captured from the local app in Chrome. Static documents are inspected at `/privacy/index.html` and `/terms/index.html` in Vite development mode; production clean URLs require the Netlify rewrites. No private plans or pricing are included.

## Reproduce

Use Node 24 and install dependencies with `npm ci --prefix web`, `npm ci --prefix mcp`, and `npm ci --prefix protocol`.

```sh
npm run check --prefix web
npm run check:tool-count --prefix mcp
npm run check:wiki --prefix mcp
npm run check --prefix protocol
node scripts/check-doc-links.mjs
npm run dev --prefix web -- --host 127.0.0.1 --port 5198
```

Observed: web check passed (1,846 tests: 1,843 passed, 3 skipped, 0 failed), including typecheck, lint, benchmark, and production build. MCP inventory and wiki checks passed. Protocol: 61 passed, 0 failed. Documentation links: 43 files checked, no broken relative references. Policy documents and shared CSS are present in `web/dist` after build. Open `http://127.0.0.1:5198/`, press `?`, and verify both legal links open in new tabs without unloading the workspace.

## Content basis and limits

Reviewed `web/src/lib/contribute.js`, the Google/Microsoft storage adapters and workspace gates, AI request paths, the optional `parse-schedule` function, voice documentation, `web/index.html`, and `web/src/styles/tokens.css`. These disclose local storage, opt-in sharing, contribution fields, the Cloudflare beacon, and Google Fonts. No claim of zero network traffic or universal on-device AI processing is made.

Provider references: [Cloudflare analytics](https://developers.cloudflare.com/web-analytics/about/), [Netlify privacy](https://www.netlify.com/privacy/), [Google privacy](https://policies.google.com/privacy). Drafting principle: [FTC privacy guidance](https://www.ftc.gov/business-guidance/privacy-security) — privacy statements must match actual practices.

These are initial operator-authored policies, not a legal opinion or certification of compliance. They do not add technical consent enforcement, a bounty marketplace, remote MCP transport, or payment infrastructure. Muse approval and compatibility remain separate from publication of these documents.
