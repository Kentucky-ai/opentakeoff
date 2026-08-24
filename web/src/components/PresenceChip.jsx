// Presence chip (#317) — the coat on the chair. One honest line per teammate
// with the project open: declared name, the sheet they were last on, and how
// long ago the heartbeat landed. "Last seen", never "is editing" — a synced
// transport is minutes stale by construction and the copy must not pretend
// otherwise. Renders NOTHING when the room is empty or presence isn't wired
// (no bridge, no presence layer, other engine) — no dead chrome.
import React, { useEffect, useState } from "react";
import { parseSheetKey } from "../lib/sheets";

function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
}

function sheetLabel(sheet) {
  if (!sheet) return null;
  try {
    const { file, page } = parseSheetKey(sheet);
    const stem = file.replace(/\.pdf$/i, "");
    return page > 1 ? `${stem} p.${page}` : stem;
  } catch {
    return sheet;
  }
}

export default function PresenceChip({ bridge }) {
  const [peers, setPeers] = useState([]);

  useEffect(() => {
    if (!bridge) return;
    let unsub = null;
    // presence attaches to the bridge asynchronously (device id + provider
    // init) — poll briefly for it, then subscribe for real.
    const tryAttach = () => {
      const p = bridge.presence;
      if (!p) return false;
      setPeers(p.peers());
      unsub = p.onPeers(setPeers);
      return true;
    };
    if (tryAttach()) return () => unsub?.();
    const t = setInterval(() => { if (tryAttach()) clearInterval(t); }, 2000);
    return () => { clearInterval(t); unsub?.(); };
  }, [bridge]);

  if (!peers.length) return null;
  const first = peers[0];
  const firstSheet = sheetLabel(first.sheet);
  const line = `${first.name} has this project open — last seen ${ago(first.ageMs)}${firstSheet ? `, on ${firstSheet}` : ""}`;
  const title = peers
    .map((p) => `${p.name} — last seen ${ago(p.ageMs)}${sheetLabel(p.sheet) ? `, on ${sheetLabel(p.sheet)}` : ""}`)
    .join("\n");

  return (
    <span title={title} style={{
      display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px",
      border: "1px solid var(--ink-faint)", fontFamily: "var(--f-mono)",
      fontSize: 10.5, color: "var(--ink-muted)", maxWidth: 300,
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    }}>
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: "var(--c-positive)", flex: "none" }} />
      {peers.length === 1 ? line : `${peers.length} teammates in this project`}
    </span>
  );
}
