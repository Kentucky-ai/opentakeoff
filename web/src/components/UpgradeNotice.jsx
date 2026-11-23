// UpgradeNotice: one-line, dismissible notice that OpenTakeoff moves to a new
// format and desktop app on December 1, 2026. Full text lives in UPGRADE.md.
// Dismissal is per-browser (localStorage); blocked storage just means the
// notice shows again next load.
import { useState } from "react";

export const UPGRADE_DISMISS_KEY = "ot.upgradeNotice.dec2026.dismissed";
export const UPGRADE_URL = "https://github.com/Kentucky-ai/opentakeoff/blob/main/UPGRADE.md";
export const LOGIN_URL = "https://kentucky-ai.com";

function readDismissed() {
  try { return localStorage.getItem(UPGRADE_DISMISS_KEY) === "1"; } catch { return false; }
}

export default function UpgradeNotice() {
  const [hidden, setHidden] = useState(readDismissed);
  if (hidden) return null;
  const dismiss = () => {
    try { localStorage.setItem(UPGRADE_DISMISS_KEY, "1"); } catch { /* storage blocked */ }
    setHidden(true);
  };
  const link = { color: "var(--cobalt)", fontWeight: 600 };
  return (
    <div role="status" aria-label="OpenTakeoff upgrade notice" data-testid="upgrade-notice"
      style={{
        position: "fixed", left: "50%", top: 64, transform: "translateX(-50%)", zIndex: 9000,
        width: "min(720px, calc(100vw - 32px))", display: "flex", alignItems: "center", gap: 12,
        padding: "10px 12px 10px 16px", background: "var(--paper-bright)", color: "var(--ink)",
        border: "1px solid var(--cobalt)", borderRadius: "var(--r-1)", boxShadow: "var(--shadow-pop)",
        fontSize: 13, lineHeight: 1.4,
      }}>
      <span style={{ flex: 1 }}>
        <strong>The new OpenTakeoff app launches Dec 1.</strong>{" "}
        Takeoff stays free and open source, and your projects come with you.{" "}
        <a href={LOGIN_URL} target="_blank" rel="noopener noreferrer" style={link}>Create your free login at kentucky-ai.com</a>
        {" · "}
        <a href={UPGRADE_URL} target="_blank" rel="noopener noreferrer" style={link}>Read more</a>
      </span>
      <button type="button" onClick={dismiss} aria-label="Dismiss upgrade notice"
        style={{ border: 0, background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 4 }}>×</button>
    </div>
  );
}
