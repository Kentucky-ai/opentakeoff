// Read page text (#471): the canvas's control for reading a scan (a sheet
// with little or no text layer, planIndex indexIsScanLike)
// on-device. One row per sheet on screen whose view (lib/ocr/pageRead
// pageReadView) isn't hidden, named in a group, plus a row for each read
// still running on a sheet that left the screen (lib/ocr/pageRead
// backgroundRows), so it can still be cancelled. The canvas owns pointer
// handling and places it with readControlPlacement; this is a pure function
// of its props. Only the status text is a live region, never a row that
// holds buttons.
//
//   rows: [{ key, label, view, background? }]   view: pageReadView's answer
//   onRead(key) · onReadAgain(key) · onCancel(key) · onRetry() (probe again)
import { S } from "../lib/ui.js";
import { CANVAS_EDGE, FLOAT_GAP } from "../lib/canvasConstants.js";

/** The canvas's bottom-left corner cluster (fit, invert, focus): CANVAS_EDGE
 * from the edge, this wide, and the gap this control keeps from it. */
export const CORNER_TILE = 34;
export const CORNER_GAP = 8;
export const READ_CONTROL_LEFT = CANVAS_EDGE + CORNER_TILE + CORNER_GAP;
export const READ_CONTROL_MAX_W = 360;

/** Beside the corner cluster at the canvas's bottom edge; while the
 * bottom-centre rule banner shows (its measured height), stacked above it so
 * the two never overlap. */
export function readControlPlacement({ bannerHeight }) {
  const bottom = bannerHeight > 0 ? CANVAS_EDGE + bannerHeight + FLOAT_GAP : CANVAS_EDGE;
  return { position: "absolute", left: READ_CONTROL_LEFT, bottom };
}

const btn = { padding: "2px var(--sp-2)", fontSize: "var(--fs-xs)" };

function RowBody({ row, onRead, onReadAgain, onCancel, onRetry }) {
  const { key, view } = row;
  switch (view.kind) {
    case "read":
      return (<>
        <button type="button" className="btn-ghost" style={btn} onClick={() => onRead(key)}>Read page text</button>
        {view.note && <span aria-live="polite" style={{ color: "var(--c-danger)", whiteSpace: "normal" }}>{view.note}</span>}
      </>);
    case "reading":
      return (<>
        <span className="pip" aria-hidden="true" />
        <span aria-live="polite">{view.text}</span>
        <button type="button" className="btn-ghost" style={btn} onClick={() => onCancel(key)}>Cancel</button>
      </>);
    case "stopping":
      return <span aria-live="polite" style={{ color: "var(--ink-muted)" }}>{view.text}</span>;
    case "unreadable":
      return <span aria-live="polite" style={{ color: "var(--c-danger)", whiteSpace: "normal" }}>{view.text}</span>;
    case "unreachable":
      return (<>
        <span aria-live="polite" style={{ color: "var(--c-danger)", whiteSpace: "normal" }}>{view.text}</span>
        <button type="button" className="btn-ghost" style={btn} onClick={() => onRetry?.()}>Retry</button>
      </>);
    case "done":
      return (<>
        <span aria-live="polite">{view.text}</span>
        {view.readAgain && <button type="button" className="btn-ghost" style={btn} onClick={() => onReadAgain(key)}>Read again</button>}
      </>);
    default:
      return null;
  }
}

export default function PageReadControl({ rows, onRead, onReadAgain, onCancel, onRetry }) {
  const shown = (rows || []).filter((r) => r.view.kind !== "hidden");
  if (!shown.length) return null;
  const labelled = rows.filter((r) => !r.background).length > 1;
  return (
    <div role="group" aria-label="Read page text" data-page-read="" style={{ display: "flex", flexDirection: "column", gap: "var(--sp-1)", padding: "var(--sp-1) var(--sp-2)", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", boxShadow: "var(--shadow-1)", maxWidth: READ_CONTROL_MAX_W }}>
      {shown.map((row) => (
        <div key={row.key} style={{ ...S.monoReadout, fontSize: "var(--fs-xs)", display: "flex", alignItems: "center", gap: "var(--sp-2)", whiteSpace: "nowrap" }}>
          {labelled && !row.background && <span style={{ ...S.monoLabel, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{row.label}</span>}
          <RowBody row={row} onRead={onRead} onReadAgain={onReadAgain} onCancel={onCancel} onRetry={onRetry} />
        </div>
      ))}
    </div>
  );
}
