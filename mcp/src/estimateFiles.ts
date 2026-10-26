// export_estimate / export_proposal — the canvas's own builders writing to disk:
// the Estimate panel's Excel (web/src/lib/estimateExport.js + xlsx.js) and the
// Proposal dialog's PDF (web/src/lib/bidProposal.js + bidProposalPdf.js), fed
// by the session's priced estimate. Same numbers, same OpenTakeoff watermark.
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { UserError } from "./format.ts";
import { assertWritable } from "./safewrite.ts";
import type { Session } from "./session.ts";
import { estimateWorkbook, estimateFileName } from "../../web/src/lib/estimateExport.js";
import { buildXlsx } from "../../web/src/lib/xlsx.js";
import { buildBidProposal, bidProposalFileName } from "../../web/src/lib/bidProposal.js";
import { buildBidProposalPdf } from "../../web/src/lib/bidProposalPdf.js";

function defaultDir(session: Session): string {
  if (!session.filePath) throw new UserError("No plan loaded — call load_plan first.");
  return path.dirname(session.filePath);
}
const planBase = (session: Session) => (session.file ?? "").replace(/\.pdf$/i, "");

function measured(session: Session) {
  const est = session.pricedEstimate();
  if (!est.lines.length) throw new UserError("Nothing to price yet — commit shapes under conditions, then set_pricing.");
  return est;
}

export async function exportEstimateFile(session: Session, opts: { path?: string; project_name?: string; company_name?: string; overwrite?: boolean }) {
  const dir = defaultDir(session);
  const est = measured(session);
  const project = opts.project_name ?? planBase(session);
  const outPath = path.resolve(opts.path ?? path.join(dir, estimateFileName(project)));
  await assertWritable(outPath, "xlsx", opts.overwrite);
  const sheets = estimateWorkbook({ est, projectName: project, companyName: opts.company_name ?? "", clientName: session.clientInfo.client_name ?? "" });
  await writeFile(outPath, await buildXlsx(sheets));
  return { path: outPath, tabs: sheets.map((s: { name: string }) => s.name), total: est.total, complete: est.complete, unpriced: est.unpriced };
}

export async function exportProposalFile(session: Session, opts: {
  path?: string; project_name?: string; overwrite?: boolean;
  company?: { name?: string; address?: string; phone?: string; email?: string; license?: string };
}) {
  const dir = defaultDir(session);
  const est = measured(session);
  const project = opts.project_name ?? planBase(session);
  const outPath = path.resolve(opts.path ?? path.join(dir, bidProposalFileName(project)));
  await assertWritable(outPath, "pdf", opts.overwrite);
  const model = buildBidProposal({ est, conditions: session.conditions, company: opts.company ?? {}, clientInfo: session.clientInfo, projectName: project, proposal: session.bidProposal });
  const { bytes, pages } = await buildBidProposalPdf(model);
  await writeFile(outPath, bytes);
  return {
    path: outPath, pages, base_bid: est.total, itemized: model.itemized,
    complete: est.complete, unpriced: est.unpriced,
    ...(model.company.name ? {} : { note: "No company name was passed — the letterhead is blank. Pass company {name, address, phone, email, license} from the estimator." }),
  };
}
