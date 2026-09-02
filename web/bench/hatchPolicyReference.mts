import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyHatchSegs,
  extractVectorGeometry,
  hatchFamilies,
} from "../src/lib/oneclick.ts";
import {
  classifyLineFamily,
  proposeLineFamilies,
} from "../src/lib/hatchPolicyReference.js";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const pdfjs = await import(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
const PROPOSAL_TIMEOUT_MS = 5_000;

const cases = {
  "sample-plan": { corpus: "sample-plan" },
  "va-finish-plan": { corpus: "va-finish-plan" },
  "dublin-finish-plan": {
    pdf: "../../bench/open-sheets/va-dublin-bldg9a-finish-plan-A601.pdf",
    page: 1,
    scale: 2,
  },
  "roseburg-floor-plan-a03a": {
    pdf: "../../bench/open-sheets/va-roseburg-b1ac-dwing-replace-finishes.pdf",
    page: 8,
    scale: 2,
  },
  "roseburg-rcp-a04a": {
    pdf: "../../bench/open-sheets/va-roseburg-b1ac-dwing-replace-finishes.pdf",
    page: 11,
    scale: 2,
  },
} as const;

type CaseName = keyof typeof cases;

async function loadCase(caseName: string) {
  if (!(caseName in cases)) throw new Error(`unknown case: ${caseName}`);
  const definition = cases[caseName as CaseName];
  const corpusPath = "corpus" in definition
    ? join(here, "corpus", `${definition.corpus}.json`)
    : null;
  const corpus = corpusPath ? JSON.parse(readFileSync(corpusPath, "utf8")) : definition;
  const pdfPath = resolve(corpusPath ? dirname(corpusPath) : here, corpus.pdf);
  const document = await pdfjs.getDocument({ url: pdfPath, useSystemFonts: true }).promise;
  const page = await document.getPage(corpus.page || 1);
  const viewport = page.getViewport({ scale: corpus.scale });
  const geometry = extractVectorGeometry(
    await page.getOperatorList(),
    viewport.transform,
    pdfjs.OPS,
  );
  await document.destroy();
  return { corpusPath, pdfPath, page: corpus.page || 1, geometry };
}

function referenceSegments(geometry: Awaited<ReturnType<typeof loadCase>>["geometry"]) {
  return Array.from({ length: geometry.segs.length >> 2 }, (_, index) => ({
    id: `segment-${index}`,
    x1: geometry.segs[index * 4],
    y1: geometry.segs[index * 4 + 1],
    x2: geometry.segs[index * 4 + 2],
    y2: geometry.segs[index * 4 + 3],
    strokeWidth: Math.max(1, geometry.meta[index] >> 4),
    meta: geometry.meta[index],
    luminance: geometry.lum?.[index] ?? null,
  }));
}

function isDegenerate(segment: ReturnType<typeof referenceSegments>[number]) {
  return segment.x1 === segment.x2 && segment.y1 === segment.y2;
}

function optimisticGeometryOnlyDecision(family: ReturnType<typeof hatchFamilies>[number]) {
  const width = Math.max(1, family.bbox[2] - family.bbox[0]);
  const height = Math.max(1, family.bbox[3] - family.bbox[1]);
  return classifyLineFamily(Object.freeze({
    memberIds: Object.freeze(family.memberIdx.map((index) => `segment-${index}`)),
    rowCount: family.rows,
    rowInlierRate: 1,
    segmentInlierRate: 1,
    occupancy: 1,
    medianNormalizedResidual: 0,
    crossConnectorRatio: 0,
    supportRailCount: 0,
    aspectRatio: Math.max(width, height) / Math.min(width, height),
  }));
}

async function proposalChild(caseName: string, filtered: boolean) {
  const { geometry } = await loadCase(caseName);
  const raw = referenceSegments(geometry);
  const segments = filtered ? raw.filter((segment) => !isDegenerate(segment)) : raw;
  const started = performance.now();
  try {
    const proposals = proposeLineFamilies(segments);
    const labels = proposals.map((proposal) => classifyLineFamily(proposal).label);
    process.stdout.write(JSON.stringify({
      status: "completed",
      elapsed_ms: Math.round(performance.now() - started),
      proposals: proposals.length,
      labels: Object.fromEntries(
        ["hatch", "repeated-building-element", "uncertain"].map(
          (label) => [label, labels.filter((value) => value === label).length],
        ),
      ),
    }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      status: "error",
      elapsed_ms: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

function runProposal(caseName: string, filtered: boolean): Promise<Record<string, unknown>> {
  return new Promise((complete) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath, "--proposal-child", caseName, filtered ? "filtered" : "raw"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      complete({ status: "timeout", elapsed_ms: PROPOSAL_TIMEOUT_MS });
    }, PROPOSAL_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdout.trim()) {
        try {
          complete(JSON.parse(stdout));
          return;
        } catch {
          // Report malformed child output below.
        }
      }
      complete({
        status: "child-error",
        exit_code: code,
        error: stderr.trim().split("\n").at(-1) || "proposal child returned no result",
      });
    });
  });
}

async function main() {
  const results = [];
  for (const caseName of Object.keys(cases)) {
    const { corpusPath, pdfPath, page, geometry } = await loadCase(caseName);
    const raw = referenceSegments(geometry);
    const degenerate = raw.filter(isDegenerate).length;
    const existingStarted = performance.now();
    const existingSoft = classifyHatchSegs(geometry.segs, geometry.meta, 1);
    const existingFamilies = hatchFamilies(geometry.segs, geometry.meta);
    const existingElapsed = Math.round(performance.now() - existingStarted);
    const geometryOnlyLabels = existingFamilies.map(
      (family) => optimisticGeometryOnlyDecision(family).label,
    );
    const rawProposal = await runProposal(caseName, false);
    const filteredProposal = degenerate > 0
      ? await runProposal(caseName, true)
      : rawProposal;
    results.push({
      case: caseName,
      source: {
        ...(corpusPath ? { corpus: corpusPath.slice(resolve(here, "..").length + 1) } : {}),
        pdf: pdfPath.slice(resolve(here, "../..").length + 1),
        page,
        segments: raw.length,
        degenerate_segments: degenerate,
        meta_bytes: geometry.meta.length,
        luminance_values: geometry.lum?.length ?? 0,
      },
      existing_classifier: {
        elapsed_ms: existingElapsed,
        soft_segments: existingSoft.reduce((sum, value) => sum + value, 0),
        families: existingFamilies.length,
        family_instances: existingFamilies.map((family) => ({
          id: family.id,
          angle_deg: family.angle_deg,
          pitch_px: family.pitch_px,
          rows: family.rows,
          segments: family.segments,
          bbox: family.bbox,
        })),
      },
      reference_classifier_on_existing_families: {
        input_note: "Optimistic perfect-lattice metrics, but only evidence emitted by the extractor.",
        labels: Object.fromEntries(
          ["hatch", "repeated-building-element", "uncertain"].map(
            (label) => [label, geometryOnlyLabels.filter((value) => value === label).length],
          ),
        ),
      },
      reference_proposal_raw: rawProposal,
      reference_proposal_without_degenerate_segments: filteredProposal,
    });
  }

  const report = {
    generated_at: new Date().toISOString(),
    proposal_timeout_ms: PROPOSAL_TIMEOUT_MS,
    results,
  };
  const outputFlag = process.argv.indexOf("--output");
  if (outputFlag >= 0) {
    const outputPath = resolve(process.argv[outputFlag + 1]);
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

if (process.argv[2] === "--proposal-child") {
  await proposalChild(process.argv[3], process.argv[4] === "filtered");
} else {
  await main();
}
