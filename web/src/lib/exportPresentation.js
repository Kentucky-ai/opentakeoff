import { csvEsc } from "./csv.js";
import { FLOORING_DEFAULTS } from "./canvasConstants.js";
import { finishLabel } from "./i18n/core.js";

const seededMaterials = new Set(FLOORING_DEFAULTS.flatMap(c => (c.materials || []).map(m => m.name)));
const seededNotes = new Set(FLOORING_DEFAULTS.flatMap(c => (c.materials || []).map(m => m.note).filter(Boolean)));
const units = new Set(["SF", "SY", "LF", "EA", "ft", "in", "m", "m2", "m²", "mm", "gal", "l", "L", "bag", "tube", "roll", "each", "unit", "pc", "lb", "kg"]);

// Localize labels explicitly, while project names, IDs, notes and custom values
// stay data. CSV formatting sees the original JS type before serialization.
export function createExportPresentation({ language = "en", localize = value => value } = {}) {
  const russian = language === "ru";
  const label = value => russian ? localize(value) : value;
  const delimiter = russian ? ";" : ",";
  const cell = value => {
    if (russian && typeof value === "number") return String(value).replace(".", ",");
    return csvEsc(value, delimiter);
  };
  return {
    label,
    finish: value => russian ? finishLabel(value, "ru") : value,
    material: value => seededMaterials.has(value) ? label(value) : value,
    note: value => seededNotes.has(value) ? label(value) : value,
    unit: value => units.has(value) ? label(value) : value,
    coverage: (value, unit) => units.has(unit) ? label(value) : value,
    row: values => values.map(cell).join(delimiter),
    header: values => values.map(label).map(cell).join(delimiter),
    document: lines => (russian ? "\uFEFF" : "") + lines.join(russian ? "\r\n" : "\n") + (russian ? "\r\n" : "\n"),
  };
}
