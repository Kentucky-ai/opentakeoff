import { preflightTakeoff } from "./preflight.mjs";
import { legacyId, draftId } from "./validation.mjs";

/** Opt-in document conversion only. Never imports into a session or grants
 * authority. Every refusal omits document; every success returns detached data. */
export function adaptTakeoff(record, targetSchema) {
  const preflight = preflightTakeoff(record);
  if (![legacyId, draftId].includes(targetSchema)) {
    return {
      status: "refused", targetSchema: null,
      preflight: { ...preflight, status: "invalid", issues: [...preflight.issues, {
        severity: "error", code: "unsupported_target", path: "",
        message: "Choose the current canvas or draft TakeoffDocument identifier as target.",
      }] },
      preservation: { checked: false },
    };
  }
  const refuse = report => ({ status: "refused", targetSchema, preflight: report, preservation: { checked: false } });
  if (preflight.status !== "eligible") return refuse(preflight);

  // Preflight has excluded JSON values/properties that stringify would alter.
  // JSON cloning preserves opaque keys (including __proto__) as data, detaches
  // every nested value, and does not carry JavaScript prototypes or aliases.
  const sourceJson = JSON.stringify(record);
  const document = JSON.parse(sourceJson);
  document.schema = targetSchema;
  const targetCheck = preflightTakeoff(document);
  if (targetCheck.status !== "eligible") return refuse(targetCheck);
  // Compare all JSON values, array order, keys and omissions after reversing
  // the sole permitted change. Never return a partially preserved document.
  if (JSON.stringify({ ...document, schema: record.schema }) !== sourceJson) {
    return refuse({ ...preflight, status: "invalid", issues: [...preflight.issues, {
      severity: "error", code: "preservation_failed", path: "",
      message: "Conversion did not preserve all JSON data outside the schema identifier.",
    }] });
  }
  return {
    status: record.schema === targetSchema ? "unchanged" : "converted",
    sourceSchema: record.schema, targetSchema, preflight,
    preservation: {
      checked: true, scope: "json-values-except-schema",
      changedPaths: record.schema === targetSchema ? [] : ["/schema"], droppedPaths: [],
    },
    document,
  };
}
