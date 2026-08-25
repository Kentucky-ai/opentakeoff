// Layer panel (#85 phase 2) — the docked right-rail surface for the sheet's
// PDF layer table (Optional Content Groups): every layer the drawing STATES,
// with its classified role, and a per-layer Auto / Wall / Off control feeding
// the One-Click mask's role short-circuit — so an estimator can say "ignore
// demolition and furniture for my clicks" the way an agent already can via
// the MCP `layers {include, exclude}` filters (identical semantics, one
// engine seam). Display is untouched: this governs what a flood treats as
// boundary, never what the sheet renders.
//
// The rail button that opens this panel renders ONLY when an open sheet
// actually carries layers — most exporters flatten Optional Content, and the
// common case earns zero chrome. A pure view: the classified tables and the
// override map live in the canvas (overrides persist per sheet, additive
// `layer_overrides` payload key); every mutation goes up through onOverride.
import { Icon } from "../brand/icons.jsx";
import { useTranslation } from "react-i18next";

// stated-role chip copy + tint — mono, uppercase, small; demolition reads as
// the hazard it is (traced as a wall it produces a confident wrong number)
const ROLE_LABEL = {
  boundary: "boundary", structure: "structure", "finish-pattern": "pattern",
  annotation: "annotation", demolition: "demolition", unknown: "unclassified",
};
const ROLE_TINT = {
  boundary: "var(--cobalt)", structure: "var(--ink-soft)", "finish-pattern": "var(--ink-muted)",
  annotation: "var(--ink-muted)", demolition: "var(--c-danger)", unknown: "var(--text-faint)",
};

// What Auto does for this layer — the classified role's disposition, shown on
// the control so the default is never a mystery. Mirrors buildMask's short-
// circuit: boundary/structure plot hard; pattern/annotation/demolition and
// hidden-in-the-default-config ink are excluded; unknown flows to heuristics.
function autoMeaning(l, t) {
  if (l.visible === false) return t("layer.meaning_off_hidden");
  if (l.role === "boundary" || l.role === "structure") return t("layer.meaning_wall");
  if (l.role === "unknown") return t("layer.meaning_heuristics");
  return t("layer.meaning_off");
}

function roleLabel(role, t) {
  return t(`layer.role_${role}`, { defaultValue: ROLE_LABEL[role] || role });
}

function LayerRow({ layer: l, override, onOverride }) {
  const { t } = useTranslation("panels");
  const seg = (on) => ({
    padding: "2px 8px", border: `1px solid ${on ? "var(--cobalt)" : "var(--ink-faint)"}`,
    background: on ? "var(--cobalt)" : "transparent", color: on ? "var(--paper-bright)" : "var(--ink-muted)",
    cursor: "pointer", fontSize: 10.5, fontFamily: "var(--f-mono)", lineHeight: 1.5,
  });
  const conf = Math.round((l.confidence || 0) * 100);
  return (
    <div style={{ padding: "7px 12px", borderBottom: "1px solid var(--divider-soft)" }}
      title={t("layer.row_title", { name: l.name || l.id, segments: l.seg_count, role: roleLabel(l.role, t), confidence: conf ? t("layer.confidence", { conf }) : "", hidden: l.visible === false ? t("layer.hidden_suffix") : "" })}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <b style={{ flex: 1, fontFamily: "var(--f-mono)", fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name || l.id}</b>
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 9.5, color: "var(--ink-muted)", flexShrink: 0 }}>{l.seg_count}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: ROLE_TINT[l.role] || "var(--ink-muted)" }}>
          {roleLabel(l.role, t)}{l.visible === false ? t("layer.hidden_suffix") : ""}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={() => onOverride(null)} style={seg(!override)}
          title={t("layer.auto_title", { meaning: autoMeaning(l, t) })}>{t("layer.auto_button")}</button>
        <button onClick={() => onOverride(override === "include" ? null : "include")} style={seg(override === "include")}
          title={t("layer.wall_title")}>{t("layer.wall_button")}</button>
        <button onClick={() => onOverride(override === "exclude" ? null : "exclude")} style={seg(override === "exclude")}
          title={t("layer.off_title")}>{t("layer.off_button")}</button>
      </div>
    </div>
  );
}

export default function LayerPanel({
  entries,
  onOverride,
  onReset,
  onClose,
}) {
  const { t } = useTranslation("panels");
  return (
    <div style={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column", borderLeft: "1px solid var(--ink-faint)", background: "var(--paper-bright)", overflow: "hidden", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", background: "var(--ink)", color: "var(--paper-cream)" }}>
        <Icon name="layers" size={15} />
        <strong style={{ flex: 1, fontSize: 12.5 }}>{t("layer.title")}</strong>
        <button onClick={onClose} title={t("layer.close_title")} style={{ border: "none", background: "transparent", color: "var(--paper-cream)", fontSize: 16, cursor: "pointer", padding: "0 2px" }}>×</button>
      </div>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--ink-faint)", fontSize: 11, lineHeight: 1.5, color: "var(--ink-muted)" }}
        dangerouslySetInnerHTML={{ __html: t("layer.description") }} />
      <div style={{ flex: 1, overflow: "auto", fontSize: 12 }}>
        {/* no empty state by design: the canvas renders this panel (and its
            rail button) only when an open sheet actually carries layers */}
        {entries.map(({ key, label, layers, overrides }) => (
          <div key={key}>
            {entries.length > 1 && (
              <div className="t-label" style={{ padding: "8px 12px 4px", borderBottom: "1px solid var(--divider-soft)" }}>{label}</div>
            )}
            {layers.map((l) => (
              <LayerRow key={l.id} layer={l} override={overrides[l.id]}
                onOverride={(state) => onOverride(key, l.id, state)} />
            ))}
            {Object.keys(overrides).length > 0 && (
              <div style={{ padding: "6px 12px", borderBottom: "2px solid var(--ink-faint)" }}>
                <button onClick={() => onReset(key)}
                  style={{ border: "none", background: "none", color: "var(--ink-muted)", cursor: "pointer", fontSize: 11, padding: 0, textDecoration: "underline" }}
                  title={t("layer.reset_title")}>
                  {t("layer.reset")}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
