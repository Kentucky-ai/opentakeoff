// The bundled demo plan — a real, publicly released VA floor finish plan
// (St. Cloud VA Medical Center, sheets AF101 + AF600). One fetch path, shared by
// the empty canvas's "Load sample plan" and the guided first takeoff, so both
// hand the ingest exactly the same File.

export const SAMPLE_PLAN_NAME = "sample-finish-plan.pdf";

export function samplePlanUrl() {
  const base = import.meta.env?.BASE_URL || "/";
  return `${base}demo/${SAMPLE_PLAN_NAME}`;
}

export async function fetchSamplePlan() {
  const res = await fetch(samplePlanUrl());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return new File([blob], SAMPLE_PLAN_NAME, { type: "application/pdf" });
}
