// StampPanel — the stamp palette (the tool-chest, #40). A docked, project-
// global panel (like the RFI register, unlike the sheet-scoped markup panel):
// the browser-global stamp library, one row per stamp with a live geometric
// preview. Click "Place" to arm a stamp — the next canvas click(s) drop it as
// normal, editable markups. Save the selected markup as a new stamp; export /
// import the whole library as JSON so a crew shares one standard set.
//
// The library and every mutation live in the PARENT (TakeoffCanvas); this view
// is pure presentation. Contract:
//   <StampPanel library armedStamp selectedMarkup
//     onArm(stamp) onSaveSelected(markup) onDelete(id) onRename(id,name)
//     onExport() onImport(file) onImportSvg(file) onClose />
import React, { useMemo, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { arrowheadPath } from "../lib/geometry.js";
import { transformPath } from "../lib/svgpath.js";
import { stampDisplayName } from "../lib/stamps.js";
import { useTranslation } from "react-i18next";

// Live preview of a stamp's elements in a small box. Element coords are OFFSETS
// (fractions of sheet w/h) from the anchor; K maps them into preview px, so a
// north arrow reads as an arrow, an approval stamp as a labeled box.
function StampPreview({ elements = [], w = 54, h = 34 }) {
  const K = 190, cx = w / 2, cy = h / 2;
  const mx = (dx) => cx + dx * K, my = (dy) => cy + dy * K;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ flex: "none", background: "var(--well)", border: "1px solid var(--ink-faint)" }}>
      {elements.map((el, i) => {
        const col = el.color || "#1f3fc7";
        if (el.type === "arrow" && el.from && el.to) {
          const [fx, fy] = [mx(el.from[0]), my(el.from[1])], [tx, ty] = [mx(el.to[0]), my(el.to[1])];
          return <g key={i}><line x1={fx} y1={fy} x2={tx} y2={ty} stroke={col} strokeWidth={1.4} /><path d={arrowheadPath(fx, fy, tx, ty, 5)} fill={col} /></g>;
        }
        if (el.type === "bubble" && el.at) {
          return <g key={i}><circle cx={mx(el.at[0])} cy={my(el.at[1])} r={Math.max(4, (Number(el.r) || 0.02) * K)} fill="none" stroke={col} strokeWidth={1.4} />{el.text ? <text x={mx(el.at[0])} y={my(el.at[1])} fill={col} fontSize={8} fontWeight="700" textAnchor="middle" dominantBaseline="central">{el.text}</text> : null}</g>;
        }
        if ((el.type === "highlight" || el.type === "cloud") && el.rect) {
          const x0 = mx(Math.min(el.rect[0][0], el.rect[1][0])), y0 = my(Math.min(el.rect[0][1], el.rect[1][1]));
          const x1 = mx(Math.max(el.rect[0][0], el.rect[1][0])), y1 = my(Math.max(el.rect[0][1], el.rect[1][1]));
          return <g key={i}><rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} fill={el.type === "highlight" ? col + "22" : "none"} stroke={col} strokeWidth={1.2} strokeDasharray={el.type === "cloud" ? "2 1.5" : undefined} />{el.text ? <text x={(x0 + x1) / 2} y={(y0 + y1) / 2} fill={col} fontSize={6} fontWeight="700" textAnchor="middle" dominantBaseline="central">{el.text}</text> : null}</g>;
        }
        if ((el.type === "callout" || el.type === "text") && el.at) {
          return <g key={i}>{el.type === "callout" && el.target ? <line x1={mx(el.target[0])} y1={my(el.target[1])} x2={mx(el.at[0])} y2={my(el.at[1])} stroke={col} strokeWidth={1.2} /> : null}<text x={mx(el.at[0])} y={my(el.at[1])} fill={col} fontSize={9} fontWeight="700" textAnchor="middle" dominantBaseline="central">{el.text || "T"}</text></g>;
        }
        if (el.type === "svg" && el.path && Array.isArray(el.vb)) {
          // vector symbol — fit the viewBox into ~80% of the thumbnail (a proper
          // preview of imported art, not the tiny K-scaled mark the primitives use).
          const [vw, vh] = el.vb;
          if (!(vw > 0 && vh > 0)) return null;
          const s = Math.min((w * 0.8) / vw, (h * 0.8) / vh);
          const bw = vw * s, bh = vh * s, x0 = (w - bw) / 2, y0 = (h - bh) / 2;
          const fillOn = el.fill && el.fill !== "none";
          return <path key={i} d={transformPath(el.path, (lx, ly) => [x0 + lx * s, y0 + ly * s])} fill={fillOn ? el.fill : "none"} stroke={col} strokeWidth={1} strokeLinejoin="round" />;
        }
        return null;
      })}
    </svg>
  );
}

export default function StampPanel({ docked = false, library = { stamps: [], sets: [] }, armedStamp, selectedMarkup, onArm, onSaveSelected, onDelete, onRename, onExport, onImport, onImportSvg, onClose }) {
  const { t } = useTranslation("panels");
  const [setFilter, setSetFilter] = useState("all");   // "all" | set id
  const [editId, setEditId] = useState(null);
  const fileRef = useRef(null);

  const stampById = useMemo(() => new Map(library.stamps.map((s) => [s.id, s])), [library.stamps]);

  // Localize built-in stamp names at render time; user-created/imported stamps
  // keep their stored names. Delegates to the shared helper in stamps.js.
  const shown = useMemo(() => {
    if (setFilter === "all") return library.stamps;
    const set = library.sets.find((s) => s.id === setFilter);
    return set ? set.stampIds.map((id) => stampById.get(id)).filter(Boolean) : [];
  }, [setFilter, library.stamps, library.sets, stampById]);

  const ctrl = { padding: "3px 8px", border: "1px solid var(--ink-faint)", background: "transparent", cursor: "pointer", fontSize: 11 };
  const chip = (id, label) => {
    const on = setFilter === id;
    return (
      <button key={id} onClick={() => setSetFilter(id)}
        style={{ padding: "2px 8px", border: `1px solid ${on ? "var(--cobalt)" : "var(--ink-faint)"}`, background: on ? "var(--cobalt)" : "transparent", color: on ? "var(--accent-contrast)" : "var(--ink)", cursor: "pointer", fontSize: 11 }}>
        {label}
      </button>
    );
  };

  const outer = docked
    ? { display: "flex", flexDirection: "column", width: "100%", height: "100%", overflow: "auto", background: "var(--paper-bright)", fontSize: 12.5 }
    : { position: "absolute", left: 14, top: 14, width: 340, maxHeight: "calc(100% - 28px)", overflow: "auto", background: "var(--paper-bright)", border: "1px solid var(--cobalt)", boxShadow: "var(--shadow-pop)", zIndex: 9, fontSize: 12.5 };
  // shared file input (both header modes wire the same import flow)
  const fileInput = (
    <input name="stamp-import-file" ref={fileRef} type="file" accept="application/json,.json,image/svg+xml,.svg" style={{ display: "none" }}
      onChange={(e) => { const f = e.target.files?.[0]; if (f) { const isSvg = /\.svg$/i.test(f.name) || f.type === "image/svg+xml"; if (isSvg) onImportSvg?.(f); else onImport(f); } e.target.value = ""; }} />
  );

  return (
    <div style={outer}>
      {docked ? (
        // docked: no blue title bar / ×; Export/Import become a slim light toolbar
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderBottom: "1px solid var(--ink-faint)" }}>
          <button onClick={onExport} title={t("stamp.export_title")} style={ctrl}>{t("stamp.export")}</button>
          <button onClick={() => fileRef.current?.click()} title={t("stamp.import_title")} style={ctrl}>{t("stamp.import")}</button>
          {fileInput}
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", borderBottom: "1px solid var(--ink-faint)", background: "var(--cobalt)", color: "var(--accent-contrast)" }}>
          <strong>{t("stamp.title")}</strong>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={onExport} title={t("stamp.export_title")} style={{ ...ctrl, border: "1px solid rgba(255,255,255,.5)", color: "var(--accent-contrast)" }}>{t("stamp.export")}</button>
            <button onClick={() => fileRef.current?.click()} title={t("stamp.import_title")} style={{ ...ctrl, border: "1px solid rgba(255,255,255,.5)", color: "var(--accent-contrast)" }}>{t("stamp.import")}</button>
            {fileInput}
            <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--accent-contrast)", fontSize: 16, cursor: "pointer" }}>×</button>
          </span>
        </div>
      )}

      <div style={{ padding: "8px 10px", color: "var(--ink-muted)" }}>
        {armedStamp
          ? <span><b style={{ color: "var(--cobalt)" }}>{t("stamp.armed_message", { name: stampDisplayName(armedStamp, t) })}</b></span>
          : <span>{t("stamp.place_message_text")}</span>}
      </div>

      {/* set filter — the model carries StampSets; the palette groups by them */}
      {library.sets.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "0 10px 8px" }}>
          {chip("all", t("stamp.all"))}
          {library.sets.map((s) => chip(s.id, (s.id === "set-flooring" ? t("stamp.set_flooring") : s.name) || t("stamp.set_default")))}
        </div>
      )}

      {/* define: save the selected markup as a new stamp */}
      <div style={{ padding: "0 10px 10px", borderBottom: "1px solid var(--ink-faint)" }}>
        <button onClick={() => selectedMarkup && onSaveSelected(selectedMarkup)} disabled={!selectedMarkup}
          title={selectedMarkup ? t("stamp.save_selected_title") : t("stamp.save_selected_none_title")}
          style={{ ...ctrl, width: "100%", padding: "6px 8px", color: selectedMarkup ? "var(--cobalt)" : "var(--ink-muted)", fontWeight: 600, cursor: selectedMarkup ? "pointer" : "not-allowed" }}>
          <Icon name="plus" size={12} /> {t("stamp.save_selected")}
        </button>
      </div>

      {shown.length === 0 && <div style={{ padding: "12px", color: "var(--ink-muted)" }}>{t("stamp.empty")}</div>}
      {shown.map((s) => {
        const armed = armedStamp?.id === s.id;
        const displayName = stampDisplayName(s, t);
        return (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderTop: "1px solid var(--ink-faint)", background: armed ? "color-mix(in srgb, var(--cobalt) 7%, transparent)" : "transparent" }}>
            <StampPreview elements={s.elements} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {editId === s.id ? (
                <input name="stamp-rename" autoComplete="off" autoFocus defaultValue={displayName}
                  onKeyDown={(e) => { if (e.key === "Enter") { onRename(s.id, e.currentTarget.value); setEditId(null); } else if (e.key === "Escape") setEditId(null); }}
                  onBlur={(e) => { onRename(s.id, e.currentTarget.value); setEditId(null); }}
                  style={{ width: "100%", fontSize: 12.5, padding: "1px 4px", border: "1px solid var(--cobalt)", outline: "none" }} />
              ) : (
                <div style={{ fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={displayName}>{displayName}</div>
              )}
              <div style={{ fontSize: 10.5, color: "var(--ink-muted)" }}>{t("stamp.element_count", { count: s.elements.length })}</div>
            </div>
            <button onClick={() => onArm(s)} title={t("stamp.place_title")}
              style={{ ...ctrl, color: armed ? "var(--accent-contrast)" : "var(--cobalt)", background: armed ? "var(--cobalt)" : "transparent", border: `1px solid var(--cobalt)`, fontWeight: 600 }}>
              {armed ? t("stamp.armed_button") : t("stamp.place_button")}
            </button>
            <button onClick={() => setEditId((id) => (id === s.id ? null : s.id))} title={t("stamp.rename_title")} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--ink-muted)" }}>✎</button>
            <button onClick={() => { if (window.confirm(t("stamp.delete_confirm", { name: displayName }))) onDelete(s.id); }} title={t("stamp.delete_title")} style={{ border: "none", background: "none", cursor: "pointer", color: "var(--c-danger)" }}>🗑</button>
          </div>
        );
      })}
    </div>
  );
}
