// PlanNavigator — the single, harmonized surface for choosing plans, merging the
// former SheetGallery (working-set thumbnail grid) and DrivePicker (browse the
// project's Drive folder) into ONE chrome with two modes: "plan" and "browse".
//
// Presentation is CONDITIONAL (this is the whole point of the redesign):
//   • canClose === false (empty project / nothing open behind us) → full-screen,
//     non-dismissible. There is nowhere to go back to, and this IS the first-run
//     onboarding (drag target / sample / sign-in). Esc and scrim-click must NOT
//     strand the user on a blank canvas.
//   • canClose === true (a sheet is open behind us) → a large centered MODAL over
//     the dimmed canvas, so the user stays oriented instead of dropping into a
//     full-screen "no man's land". Esc / scrim-click return to the canvas.
//
// Back/up is a single control anchored top-left by the title; its meaning is
// mode-aware (see back()). Esc is a SEPARATE, one-press dismiss (browse → plan,
// plan → canvas) rather than the back button's per-level folder climb — see
// escRef below. While mounted, the navigator swallows canvas keyboard
// shortcuts in EVERY mode via a capture-phase listener — shortcut suppression is
// keyed on "is this mounted", never on the canvas' view/mode staying in sync.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Icon } from "../brand/icons.jsx";
import AuthChip from "./AuthChip.jsx";
import { useGoogleAuth } from "../lib/google/AuthContext.jsx";
import { parseSheetKey, extractSheetNumber, detectScale, RENDER_SCALE, MAX_GROUP } from "../lib/sheets";
import { isGoogleConfigured } from "../lib/google/auth.js";
import { projectHomeFolderId } from "../lib/projectHome.js";
import { groupSheetsByLevel, sortGalleryGroups } from "../lib/sheetLevels.js";

const THUMB_W = 380;
const ROOT = { id: undefined, name: "Project" };   // id undefined → cloudStore's default (project folder)

function fmtSize(s) {
  const n = Number(s);
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtDate(t) {
  if (!t) return "";
  const d = new Date(t);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

const rowBase = { display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-bright)" };
const ctrlBtn = { display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12.5 };

export default function PlanNavigator({
  // presentation + exit
  canClose, onExit, initialMode = "plan", cloudMode,
  // plan-set (gallery) data
  sheets, getDoc, scales, detectedScales, shapes, labels, onLabel, onDetect,
  thumbCacheRef, busyRef, openTabs, onOpen,
  onAddFiles, onClosePdf, onRemoveFromProject,
  onCloseProject, onBrowseProjects,
  levels = {}, onAssignLevel,
  // browse (Drive) data
  listFolder, addSheets, onAdded,
}) {
  const navigate = useNavigate();
  const { user, signIn } = useGoogleAuth();
  const browseEnabled = cloudMode && typeof listFolder === "function";
  const [mode, setMode] = useState(browseEnabled && initialMode === "browse" ? "browse" : "plan");

  // ── shared: swallow canvas shortcuts while mounted (capture phase, every mode) ──
  // The canvas' own shortcuts listen on window in the bubble phase; this runs
  // FIRST and stops them. Esc routes to back(), but only actually exits when
  // there's somewhere to go (back() enforces that). Typing in the filter field
  // is exempt so it behaves like a normal input.
  // Esc is a ONE-PRESS dismiss (like the old DrivePicker/SheetGallery): from
  // Browse Drive it drops back to Plan set regardless of folder depth; from Plan
  // set it exits to the canvas (when there's one to return to). Folder climbing
  // is the back button's / breadcrumb's job — Esc never walks the tree.
  const escRef = useRef(() => {});
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); escRef.current(); return; }
      const tag = e.target?.tagName;
      if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // ══ BROWSE (Drive) state ══════════════════════════════════════════════════
  const [path, setPath] = useState([ROOT]);        // breadcrumb stack
  const [data, setData] = useState(null);          // { folders, pdfs } | null
  const [bLoading, setBLoading] = useState(true);
  const [bErr, setBErr] = useState("");
  const [picked, setPicked] = useState([]);        // [{ id, name }] — accumulates across folders
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("name");        // name | size | date
  const [adding, setAdding] = useState(false);
  const here = path[path.length - 1];
  const existingNames = useMemo(() => new Set(sheets.map((s) => s.name)), [sheets]);

  const loadFolder = useCallback((folderId) => {
    let live = true;
    setBLoading(true); setBErr("");
    listFolder(folderId)
      .then((d) => { if (live) { setData(d); setBLoading(false); } })
      .catch((e) => { if (live) { setBErr(String(e?.message || e)); setBLoading(false); } });
    return () => { live = false; };
  }, [listFolder]);
  useEffect(() => { if (mode === "browse" && browseEnabled) return loadFolder(here.id); }, [mode, here.id, loadFolder, browseEnabled]);

  const isPicked = (id) => picked.some((p) => p.id === id);
  const pickedNames = new Set(picked.map((p) => p.name));
  const nameConflict = (f) => !isPicked(f.id) && !existingNames.has(f.name) && pickedNames.has(f.name);
  const togglePick = (f) => setPicked((p) => (p.some((x) => x.id === f.id) ? p.filter((x) => x.id !== f.id) : [...p, { id: f.id, name: f.name }]));
  const drillInto = (folder) => setPath((p) => [...p, folder]);
  const jumpTo = (i) => setPath((p) => p.slice(0, i + 1));

  const addPicked = async () => {
    if (!picked.length || adding) return;
    setAdding(true); setBErr("");
    try {
      await addSheets(picked);
      await onAdded();          // parent refreshes the working set
      setPicked([]);
      setMode("plan");          // land back in the plan-set gallery
    } catch (e) {
      setBErr(String(e?.message || e));
    } finally {
      setAdding(false);
    }
  };

  // ══ PLAN (gallery) state + thumbnail worker ══════════════════════════════
  const fileRef = useRef(null);
  const [pages, setPages] = useState({});   // file -> numPages (as discovered)
  const [sel, setSel] = useState([]);
  const [sampleBusy, setSampleBusy] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveErr, setDriveErr] = useState("");
  const [addMenu, setAddMenu] = useState(false);
  const [confirmClose, setConfirmClose] = useState(null);   // { file, shapeCount } | null
  const [, bump] = useState(0);
  const seqRef = useRef(0);
  const queueRef = useRef([]);
  const pumpingRef = useRef(false);
  const obsRef = useRef(null);

  const loadSample = async () => {
    if (sampleBusy || !onAddFiles) return;
    setSampleBusy(true);
    try {
      const base = import.meta.env.BASE_URL || "/";
      const res = await fetch(`${base}demo/sample-finish-plan.pdf`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      onAddFiles([new File([blob], "sample-finish-plan.pdf", { type: "application/pdf" })]);
    } catch {
      setSampleBusy(false);
    }
  };

  const handleDriveSignIn = () => {
    if (driveBusy) return;
    setDriveErr("");
    setDriveBusy(true);
    signIn()
      .then(() => { if (projectHomeFolderId()) navigate("/projects"); })
      .catch((e) => setDriveErr(String(e?.message || e)))
      .finally(() => setDriveBusy(false));
  };

  // enumerate: learn every file's page count through the shared doc cache
  useEffect(() => {
    const seq = ++seqRef.current;
    (async () => {
      for (const s of sheets) {
        try {
          const pdf = await getDoc(s.name);
          if (seq !== seqRef.current) return;
          setPages((m) => (m[s.name] ? m : { ...m, [s.name]: pdf.numPages || 1 }));
        } catch { if (seq === seqRef.current) setPages((m) => (m[s.name] !== undefined ? m : { ...m, [s.name]: 0 })); }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { seqRef.current++; };
  }, [sheets, getDoc]);

  const allKeys = sheets.flatMap((s) => {
    const n = pages[s.name];
    if (!n) return [];
    return Array.from({ length: n }, (_, i) => (i ? `${s.name}#${i + 1}` : s.name));
  });

  // a one-sheet project has nothing to choose — open it, but ONLY on the first
  // landing (no tab open yet). Without the openTabs guard this fires on every
  // remount: reopening the gallery for a 1-sheet project would enumerate, auto-
  // open, and bounce straight back to the canvas — leaving Add plans / Browse
  // Drive permanently unreachable.
  const enumerated = sheets.length > 0 && sheets.every((s) => pages[s.name] !== undefined);
  useEffect(() => {
    if (mode === "plan" && enumerated && allKeys.length === 1 && openTabs.length === 0) onOpen([allKeys[0]], false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, mode]);

  const pump = async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    const seq = seqRef.current;
    while (queueRef.current.length) {
      if (seq !== seqRef.current) break;
      if (busyRef.current === "rendering") { await new Promise((r) => setTimeout(r, 150)); continue; }
      const key = queueRef.current.shift();
      if (thumbCacheRef.current.has(key)) continue;
      try {
        const { file, page } = parseSheetKey(key);
        const pdf = await getDoc(file);
        const pg = await pdf.getPage(page);
        if (seq !== seqRef.current) break;
        const vp1 = pg.getViewport({ scale: 1 });
        const vp = pg.getViewport({ scale: THUMB_W / vp1.width });
        const c = document.createElement("canvas");
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        await pg.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        thumbCacheRef.current.set(key, c.toDataURL("image/jpeg", 0.72));
        bump((n) => n + 1);
        if (!labels[key] || !detectedScales[key]) {
          const tc = await pg.getTextContent();
          const vpL = pg.getViewport({ scale: RENDER_SCALE });
          const lbl = extractSheetNumber(tc, vpL);
          if (lbl) onLabel(key, lbl);
          const det = detectScale(tc, vpL);
          if (det) onDetect(key, det);
        }
      } catch { /* destroyed doc on unmount / render-cancel — skip */ }
    }
    pumpingRef.current = false;
  };

  useEffect(() => {
    obsRef.current = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const key = e.target.dataset.sheetkey;
        if (key && !thumbCacheRef.current.has(key) && !queueRef.current.includes(key)) queueRef.current.push(key);
        obsRef.current?.unobserve(e.target);
      }
      pump();
    }, { rootMargin: "300px" });
    return () => obsRef.current?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSel = (key) => setSel((g) => (g.includes(key) ? g.filter((k) => k !== key) : [...g, key]));
  const shapeCount = (key) => shapes.reduce((n, s) => n + (s.sheet_id === key ? 1 : 0), 0);
  const pdfShapeCount = (file) => shapes.reduce((n, s) => n + (parseSheetKey(s.sheet_id).file === file ? 1 : 0), 0);
  const labelOf = (key) => {
    if (labels[key]) return labels[key];
    const t = parseSheetKey(key);
    const base = t.file.replace(/\.pdf$/i, "");
    return t.page > 1 ? `${base} · ${t.page}` : base;
  };
  // multi-floor: group by assigned level (natural sort), unassigned last; within a
  // group that itself has a level, order by the title-block label so A-sheets
  // read in drawing order. The Unassigned group keeps stable file/page order
  // regardless of whether other groups have levels — see sortGalleryGroups's
  // comment for why this must be a PER-GROUP gate, not a whole-gallery one.
  const groups = sortGalleryGroups(groupSheetsByLevel(allKeys, levels), labelOf);
  const assignLevel = () => {
    const label = window.prompt('Level for the selected sheets (e.g. "L1", "Level 2", "Garage") — empty clears:', "");
    if (label === null) return;
    onAssignLevel?.(sel, label.trim());
    setSel([]);
  };

  // ── mode-aware back/up ──────────────────────────────────────────────────
  // browse-deep → climb a breadcrumb level; browse-root → back to plan set;
  // plan + canClose → exit to canvas; plan + !canClose → nowhere (no-op).
  const back = useCallback(() => {
    if (mode === "browse") {
      if (path.length > 1) jumpTo(path.length - 2);
      else setMode("plan");
      return;
    }
    if (canClose) onExit();
  }, [mode, path.length, canClose, onExit]);
  const canGoBack = mode === "browse" || canClose;
  // Esc: leave the current mode in one press (browse → plan, plan → canvas),
  // independent of the back button's per-level folder climb.
  useEffect(() => {
    escRef.current = () => {
      if (mode === "browse") { setMode("plan"); return; }
      if (canClose) onExit();
    };
  }, [mode, canClose, onExit]);

  // ── close / remove a PDF from the working set ───────────────────────────
  const requestClose = (file) => setConfirmClose({ file, shapeCount: pdfShapeCount(file) });
  const doClose = async () => {
    const { file } = confirmClose;
    setConfirmClose(null);
    await onClosePdf(file);
  };
  const doRemove = async () => {
    const { file } = confirmClose;
    setConfirmClose(null);
    await onRemoveFromProject(file);
  };

  // ══ RENDER ════════════════════════════════════════════════════════════════
  const title = mode === "browse" ? "Add sheets from Drive" : "Plan set";
  const subtitle = mode === "browse"
    ? "pick the PDFs to open — specs & as-builts stay unopened"
    : `${allKeys.length || "…"} sheets · pick one or several — the order you pick is the left-to-right order`;

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderBottom: "1px solid var(--ink)", background: "var(--paper-bright)", flexWrap: "wrap" }}>
      {/* LEFT up-chain: back + title + (cloud) Projects crumb + (browse) breadcrumb */}
      <button onClick={back} disabled={!canGoBack} title={mode === "browse" ? "Back" : "Back to the canvas (Esc)"}
        style={{ ...ctrlBtn, padding: "6px 8px", opacity: canGoBack ? 1 : 0.35, cursor: canGoBack ? "pointer" : "default" }}>
        <Icon name="chevronLeft" size={14} />
      </button>
      <Icon name="sheets" size={18} />
      <strong style={{ fontFamily: "var(--f-display)", fontSize: 16, color: "var(--ink)" }}>{title}</strong>
      {onBrowseProjects && (
        <button onClick={onBrowseProjects} title="Back to your team's projects"
          style={{ border: "none", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontFamily: "var(--f-mono)", fontSize: 12, padding: "2px 4px" }}>
          Projects
        </button>
      )}
      {mode === "browse" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 4, fontFamily: "var(--f-mono)", fontSize: 12 }}>
          {path.map((c, i) => (
            <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "var(--text-faint)" }}>/</span>
              <button onClick={() => jumpTo(i)} disabled={i === path.length - 1}
                style={{ border: "none", background: "transparent", cursor: i === path.length - 1 ? "default" : "pointer", color: i === path.length - 1 ? "var(--ink)" : "var(--cobalt)", fontFamily: "var(--f-mono)", fontSize: 12, padding: "2px 2px", fontWeight: i === path.length - 1 ? 700 : 400 }}>
                {c.name}
              </button>
            </span>
          ))}
        </div>
      ) : (
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" }}>{subtitle}</span>
      )}

      <div style={{ flex: 1 }} />

      {/* RIGHT: source toggle · browse filters · add plans · account */}
      {browseEnabled && (
        <div style={{ display: "inline-flex", border: "1px solid var(--ink-faint)", borderRadius: 2, overflow: "hidden" }}>
          <button onClick={() => setMode("plan")} style={{ ...ctrlBtn, border: "none", background: mode === "plan" ? "var(--ink)" : "transparent", color: mode === "plan" ? "var(--paper-bright)" : "var(--ink-muted)" }}>Plan set</button>
          <button onClick={() => setMode("browse")} style={{ ...ctrlBtn, border: "none", background: mode === "browse" ? "var(--ink)" : "transparent", color: mode === "browse" ? "var(--paper-bright)" : "var(--ink-muted)" }}>Browse Drive</button>
        </div>
      )}
      {mode === "browse" && (
        <>
          <input name="drive-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name…"
            style={{ padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontSize: 12.5, minWidth: 140 }} />
          <select name="drive-sort" value={sort} onChange={(e) => setSort(e.target.value)} title="Sort files"
            style={{ padding: "6px 8px", border: "1px solid var(--ink-faint)", background: "transparent", fontSize: 12 }}>
            <option value="name">Name</option>
            <option value="size">Size</option>
            <option value="date">Modified</option>
          </select>
        </>
      )}
      {mode === "plan" && onAddFiles && (
        <div style={{ position: "relative" }}>
          <button onClick={() => (browseEnabled ? setAddMenu((v) => !v) : fileRef.current?.click())}
            title="Add plans — from your computer or Google Drive"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 12.5 }}>
            <Icon name="plus" size={13} />Add plans{browseEnabled && <Icon name="chevronDown" size={12} />}
          </button>
          {addMenu && browseEnabled && (
            <>
              <div onClick={() => setAddMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 1 }} />
              <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 2, minWidth: 210, background: "var(--paper-bright)", border: "1px solid var(--ink)", boxShadow: "var(--shadow-2)" }}>
                <button onClick={() => { setAddMenu(false); fileRef.current?.click(); }} style={{ ...ctrlBtn, width: "100%", border: "none", borderBottom: "1px solid var(--ink-faint)", justifyContent: "flex-start", padding: "10px 12px" }}>
                  <Icon name="document" size={14} />From this computer
                </button>
                <button onClick={() => { setAddMenu(false); setMode("browse"); }} style={{ ...ctrlBtn, width: "100%", border: "none", justifyContent: "flex-start", padding: "10px 12px" }}>
                  <Icon name="cloud" size={14} />From Google Drive
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {onAddFiles && (
        <input name="sheet-file" ref={fileRef} type="file" accept=".pdf,application/pdf,image/*,.zip,application/zip,application/x-zip-compressed" multiple style={{ display: "none" }}
          onChange={(e) => { onAddFiles(e.target.files); e.target.value = ""; }} />
      )}
      <AuthChip />
      {onCloseProject && (
        <button onClick={onCloseProject} title="Close this project and return to the local canvas" style={{ ...ctrlBtn, color: "var(--ink-muted)" }}>Close project</button>
      )}
      {canClose && (
        <button onClick={onExit} title="Back to the canvas (Esc)" style={ctrlBtn}>
          <Icon name="close" size={12} />Close
        </button>
      )}
    </div>
  );

  // ── BROWSE body + footer ────────────────────────────────────────────────
  const needle = q.trim().toLowerCase();
  const folders = (data?.folders || []).filter((f) => !needle || f.name.toLowerCase().includes(needle));
  const pdfs = (data?.pdfs || [])
    .filter((f) => !needle || f.name.toLowerCase().includes(needle))
    .sort((a, b) => {
      if (sort === "size") return (Number(b.size) || 0) - (Number(a.size) || 0);
      if (sort === "date") return String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || ""));
      return a.name.localeCompare(b.name);
    });

  const browseBody = (
    <>
      <div style={{ flex: 1, overflow: "auto" }}>
        {bLoading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>Reading folder…</div>
        ) : bErr ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--c-danger)", fontSize: 13 }}>Couldn't read the folder: {bErr}</div>
        ) : (folders.length === 0 && pdfs.length === 0) ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>
            {needle ? "Nothing matches that filter." : "This folder has no PDFs or subfolders."}
          </div>
        ) : (
          <>
            {folders.map((f) => (
              <div key={f.id} onClick={() => drillInto(f)} style={{ ...rowBase, cursor: "pointer" }}>
                <span style={{ fontSize: 15, width: 20, textAlign: "center", color: "var(--cobalt)" }}><Icon name="chevronRight" size={13} /></span>
                <strong style={{ fontFamily: "var(--f-body)", fontSize: 13.5, color: "var(--ink)", flex: 1 }}>{f.name}</strong>
                <span style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>folder</span>
              </div>
            ))}
            {pdfs.map((f) => {
              const inSet = existingNames.has(f.name);
              const selPick = isPicked(f.id);
              const conflict = nameConflict(f);
              const disabled = inSet || conflict;
              const tagStyle = { fontFamily: "var(--f-mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.08em", minWidth: 72, textAlign: "right" };
              return (
                <label key={f.id} style={{ ...rowBase, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1 }}
                  title={conflict ? "Another selected PDF already uses this name — a project can't have two sheets with the same name" : undefined}>
                  <input name="drive-file-pick" type="checkbox" checked={selPick || inSet} disabled={disabled} onChange={() => togglePick(f)}
                    style={{ width: 16, height: 16, cursor: disabled ? "default" : "pointer" }} />
                  <span style={{ fontFamily: "var(--f-mono)", fontSize: 13, color: "var(--ink)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.name}>{f.name}</span>
                  <span style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink-muted)", minWidth: 64, textAlign: "right" }}>{fmtSize(f.size)}</span>
                  <span style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink-muted)", minWidth: 84, textAlign: "right" }}>{fmtDate(f.modifiedTime)}</span>
                  {inSet ? <span style={{ ...tagStyle, color: "var(--c-positive)" }}>added</span>
                    : conflict ? <span style={{ ...tagStyle, color: "var(--c-warning)" }}>name in use</span>
                    : <span style={{ minWidth: 72 }} />}
                </label>
              );
            })}
          </>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderTop: "1px solid var(--ink)", background: "var(--paper-bright)" }}>
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 11.5, color: "var(--ink-muted)" }}>
          {picked.length ? `${picked.length} selected to open` : "check the PDFs you want to open — nothing downloads until you add them"}
        </span>
        <div style={{ flex: 1 }} />
        {picked.length > 0 && (
          <button onClick={() => setPicked([])} style={{ padding: "7px 12px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>Clear</button>
        )}
        <button onClick={addPicked} disabled={!picked.length || adding}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 16px", border: "1px solid var(--ink)", background: picked.length ? "var(--cobalt)" : "var(--text-faint)", color: "var(--paper-bright)", cursor: picked.length && !adding ? "pointer" : "default", fontWeight: 700, fontSize: 13 }}>
          <Icon name="plus" size={13} />{adding ? "Adding…" : `Add ${picked.length || ""} sheet${picked.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </>
  );

  // ── PLAN body + footer ──────────────────────────────────────────────────
  const planBody = (
    <>
      <div style={{ flex: 1, overflow: "auto", padding: 18 }}>
        {groups.map((grp) => (
        <div key={grp.level ?? "__all"} style={{ marginBottom: grp.level !== null ? 22 : 0 }}>
        {grp.level !== null && (
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--ink-muted)", margin: "0 0 8px 2px" }}>
            {grp.level || "Unassigned"} · {grp.keys.length}
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))", gap: 14 }}>
          {grp.keys.map((key) => {
            const idx = sel.indexOf(key);
            const isSel = idx >= 0;
            const thumb = thumbCacheRef.current.get(key);
            const cnt = shapeCount(key);
            const isOpenTab = openTabs.includes(key);
            const parsed = parseSheetKey(key);
            const isFirstPageOfPdf = parsed.page === 1;   // per-PDF close lives on the first card only
            return (
              <div key={key} data-sheetkey={key} ref={(el) => { if (el && !thumb) obsRef.current?.observe(el); }}
                onClick={() => toggleSel(key)}
                style={{ border: isSel ? "1.5px solid var(--cobalt)" : "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", position: "relative", boxShadow: isSel ? "var(--shadow-2)" : "var(--shadow-1)" }}>
                <span style={{ position: "absolute", top: 8, left: 8, zIndex: 2, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", border: isSel ? "none" : "1.5px solid var(--ink-faint)", background: isSel ? "var(--cobalt)" : "var(--paper-bright)", color: "var(--paper-bright)", fontFamily: "var(--f-mono)", fontSize: 12, fontWeight: 700 }}>{isSel ? idx + 1 : ""}</span>
                <div style={{ position: "absolute", top: 8, right: 8, zIndex: 2, display: "flex", gap: 6 }}>
                  {isFirstPageOfPdf && onClosePdf && (
                    <button onClick={(e) => { e.stopPropagation(); requestClose(parsed.file); }} title={cloudMode ? "Close this PDF — unload it from the plan set (it stays in Drive)" : "Close this PDF — remove it from the plan set (local plans aren't stored elsewhere)"}
                      style={{ padding: "5px 8px", border: "none", background: "var(--paper-bright)", color: "var(--ink-muted)", cursor: "pointer", fontFamily: "var(--f-mono)", fontSize: 11, boxShadow: "var(--shadow-1)" }}>✕</button>
                  )}
                  <button onClick={(e) => { e.stopPropagation(); onOpen([key], false); }} title="Open just this sheet"
                    style={{ padding: "5px 12px", border: "none", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer", fontFamily: "var(--f-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase" }}>View</button>
                </div>
                <div style={{ height: 185, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--well)", borderBottom: "1px solid var(--ink-faint)", overflow: "hidden" }}>
                  {thumb
                    ? <img src={thumb} alt={labelOf(key)} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                    : <div className="skeleton" style={{ width: "86%", height: "78%" }} />}
                </div>
                <div style={{ padding: "8px 10px", display: "flex", alignItems: "baseline", gap: 8 }}>
                  <strong style={{ fontFamily: "var(--f-mono)", fontSize: 12.5, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }} title={key}>{labelOf(key)}</strong>
                  {levels[key] && <span title="Level" style={{ fontSize: 9.5, fontFamily: "var(--f-mono)", color: "var(--ink-muted)", border: "1px solid var(--ink-faint)", padding: "1px 5px" }}>{levels[key]}</span>}
                  {isOpenTab && <span title="Already open as a tab" style={{ fontSize: 9.5, fontFamily: "var(--f-mono)", color: "var(--cobalt)", textTransform: "uppercase", letterSpacing: "0.08em" }}>open</span>}
                  {cnt > 0 && <span style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, color: "var(--ink-muted)" }}>{cnt}▦</span>}
                  <span style={{ fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", color: scales[key] ? "var(--c-positive)" : detectedScales[key] ? "var(--c-warning)" : "var(--c-danger)" }}>
                    {scales[key] ? "scale ✓" : detectedScales[key] ? `plan: ${detectedScales[key].label}` : "no scale"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        </div>
        ))}
        {!allKeys.length && (
          <div style={{ padding: 48, textAlign: "center", color: "var(--ink-muted)", fontSize: 13.5, lineHeight: 1.7 }}>
            {!sheets.length ? (
              <div style={{ maxWidth: 560, margin: "0 auto" }}>
                <button onClick={() => fileRef.current?.click()}
                  style={{ display: "block", width: "100%", margin: "24px auto 0", padding: "44px 24px", border: "2px dashed var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", color: "var(--ink-muted)", fontFamily: "var(--f-body)", fontSize: 13.5, lineHeight: 1.7 }}>
                  <div style={{ fontFamily: "var(--f-display)", fontSize: 20, color: "var(--ink)", marginBottom: 8 }}>Open your plans</div>
                  Drag a PDF, an image, or a whole .zip plan set here — or click to choose. Nothing leaves your browser.
                </button>
                {isGoogleConfigured() && (!user || projectHomeFolderId()) && (
                  <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
                    {!user ? (
                      <>
                        <button type="button" onClick={handleDriveSignIn} disabled={driveBusy}
                          title="Sign in with your team Google account to open projects stored in Drive"
                          style={{ border: "none", background: "transparent", padding: 0, color: "var(--cobalt)", cursor: driveBusy ? "default" : "pointer", fontSize: 12, textDecoration: "underline", fontFamily: "var(--f-body)" }}>
                          {driveBusy ? "Signing in…" : "or sign in with Google Drive"}
                        </button>
                        {driveErr ? <div style={{ color: "var(--c-danger)", fontSize: 11.5, marginTop: 5 }}>Sign-in failed: {driveErr}</div> : null}
                      </>
                    ) : (
                      <Link to="/projects" style={{ color: "var(--cobalt)", fontSize: 12, textDecoration: "underline" }}>
                        browse your Google Drive projects
                      </Link>
                    )}
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px auto 16px", color: "var(--text-faint)", fontFamily: "var(--f-mono)", fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase" }}>
                  <span style={{ flex: 1, height: 1, background: "var(--ink-faint)" }} />new here?<span style={{ flex: 1, height: 1, background: "var(--ink-faint)" }} />
                </div>
                <button onClick={loadSample} disabled={sampleBusy} title="Open a real floor finish plan and try a takeoff"
                  style={{ display: "inline-flex", alignItems: "center", gap: 9, padding: "13px 22px", border: "1px solid var(--ink)", background: "var(--cobalt)", color: "var(--paper-bright)", cursor: sampleBusy ? "default" : "pointer", opacity: sampleBusy ? 0.65 : 1, fontWeight: 700, fontSize: 14, fontFamily: "var(--f-body)" }}>
                  <Icon name="takeoff" size={16} />{sampleBusy ? "Loading sample…" : "Load sample plan"}
                </button>
                <div style={{ fontFamily: "var(--f-body)", fontSize: 12.5, color: "var(--ink-muted)", marginTop: 11, lineHeight: 1.6 }}>
                  A real medical-center <strong style={{ color: "var(--ink)" }}>floor finish plan</strong> — the scale auto-detects;
                  pick a finish and trace a flooring takeoff in seconds.
                </div>
              </div>
            ) : enumerated ? (
              <>
                <div style={{ fontFamily: "var(--f-display)", fontSize: 16, color: "var(--ink)", marginBottom: 6 }}>Couldn't read those PDFs</div>
                None of the opened files would render — try opening them again.
              </>
            ) : "Reading the plan set…"}
          </div>
        )}
      </div>
      {sheets.length > 0 && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "12px 18px", borderTop: "1px solid var(--ink)", background: "var(--paper-bright)" }}>
          <span style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink-muted)" }}>{sel.length ? `${sel.length} selected` : "select sheets, or hover a card and hit View"}</span>
          <div style={{ flex: 1 }} />
          {sel.length > 0 && (
            <>
              <button onClick={assignLevel} title="Group the selected sheets under a floor/level — the gallery sorts by it and tabs carry the label"
                style={{ padding: "7px 12px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12 }}>Assign level…</button>
              <button onClick={() => setSel([])} style={{ padding: "7px 12px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>Clear</button>
            </>
          )}
          <button disabled={!sel.length} onClick={() => onOpen(sel, false)}
            style={{ padding: "8px 14px", border: "1px solid var(--ink)", background: "transparent", color: "var(--ink)", cursor: sel.length ? "pointer" : "default", opacity: sel.length ? 1 : 0.4, fontWeight: 700, fontSize: 12.5 }}>
            Open {sel.length || ""} as tabs
          </button>
          <button disabled={sel.length < 2 || sel.length > MAX_GROUP} onClick={() => onOpen(sel, true)}
            title={sel.length > MAX_GROUP ? `Side-by-side maxes at ${MAX_GROUP} — open as tabs instead` : "One pan/zoom moves the whole row"}
            style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px", border: "none", background: sel.length >= 2 && sel.length <= MAX_GROUP ? "var(--cobalt)" : "var(--ink-faint)", color: "var(--paper-bright)", cursor: sel.length >= 2 && sel.length <= MAX_GROUP ? "pointer" : "default", fontWeight: 700, fontSize: 12.5 }}>
            <Icon name="sideBySide" size={14} />Open {sel.length >= 2 ? sel.length : ""} side-by-side
          </button>
        </div>
      )}
    </>
  );

  // ── close/remove confirmation ───────────────────────────────────────────
  const confirmDialog = confirmClose && (
    <div onClick={() => setConfirmClose(null)} style={{ position: "absolute", inset: 0, zIndex: 5, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="panel" style={{ width: 440, maxWidth: "100%", background: "var(--paper-bright)", boxShadow: "var(--shadow-2)", padding: "18px 20px" }}>
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 15, color: "var(--ink)" }}>Close “{confirmClose.file}”?</strong>
        <p style={{ fontSize: 12.5, color: "var(--ink-muted)", lineHeight: 1.6, margin: "10px 0 4px" }}>
          {cloudMode
            ? "Closing removes it from this plan set so it stops loading — the file stays in your Drive project and you can re-add it any time from Browse Drive."
            : "This removes the PDF from the plan set. Local plans aren't stored anywhere else, so you'll have to re-open the file to get it back."}
          {confirmClose.shapeCount > 0 && (
            <><br /><span style={{ color: "var(--c-warning)" }}>This PDF has {confirmClose.shapeCount} takeoff{confirmClose.shapeCount === 1 ? "" : "s"} — they're preserved and restore if you re-add the same file.</span></>
          )}
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16, flexWrap: "wrap" }}>
          <button onClick={() => setConfirmClose(null)} style={{ ...ctrlBtn, color: "var(--ink-muted)" }}>Cancel</button>
          {cloudMode && onRemoveFromProject && (
            <button onClick={doRemove} title="Permanently delete the PDF from the Drive project"
              style={{ ...ctrlBtn, border: "1px solid var(--c-danger)", color: "var(--c-danger)" }}>Delete from Drive</button>
          )}
          <button onClick={doClose}
            style={{ ...ctrlBtn, border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)", fontWeight: 700 }}>
            {cloudMode ? "Close (keep in Drive)" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );

  const inner = (
    <div className={canClose ? "panel" : undefined}
      onClick={canClose ? (e) => e.stopPropagation() : undefined}
      onDragOver={(e) => { if (onAddFiles) e.preventDefault(); }}
      onDrop={(e) => { if (onAddFiles) { e.preventDefault(); onAddFiles(e.dataTransfer?.files); } }}
      style={canClose
        ? { position: "relative", width: "min(1100px, 92vw)", height: "85vh", display: "flex", flexDirection: "column", background: "var(--paper-cream)", boxShadow: "var(--shadow-2)", overflow: "hidden" }
        : { position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--paper-cream)" }}>
      {header}
      {mode === "browse" ? browseBody : planBody}
      {confirmDialog}
    </div>
  );

  // canClose → modal over dimmed canvas (Esc/scrim-click exit); else full-screen,
  // non-dismissible (nowhere to go back to — this is the onboarding surface).
  if (canClose) {
    // Scrim click is a dismiss gesture → exit straight to the canvas (not the
    // mode-aware back(), which would climb a folder level instead of closing).
    return (
      <div onClick={onExit} style={{ position: "absolute", inset: 0, zIndex: 45, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        {inner}
      </div>
    );
  }
  return <div style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", flexDirection: "column" }}>{inner}</div>;
}
