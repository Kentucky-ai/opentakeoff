// SPDX-License-Identifier: AGPL-3.0-only
// The 3D view's doorway: three.js (≈150 kB gz) is fetched only when someone presses the canvas's 3D
// button — the canvas bundle never carries it. A failed chunk load (a stale deploy's hashed file
// is gone) closes the overlay with a message instead of a white screen — Kevin Murphy's pattern
// from OpenTakeoff feat/3d-takeoff-view, kept.
import React, { Suspense, lazy } from "react";
import { createPortal } from "react-dom";
import { Z } from "../lib/ui.js";

const View3D = lazy(() => import("./View3D.jsx"));

class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { this.props.onFail?.(String(error?.message || error)); }
  render() { return this.state.error ? null : this.props.children; }
}

export default function Lazy3D(props) {
  // portalled to <body>: the canvas container captures every left press (setPointerCapture), which
  // would swallow the overlay's clicks if it rendered inside it
  // React events still bubble through a portal to the canvas's handlers: stop them at the root
  const stop = (e) => e.stopPropagation();
  return createPortal(
    <div data-view3d-root onPointerDown={stop} onPointerUp={stop} onPointerMove={stop} onClick={stop} onDoubleClick={stop} onWheel={stop} onContextMenu={stop}>
    <Boundary onFail={(msg) => { props.onFail?.(msg); props.onClose?.(); }}>
      <Suspense fallback={<div style={{ position: "fixed", inset: 0, zIndex: Z.modal, background: "rgba(13,21,38,.55)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>Loading the 3D view…</div>}>
        <View3D {...props} />
      </Suspense>
    </Boundary>
    </div>,
    document.body,
  );
}
