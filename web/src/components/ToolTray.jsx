// The dock's ⋯ tray — every tool that doesn't earn a place on the dock itself,
// laid out at once in labeled columns (Measure · Check & find · Mark up ·
// Scale · Aids), each tile an icon over its short name. The layout Premium
// uses: the dock stays small, and nothing hides in a second-level menu.
//
// Items are the same shape ToolMenu takes ({ id, icon | iconNode, label,
// shortcut, active, disabled, title, onSelect }), so a tool can move between a
// menu and the tray without its handler changing.
import { Icon } from "../brand/icons.jsx";
import { keyText } from "../lib/keys.ts";
import "./toolTray.css";

export default function ToolTray({ groups, onPicked }) {
  return (
    <div className="ot-tray" id="ot-tool-tray" role="region" aria-label="More tools" onPointerDown={(e) => e.stopPropagation()}>
      {groups.filter(([, items]) => items.length).map(([heading, items]) => (
        <div key={heading} className="ot-tray-col" role="group" aria-label={heading}>
          <div className="ot-tray-h">{heading}</div>
          <div className="ot-tray-grid" style={{ gridTemplateRows: `repeat(${Math.min(3, items.length)}, auto)` }}>
            {items.map((it) => (
              <button key={it.id} type="button" className="ot-tray-tile" data-active={it.active || undefined} disabled={!!it.disabled}
                aria-pressed={it.active ? true : undefined}
                title={`${it.title || it.label}${it.shortcut ? ` (${keyText(it.shortcut)})` : ""}`}
                onClick={() => { if (it.disabled) return; it.onSelect?.(); if (!it.stayOpen) onPicked?.(it); }}>
                <span className="ot-tray-ic" aria-hidden="true">{it.iconNode || <Icon name={it.icon} size={18} />}</span>
                <span className="ot-tray-label">{it.short || it.label}</span>
                {it.count > 0 && <span className="ot-tray-n">{it.count}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
