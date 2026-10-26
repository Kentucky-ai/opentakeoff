// Reproduce from the repo root:
//   node --import tsx docs/reviews/split-text-runs/measure.mts
// (tsx resolves from mcp/node_modules — run `npm ci --prefix mcp` first.)
// For every public plan in the repo: pdf.js text items vs the joined spans the
// MCP now reads, and every string the join produced, so a reviewer can see
// exactly what changes — and that ordinary words do not merge.
import { Session } from "../../../mcp/src/session.ts";
import { textSpans } from "../../../mcp/src/pdf.ts";

const PLANS = [
  "demo/sample-finish-plan.pdf",
  "evals/mcp-workflow-bench/plan-set/roseburg/va-roseburg-a03a.pdf",
  "evals/mcp-workflow-bench/plan-set/porterville/porterville-adu-a1-101.pdf",
];

for (const plan of PLANS) {
  const s = new Session();
  await s.loadPlan(plan);
  for (const st of (s as any).sheets.values()) {
    const raw = (st.page.textContent.items as { str: string }[]).filter((i) => i.str.trim());
    const rawStrs = new Set(raw.map((i) => i.str));
    const spans = textSpans(st.page);
    const joined = spans.filter((sp) => !rawStrs.has(sp.str)).map((sp) => sp.str);
    console.log(`${st.key}: ${raw.length} pdf.js items -> ${spans.length} spans; ${joined.length} joined`);
    if (joined.length) console.log(`   ${JSON.stringify(joined.slice(0, 40))}${joined.length > 40 ? " …" : ""}`);
  }
}
