// The guided first takeoff — a small card docked over the canvas that walks a
// new user through one real takeoff: open the sample plan, set its scale, arm
// Area, trace a room, open the Report.
//
// Hands-on by design. The card never does a step for you and has no "Next"
// button: each step completes when the canvas sees you do it (the rules live in
// lib/firstTakeoff.js). It is NOT a modal — no scrim, no focus trap, no key
// capture — so every canvas shortcut it teaches (A, ⏎, scroll-zoom) works while
// it is up. The spotlight ring around the control a step names is
// pointer-events:none for the same reason.
import { useEffect, useState } from "react";
import { Z } from "../lib/ui.js";
import { keyText } from "../lib/keys.ts";
import { TOUR_STEPS } from "../lib/firstTakeoff.js";

// Outline the first VISIBLE element matching `selector`. Polled rather than
// observed: the target can move with panel docking, layout switches and the
// toolbar's own scroll, and a 250 ms poll of one getBoundingClientRect is
// cheaper than reasoning about every one of those.
function Spotlight({ selector }) {
  const [rect, setRect] = useState(null);
  useEffect(() => {
    if (!selector) { setRect(null); return; }
    const read = () => {
      // a tag on a control's inner label outlines the control itself
      const el = [...document.querySelectorAll(selector)].map((n) => n.closest("button") || n).find((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const r = el?.getBoundingClientRect();
      setRect((prev) => {
        if (!r) return null;
        if (prev && prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height) return prev;
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      });
    };
    read();
    const id = setInterval(read, 250);
    return () => clearInterval(id);
  }, [selector]);
  if (!rect) return null;
  const pad = 4;
  return (
    <div aria-hidden="true" className="ot-tour-spotlight" style={{
      position: "fixed", left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2,
      border: "2px solid var(--cobalt)", borderRadius: 6, pointerEvents: "none", zIndex: Z.toast,
      boxShadow: "0 0 0 4px color-mix(in srgb, var(--cobalt) 25%, transparent)",
    }} />
  );
}

const fmtSf = (n) => `${Math.round(n).toLocaleString()} SF`;

export default function FirstTakeoffTour({ done, step, sheetOpen, sampleBusy, onLoadSample, onClose, onConnect, result }) {
  const doneSet = new Set(done);
  const n = TOUR_STEPS.findIndex((s) => s.id === step?.id);
  const finished = !step;
  return (
    <>
      <style>{`
        @keyframes ot-tour-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
        .ot-tour-spotlight { animation: ot-tour-pulse 1.4s ease-in-out infinite }
        @media (prefers-reduced-motion: reduce) { .ot-tour-spotlight { animation: none } }
      `}</style>
      {!finished && <Spotlight selector={step.target} />}
      <section
        role="region" aria-label="Guided first takeoff" aria-live="polite"
        style={{
          position: "fixed", left: "calc(var(--rail-w, 52px) + 14px)", bottom: 38,
          // in progress it sits under every menu and dialog; the done card rises
          // over the Report (z 50, which is where the last step lands you) but
          // stays under the Report's own popovers (60+)
          zIndex: finished ? Z.modal + 5 : Z.drawer + 1,
          width: "min(340px, calc(100vw - var(--rail-w, 52px) - 28px))",
          background: "var(--paper-bright)", color: "var(--ink)", border: "1px solid var(--ink-faint)",
          boxShadow: "var(--shadow-2)", padding: "14px 16px 14px", fontFamily: "var(--f-body)",
        }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
          <span className="t-label" style={{ color: "var(--cobalt)" }}>
            {finished ? "First takeoff — done" : `First takeoff · step ${n + 1} of ${TOUR_STEPS.length}`}
          </span>
          <button type="button" onClick={onClose} title="End the guided takeoff" aria-label="End the guided takeoff"
            style={{ background: "none", border: "none", color: "var(--ink-soft)", fontSize: 17, cursor: "pointer", lineHeight: 1, padding: 2 }}>×</button>
        </div>

        {finished ? (
          <div style={{ marginTop: 8 }}>
            <strong style={{ fontFamily: "var(--f-display)", fontSize: 16 }}>
              {result?.sf ? `You measured ${fmtSf(result.sf)}${result.tag ? ` of ${result.tag}` : ""}.` : "That's a takeoff."}
            </strong>
            <p style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--ink-soft)", margin: "6px 0 12px" }}>
              Same loop for every finish: pick a condition, trace, read the Report. Press <kbd>?</kbd> any time for the shortcuts.
              Next, hand the same engine to an AI agent.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={onConnect}
                style={{ padding: "8px 13px", border: "none", background: "var(--cobalt)", color: "var(--accent-contrast)", fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>
                Connect your AI
              </button>
              <button type="button" onClick={onClose}
                style={{ padding: "8px 13px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", fontSize: 12.5, cursor: "pointer" }}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <strong style={{ display: "block", marginTop: 6, fontFamily: "var(--f-display)", fontSize: 16 }}>{step.title}</strong>
            <p style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--ink-soft)", margin: "5px 0 0" }}>{keyText(step.body)}</p>
            {step.id === "open" && !sheetOpen && (
              <button type="button" onClick={onLoadSample} disabled={sampleBusy}
                style={{ marginTop: 11, padding: "8px 13px", border: "none", background: "var(--cobalt)", color: "var(--accent-contrast)", fontWeight: 700, fontSize: 12.5, cursor: sampleBusy ? "default" : "pointer", opacity: sampleBusy ? 0.65 : 1 }}>
                {sampleBusy ? "Loading sample…" : "Load the sample plan"}
              </button>
            )}
          </>
        )}

        <ol aria-label="Steps" style={{ listStyle: "none", margin: "13px 0 0", padding: "10px 0 0", borderTop: "1px solid var(--ink-faint)", display: "flex", gap: 6 }}>
          {TOUR_STEPS.map((s, i) => {
            const isDone = doneSet.has(s.id);
            const isNow = s.id === step?.id;
            return (
              <li key={s.id} title={s.title} aria-current={isNow ? "step" : undefined}
                style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, fontSize: 10, fontFamily: "var(--f-mono)", color: isDone ? "var(--c-positive)" : isNow ? "var(--cobalt)" : "var(--ink-muted)" }}>
                <span style={{ height: 3, background: isDone ? "var(--c-positive)" : isNow ? "var(--cobalt)" : "var(--ink-faint)" }} />
                {isDone ? "✓ " : `${i + 1} `}{s.title.split(" ").slice(-1)[0].toLowerCase()}
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}
