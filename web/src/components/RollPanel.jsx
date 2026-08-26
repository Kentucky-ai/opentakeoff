// Roll panel (#136) — the docked right-rail surface for roll goods: every
// roll-goods condition's cuts laid out ON THE ROLL, to scale, numbered in
// cutting order, with per-cut dimensions and the figured order line. The
// diagram is also the reorder desk: drag a cut to a new spot and the whole
// roll RE-PACKS through the engine's skyline nesting (a manual order can
// never produce an overlapped roll), or Reset order to hand sequencing back
// to the packer. The overlay/edit toggles live here too — this panel is the
// roll-goods HQ; the canvas just draws what it says.
//
// Layout state lives on the SHAPES (roll_layout, via the rollcut command), so
// everything here is a pure view over the layouts prop the canvas computes.
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../brand/icons.jsx";
import { ftIn } from "../lib/units";
import { rollColorForType } from "../lib/rollgoods.js";
import { HatchSwatch } from "./hatches.jsx";

const PXFT = 9; // diagram scale, px per foot — a 12-ft roll draws 108px wide

// One roll's diagram: the roll drawn VERTICALLY (width across, length down),
// cuts at their packed (cutY across, cutX down) positions, numbered when they
// have the room, over-roll cuts in danger red, physical roll boundaries as
// dashed rules when a max roll length is set. Drag (when editable) previews
// locally and hands the full new order up on release — the re-pack happens in
// the engine, never here.
function RollDiagram({ ri, editable, onReorder }) {
  const { t } = useTranslation("panels");
  const [drag, setDrag] = useState(null); // { id, dx, dy } — local preview only
  const svgRef = useRef(null);
  const W = ri.config.rollWidthFt * PXFT;
  const lenFt = Math.max(ri.orderFt, 1);
  const H = lenFt * PXFT;
  const pad = 14;

  const startDrag = (e, strip) => {
    if (!editable) return;
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const move = (ev) => setDrag({ id: strip.id, dx: (ev.clientX - sx) / PXFT, dy: (ev.clientY - sy) / PXFT });
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const dx = (ev.clientX - sx) / PXFT, dy = (ev.clientY - sy) / PXFT;
      setDrag(null);
      if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) return; // a click is not a reorder
      // effective positions: the dragged cut at its preview spot, the rest at
      // their packed spots — sorted into the new cutting order (down the roll,
      // then across), which the canvas turns into seq overrides + a re-pack
      const eff = ri.strips.map((s) => ({
        id: s.id,
        x: (s.cutX || 0) + (s.id === strip.id ? dy : 0),   // down the roll = screen y
        y: (s.cutY || 0) + (s.id === strip.id ? dx : 0),   // across = screen x
      })).sort((a, b) => (Math.abs(a.x - b.x) > 1e-6 ? a.x - b.x : a.y - b.y));
      onReorder(eff.map((s) => s.id));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const rollFill = rollColorForType(ri.material);
  const nRolls = ri.config.rollLengthFt > 0 ? Math.ceil(lenFt / ri.config.rollLengthFt - 1e-9) : 0;
  return (
    <svg ref={svgRef} width={W + pad * 2 + 46} height={H + pad * 2}
      style={{ display: "block", maxWidth: "100%", touchAction: "none" }}>
      {/* the roll itself */}
      <rect x={pad} y={pad} width={W} height={H} fill={rollFill + "22"} stroke="var(--ink-faint)" />
      {/* physical roll boundaries when a max length is set */}
      {nRolls > 1 && Array.from({ length: nRolls - 1 }, (_, k) => {
        const y = pad + (k + 1) * ri.config.rollLengthFt * PXFT;
        return <g key={k}>
          <line x1={pad} y1={y} x2={pad + W} y2={y} stroke="var(--ink-muted)" strokeDasharray="5 4" />
          <text x={pad + W + 4} y={y - 3} fontSize={9} fill="var(--ink-muted)" fontFamily="var(--f-mono)">{t('roll.roll_number', { num: k + 2 })}</text>
        </g>;
      })}
      {/* cuts — cutY across the width (screen x), cutX down the length (screen y) */}
      {ri.strips.map((s) => {
        const lw = Math.max(0, s.laneMax - s.laneMin), ln = Math.max(0, s.runMax - s.runMin);
        const isDrag = drag && drag.id === s.id;
        const cx = (s.cutY || 0) + (isDrag ? drag.dx : 0);
        const cy = (s.cutX || 0) + (isDrag ? drag.dy : 0);
        const x = pad + cx * PXFT, y = pad + cy * PXFT, w = lw * PXFT, h = ln * PXFT;
        const n = ri.nums.get(s.id) || 0;
        return (
          <g key={s.id} onPointerDown={(e) => startDrag(e, s)}
            style={editable ? { cursor: "grab" } : undefined}>
            <title>{t('roll.cut_title', { n, label: s.label ? ` — ${s.label}` : '', length: ftIn(ln), width: ftIn(lw), oversize: s.overRoll ? t('roll.oversize') : '' })}</title>
            <rect x={x} y={y} width={w} height={h}
              fill={rollFill + (isDrag ? "88" : "66")}
              stroke={s.overRoll ? "var(--c-danger)" : "var(--ink)"} strokeWidth={s.overRoll ? 1.6 : 0.8} />
            {w > 15 && h > 15 && (
              <g>
                <circle cx={x + 10} cy={y + 10} r={7} fill="var(--ink)" />
                <text x={x + 10} y={y + 13} fontSize={9.5} fontWeight={700} fill="var(--paper-bright)" textAnchor="middle" fontFamily="var(--f-mono)">{n}</text>
              </g>
            )}
            {/* leader dimension in the right margin */}
            {h > 10 && <text x={pad + W + 4} y={y + h / 2 + 3} fontSize={8.5} fill="var(--ink-muted)" fontFamily="var(--f-mono)">{ftIn(ln)}</text>}
          </g>
        );
      })}
      {/* width dimension under the roll */}
      <text x={pad + W / 2} y={pad + H + 11} fontSize={9} fill="var(--ink-muted)" textAnchor="middle" fontFamily="var(--f-mono)">{ftIn(ri.config.rollWidthFt)} {t('roll.roll')}</text>
    </svg>
  );
}

export default function RollPanel({
  layouts, // [{ condId, tag, color, fill, hatch, multiplier, ri }] — ri = computeRollTakeoff summary
  show, onShow, edit, onEdit,
  onReorder, onResetOrder, onClose,
}) {
  const { t } = useTranslation("panels");
  const ctl = (on) => ({ padding: "2px 8px", border: `1px solid ${on ? "var(--cobalt)" : "var(--ink-faint)"}`, background: on ? "var(--cobalt)" : "transparent", color: on ? "var(--paper-bright)" : "var(--ink-muted)", cursor: "pointer", fontSize: 10.5, fontFamily: "var(--f-mono)", lineHeight: 1.5 });
  return (
    <div style={{ width: 320, flexShrink: 0, display: "flex", flexDirection: "column", borderLeft: "1px solid var(--ink-faint)", background: "var(--paper-bright)", overflow: "hidden", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", background: "var(--ink)", color: "var(--paper-cream)" }}>
        <Icon name="roll" size={15} />
        <strong style={{ flex: 1, fontSize: 12.5 }}>{t('roll.title')}</strong>
        <button onClick={() => onShow(!show)} title={t('roll.cuts_show_title')} style={ctl(show)}>{t('roll.cuts')}</button>
        <button onClick={() => onEdit(!edit)} title={t('roll.edit_title')} style={ctl(edit)}>{t('roll.edit')}</button>
        <button onClick={onClose} title={t('roll.close_title')} style={{ border: "none", background: "transparent", color: "var(--paper-cream)", fontSize: 16, cursor: "pointer", padding: "0 2px" }}>×</button>
      </div>
      <div style={{ flex: 1, overflow: "auto", fontSize: 12 }}>
        {layouts.length === 0 && (
          <div style={{ padding: 14, color: "var(--ink-muted)", lineHeight: 1.6 }}>
            {t('roll.empty')}
          </div>
        )}
        {layouts.map(({ condId, tag, color, fill, hatch, multiplier, ri }) => {
          return (
            <div key={condId} style={{ borderBottom: "2px solid var(--ink-faint)", padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 2 }}>
                <span style={{ borderRadius: 4, overflow: "hidden", lineHeight: 0, flexShrink: 0 }}><HatchSwatch type={hatch || "solid"} line={color} fill={fill} /></span>
                <b style={{ fontFamily: "var(--f-mono)", fontSize: 12 }}>{tag}</b>
                {multiplier > 1 && <span style={{ color: "var(--ink-muted)", fontSize: 11 }} title={t('roll.multiplier_title')}>×{multiplier}</span>}
                <span style={{ marginLeft: "auto", color: "var(--ink-muted)", fontSize: 10.5, fontFamily: "var(--f-mono)" }}>{ri.direction === "ns" ? t('roll.run_ns') : t('roll.run_ew')}</span>
              </div>
              <div style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink)", marginBottom: 6 }}>
                {t('roll.order')} {ftIn(ri.orderFt)} · {Math.round(ri.qty * 100) / 100} {ri.unit.toUpperCase()} · {ri.cutCount} {ri.cutCount === 1 ? t('roll.cut_suffix') : t('roll.cuts_suffix')}
                {ri.config.rollLengthFt > 0 ? ` · ${ri.rollCount} ${ri.rollCount === 1 ? t('roll.roll_suffix') : t('roll.rolls_suffix')} @ ${ftIn(ri.config.rollLengthFt)}` : ""}
              </div>
              {ri.oversize && (
                <div style={{ margin: "0 0 6px", padding: "5px 8px", border: "1px solid var(--c-danger)", color: "var(--c-danger)", fontSize: 11, lineHeight: 1.45 }}>
                  {t('roll.oversize')}
                </div>
              )}
              <div style={{ overflowX: "auto" }}>
                <RollDiagram ri={ri} editable onReorder={(ids) => onReorder(condId, ids)} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                <span style={{ fontSize: 10.5, color: "var(--ink-muted)" }}>{t('roll.drag_hint')}</span>
                <button onClick={() => onResetOrder(condId)} title={t('roll.reset_order_title')}
                  style={{ marginLeft: "auto", flexShrink: 0, padding: "2px 8px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 10.5 }}>{t('roll.reset_order')}</button>
              </div>
              {/* the cut list — numbered in cutting order, with the piece and the room extent */}
              <div style={{ marginTop: 6 }}>
                {ri.strips.slice().sort((a, b) => (ri.nums.get(a.id) || 0) - (ri.nums.get(b.id) || 0)).map((s) => {
                  const n = ri.nums.get(s.id) || 0;
                  const lw = Math.max(0, s.laneMax - s.laneMin), ln = Math.max(0, s.runMax - s.runMin);
                  const cw = Math.max(0, s.coverMax - s.coverMin), cn = Math.max(0, (s.runMax - s.maxOverageFt) - (s.runMin + s.minOverageFt));
                  return (
                    <div key={s.id} style={{ display: "flex", gap: 7, alignItems: "baseline", fontSize: 10.5, fontFamily: "var(--f-mono)", color: "var(--ink-secondary)", padding: "1px 0" }}>
                      <span style={{ color: s.overRoll ? "var(--c-danger)" : "var(--ink)", fontWeight: 700, width: 18, flexShrink: 0 }}>{n}</span>
                      <span>{t('roll.cut_item')} {ftIn(ln)} × {ftIn(lw)}</span>
                      <span style={{ color: "var(--ink-muted)" }}>· {t('roll.covers')} {ftIn(cn)} × {ftIn(cw)}{s.label ? ` · ${s.label}` : ""}{s.laneCount > 1 ? ` · ${t('roll.lane')} ${s.laneIndex + 1}/${s.laneCount}` : ""}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
