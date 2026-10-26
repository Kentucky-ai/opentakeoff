// Tools whose click places the RAW cursor: selection gestures, where a corner
// snapped to a vector endpoint would shift the box off what the estimator
// aimed at. Select does its own endpoint snap on drop.
const RAW_CURSOR_TOOLS: ReadonlySet<string> = new Set(["select", "schedule", "image", "pin", "textcopy"]);

// Does Snap pull this tool onto vector endpoints? One rule for the preview
// (moveCrosshair: crosshair, box corner, snap star, "snap" chip) and the
// click, so the corner a tool shows is the corner it places.
export function snapsToVectors(tool: string): boolean {
  return !RAW_CURSOR_TOOLS.has(tool);
}
