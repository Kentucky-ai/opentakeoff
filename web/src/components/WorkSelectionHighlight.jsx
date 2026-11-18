import { SVG } from "../lib/ui.js";
import { workSelectionPaths } from "../lib/workSelection.js";
import { localizeText as uiText } from "../lib/i18n/core.js";

// View-only cue around existing measurements, never an annotation or a count.
// Pixel widths are screen-space so selection stays legible at any zoom.
export default function WorkSelectionHighlight({ shapes, panel, zoom, color }) {
  return <g aria-label={uiText("Selected measurements")} pointerEvents="none">
    {shapes.filter((shape) => shape.sheet_id === panel.key).map((shape) => {
      const paths = workSelectionPaths(shape, panel);
      let glyph;
      if (shape.measure_role === "count") {
        const [cx, cy] = paths[0][0];
        glyph = <circle cx={cx} cy={cy} r={15 / zoom} />;
      } else if (["linear", "surface_area"].includes(shape.measure_role)) {
        glyph = <polyline points={paths[0].map((p) => p.join(",")).join(" ")} />;
      } else {
        glyph = <path d={paths.map((ring) => `M${ring.map((p) => p.join(",")).join("L")}Z`).join("")} />;
      }
      return <g key={shape.id} data-work-selection-id={shape.id} fill="none" strokeLinejoin="round">
        <g stroke={SVG.selectionHalo} strokeWidth={7 / zoom}>{glyph}</g>
        <g stroke={color} strokeWidth={3 / zoom} strokeDasharray={`${6 / zoom} ${3 / zoom}`}>{glyph}</g>
      </g>;
    })}
  </g>;
}
