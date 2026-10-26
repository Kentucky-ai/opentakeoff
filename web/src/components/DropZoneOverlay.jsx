// The ghost-half + label shown while a tab is dragged over a pane. `zone` is
// the live dropZoneAt() result; null hides the overlay.
import { zoneToOrientation } from "../lib/dropZones";

export default function DropZoneOverlay({ zone }) {
  if (!zone) return null;
  const orient = zoneToOrientation(zone);
  const half = {
    left:   { left: 0, top: 0, width: "50%", height: "100%" },
    right:  { right: 0, top: 0, width: "50%", height: "100%" },
    top:    { left: 0, top: 0, width: "100%", height: "50%" },
    bottom: { left: 0, bottom: 0, width: "100%", height: "50%" },
    center: { left: 0, top: 0, width: "100%", height: "100%" },
  }[zone];
  const label = zone === "center" ? "Add to group"
    : orient === "v" ? "◧ Split Vertical" : "⬓ Split Horizontal";
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 20 }}>
      <div style={{ position: "absolute", ...half, background: "var(--cobalt, #2f6fed)", opacity: 0.18, transition: "all .08s ease" }} />
      <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)", padding: "4px 10px",
        background: "var(--ink, #222)", color: "var(--paper-bright, #fff)", font: "12px var(--f-body, sans-serif)", borderRadius: 0 }}>{label}</div>
    </div>
  );
}
