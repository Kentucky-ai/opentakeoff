// The in-app manual — the short version, reachable without leaving the canvas.
//
// docs/USER_GUIDE.md is 705 lines and good, and until now NOTHING in the app
// pointed at it: a first-time visitor to the demo had no way to learn that a
// manual exists. (The one icon that reads as help is the RFI hexagon, whose own
// comment calls it "a question motif".) This is the overlay that closes that
// gap — the five-minute path plus the real key bindings, with the long-form
// manual one link away.
//
// DELIBERATELY NOT a rendering of the markdown. Bundling a parser to re-display
// a document that lives in the repo buys a dependency and a second thing to
// keep true; what an estimator needs mid-trace is the shortcut and the next
// step, not sixteen sections. The bindings below are transcribed from
// USER_GUIDE.md §15, which is itself maintained against the code — if a
// shortcut changes, §15 and this table move together.
import { oneClickEnabled, commandBoxEnabled } from "../lib/gate.js";
import { useEffect } from "react";
import { Z } from "../lib/ui.js";
import { keyLabel, keyText, isApplePlatform } from "../lib/keys.ts";

const GUIDE_URL = "https://github.com/Kentucky-ai/opentakeoff/blob/main/docs/USER_GUIDE.md";

function Kbd({ children }) {
  return (
    <kbd style={{
      fontFamily: "var(--f-mono)", fontSize: 11, padding: "2px 6px", border: "1px solid var(--ink-faint)",
      borderBottomWidth: 2, borderRadius: 5, background: "var(--paper-bright)", color: "var(--ink)", whiteSpace: "nowrap",
    }}>{children}</kbd>
  );
}

function Keys({ combo }) {
  // Labels only — the handlers already treat ⌘ and Ctrl as one key. See lib/keys.ts.
  const apple = isApplePlatform();
  return (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
      {combo.map((k, i) => <Kbd key={i}>{keyLabel(k, apple)}</Kbd>)}
    </span>
  );
}

function Table({ rows }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "7px 14px", alignItems: "baseline" }}>
      {rows.map(([combo, what], i) => (
        <div key={i} style={{ display: "contents" }}>
          <div style={{ justifySelf: "start" }}><Keys combo={combo} /></div>
          <div style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>{keyText(what)}</div>
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 26 }}>
      <div className="t-label" style={{ marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

const START = [
  ["Open a plan", "Drag a PDF, an image, or a whole .zip plan set onto the canvas — or click Load sample plan to use the bundled VA finish plan. Nothing leaves your machine."],
  ["Set the scale first", "Every quantity depends on it. The Scale menu offers what the sheet's own title block states; hover it to preview a calibrated ruler on the drawing, or calibrate two points of a known dimension. Remembered per sheet."],
  ["Add a condition", "A condition is a finish — CPT-1, LVT, base. Give it a tag, a waste %, and a colour. Press 1–9 to arm one."],
  ["Measure", oneClickEnabled() ? "One-Click a room and it selects itself; or trace by hand with Area, Rectangle, Linear or Count. In One-Click, ⏎ creates it." : "Trace by hand with Area, Rectangle, Linear or Count — click the corners, ⏎ closes the shape. (One-Click Area is temporarily gated while the flood engine is re-validated.)"],
  ["Read the report", "REPORT totals every condition, applies waste, and gives you order quantities, a buy list, and CSV / Excel export."],
];

export const TOOLS = [
  ...(oneClickEnabled() ? [[["O"], "One-Click Area — click inside a room, it selects itself"]] : []),
  [["A"], "Area"], [["R"], "Rectangle"], [["L"], "Linear"], [["Q"], "Straight ⇄ Curve (mid-trace)"],
  [["S"], "Surface Area (walls)"], [["C"], "Count"],
  [["D"], "Deduct shape (Cut Out)"], [["⇧", "D"], "Deduct rectangle"],
  [["H"], "Highlighter"], [["K"], "Check a dimension against what the drawing says"],
  [["N"], "Dimension line — a standalone length label at the sheet's scale (markup, never counted)"],
  [["V"], "Select"], [["G"], "Sheet gallery"],
  [["1", "–", "9"], "Arm condition N"],
  ...(commandBoxEnabled() ? [[["hold", "M"], "Push-to-talk dictation — release runs it, Esc discards"]] : []),
];

export const DRAW = [
  [["⏎"], oneClickEnabled() ? "Finish the shape. In One-Click: Create the selection" : "Finish the shape"],
  [["⌫"], "Back out one step — the last point, then the picked vertex, the region, the selected shape, the markup"],
  [["⌘", "Z"], "Mid-trace pops the last point; otherwise undo"],
  [["⇧", "⌘", "Z"], "Redo"],
  [["Esc"], "Back out one level — vertex pick first, then anything in progress"],
  [["hold", "⇧"], "Force the 45° angle lock at any cursor angle"],
  ...(oneClickEnabled() ? [[["⌥", "click"], "In One-Click: carve a cutout inside a selected space"]] : []),
  [["⇧", "click"], "Insert a vertex at an edge midpoint, and drag it"],
  [["⌘", "C"], "Copy"], [["⌘", "V"], "Paste under the cursor"], [["⌘", "D"], "Duplicate"],
];

export const VIEW = [
  [["scroll"], "Zoom toward the cursor"],
  [["two-finger"], "Pan, both axes"],
  [["⇧", "scroll"], "Pan"],
  [["hold", "Space"], "Pan with any tool armed — as does middle-drag or right-drag"],
  [["F"], "Focus mode — collapse the chrome, trade it for canvas height"],
  [["?"], "Open this guide"],
];

export default function UserGuide({ onClose }) {
  // The dialog closes ITSELF, and that is not a style preference. The canvas's
  // Escape chain lives in an effect that early-returns while the plan-set
  // gallery is up — so a guide dismissed from there would have swallowed the
  // key and stayed open, which is precisely the first-time visitor who came
  // looking for the manual. Owning the key here makes dismissal independent of
  // whatever view is behind. Capture phase + stopPropagation so the same press
  // cannot also back out of a trace the user cannot see behind the overlay.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: Z.modal, background: "var(--scrim)",
        display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", overflow: "auto",
      }}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="OpenTakeoff user guide"
        className="panel"
        style={{
          width: "min(760px, 100%)", background: "var(--paper-bright)", color: "var(--ink)",
          border: "1px solid var(--ink-faint)", borderRadius: 0, padding: "22px 26px 26px",
          boxShadow: "var(--shadow-2)",
        }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 17, letterSpacing: "-0.02em" }}>How OpenTakeoff works</strong>
          <button onClick={onClose} title="Close (Esc)"
            style={{ background: "none", border: "none", color: "var(--ink-soft)", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5, margin: "0 0 22px" }}>
          A takeoff canvas that runs entirely in your browser — no account, no upload, no install. Open a plan,
          set the scale, measure the finishes, export a priced quantity report.
        </p>

        <Section title="Five minutes to a takeoff">
          <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 9 }}>
            {START.map(([t, d]) => (
              <li key={t} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                <strong style={{ color: "var(--ink)" }}>{t}</strong>
                <span style={{ color: "var(--ink-soft)" }}> — {keyText(d)}</span>
              </li>
            ))}
          </ol>
        </Section>

        <Section title="Tools"><Table rows={TOOLS} /></Section>
        <Section title="Drawing & editing"><Table rows={DRAW} /></Section>
        <Section title="Getting around"><Table rows={VIEW} /></Section>

        <div style={{ borderTop: "1px solid var(--ink-faint)", paddingTop: 14, fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>
          This is the short version. The full manual covers conditions, markups and RFIs, revisions,
          the report and exports, the Agent panel, and driving OpenTakeoff from an AI agent over MCP —{" "}
          <a href={GUIDE_URL} target="_blank" rel="noreferrer" style={{ color: "var(--cobalt)" }}>read the complete guide</a>.
        </div>
      </div>
    </div>
  );
}
