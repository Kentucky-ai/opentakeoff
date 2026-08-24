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
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Z } from "../lib/ui.js";

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
  return (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
      {combo.map((k, i) => <Kbd key={i}>{k}</Kbd>)}
    </span>
  );
}

function Table({ rows }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "7px 14px", alignItems: "baseline" }}>
      {rows.map(([combo, what], i) => (
        <div key={i} style={{ display: "contents" }}>
          <div style={{ justifySelf: "start" }}><Keys combo={combo} /></div>
          <div style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.45 }}>{what}</div>
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

// These are defined outside the component for stable references, but translated at render time via the t() wrapper inside UserGuide.

const _START = [
  ["start.open_plan", "start.open_plan_desc"],
  ["start.set_scale", "start.set_scale_desc"],
  ["start.add_condition", "start.add_condition_desc"],
  ["start.measure", "start.measure_desc"],
  ["start.read_report", "start.read_report_desc"],
];

const _TOOLS = [
  [["O"], "tools.oneclick"],
  [["A"], "tools.area"], [["R"], "tools.rectangle"], [["L"], "tools.linear"], [["Q"], "tools.curved"],
  [["S"], "tools.surface"], [["C"], "tools.count"],
  [["D"], "tools.deduct"], [["⇧", "D"], "tools.deduct_rect"],
  [["H"], "tools.highlighter"], [["K"], "tools.calibrate"],
  [["V"], "tools.select"], [["G"], "tools.gallery"],
  [["1", "–", "9"], "tools.arm_condition"],
  [["hold", "M"], "tools.dictation"],
];

const _DRAW = [
  [["⏎"], "draw.finish"],
  [["⌫"], "draw.backspace"],
  [["⌘", "Z"], "draw.undo"],
  [["⇧", "⌘", "Z"], "draw.redo"],
  [["Esc"], "draw.escape"],
  [["hold", "⇧"], "draw.shift_hold"],
  [["⌥", "click"], "draw.option_click"],
  [["⇧", "click"], "draw.shift_click"],
  [["⌘", "C"], "draw.copy"], [["⌘", "V"], "draw.paste"], [["⌘", "D"], "draw.duplicate"],
];

const _VIEW = [
  [["scroll"], "view.scroll"],
  [["two-finger"], "view.two_finger"],
  [["⇧", "scroll"], "view.shift_scroll"],
  [["hold", "Space"], "view.space_hold"],
  [["F"], "view.focus"],
  [["?"], "view.help"],
];

// Legacy exports (translated via the t() calls in UserGuide)
export const TOOLS = _TOOLS;
export const DRAW = _DRAW;
export const VIEW = _VIEW;

export default function UserGuide({ onClose }) {
  const { t } = useTranslation("guide");
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

  const start = useMemo(() => _START.map(([titleKey, descKey]) => [t(titleKey), t(descKey)]), [t]);
  const tools = useMemo(() => _TOOLS.map(([combo, key]) => [combo, t(key)]), [t]);
  const draw = useMemo(() => _DRAW.map(([combo, key]) => [combo, t(key)]), [t]);
  const view = useMemo(() => _VIEW.map(([combo, key]) => [combo, t(key)]), [t]);

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
        aria-label={t("aria_label")}
        className="panel"
        style={{
          width: "min(760px, 100%)", background: "var(--paper-bright)", color: "var(--ink)",
          border: "1px solid var(--ink-faint)", borderRadius: 0, padding: "22px 26px 26px",
          boxShadow: "var(--shadow-2)",
        }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
          <strong style={{ fontFamily: "var(--f-display)", fontSize: 17, letterSpacing: "-0.02em" }}>{t("title")}</strong>
          <button onClick={onClose} title={t("close_title")}
            style={{ background: "none", border: "none", color: "var(--ink-soft)", fontSize: 18, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5, margin: "0 0 22px" }}>
          {t("description")}
        </p>

        <Section title={t("section.quick_start")}>
          <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 9 }}>
            {start.map(([title, desc], i) => (
              <li key={i} style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                <strong style={{ color: "var(--ink)" }}>{title}</strong>
                <span style={{ color: "var(--ink-soft)" }}> — {desc}</span>
              </li>
            ))}
          </ol>
        </Section>

        <Section title={t("section.tools")}><Table rows={tools} /></Section>
        <Section title={t("section.drawing")}><Table rows={draw} /></Section>
        <Section title={t("section.navigation")}><Table rows={view} /></Section>

        <div style={{ borderTop: "1px solid var(--ink-faint)", paddingTop: 14, fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.5 }}>
          {t("footer_intro")}{" "}
          <a href={GUIDE_URL} target="_blank" rel="noreferrer" style={{ color: "var(--cobalt)" }}>{t("footer_link")}</a>.
        </div>
      </div>
    </div>
  );
}
