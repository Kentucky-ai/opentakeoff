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
import { Link, useNavigate } from "react-router";
import { Icon } from "../brand/icons.jsx";
import AuthChip from "./AuthChip.jsx";
import { useGoogleAuth } from "../lib/google/AuthContext.jsx";
import { parseSheetKey, extractSheetNumber, detectScale, RENDER_SCALE, MAX_GROUP } from "../lib/sheets";
import { isGoogleConfigured } from "../lib/google/auth.js";
import { projectHomeFolderId } from "../lib/projectHome.js";
import { isFolderSyncSupported, loadFolderLink, linkFolder, forgetFolder, queryFolderPermission } from "../lib/fs/fsAccess.js";
import { listConflictCopies } from "../lib/fs/fsProvider.js";
import { m365Config, M365_ENABLED_KEY } from "../lib/msgraph/config.js";
import { metaGet, metaPut, metaDelete } from "../lib/store.js";
import { groupSheetsByLevel, sortGalleryGroups } from "../lib/sheetLevels.js";
import { renderThumb, loadThumb, saveThumb, thumbPixelWidth } from "../lib/thumbs.js";

// Thumbnails in flight at once. The canvas rasters in its worker pool now, so
// the main thread's pdf.js is mostly idle while the gallery is up; two keeps
// a 3-core laptop responsive while halving the wave on a big set.
const THUMB_PAR = 2;
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
  sheets, getDoc, scales, detectedScales, scaleUnconfirmed = {}, shapes, labels, onLabel, onDetect,
  thumbCacheRef, busyRef, openTabs, onOpen,
  onAddFiles, onClosePdf, onRemoveFromProject,
  // manage mode (#301/#302): bulk close + workspace reset, and the persisted
  // page-count cache that lets a known set open without reading its bytes
  onCloseMany, onClearWorkspace, knownPages = {}, onPages,
  onCloseProject, onBrowseProjects,
  levels = {}, onAssignLevel,
  // stitches (#161): persisted match-line composites — created from a 2..MAX_GROUP
  // selection, reopened/deleted from their strip
  stitches = [], onStitch, onOpenStitch, onDeleteStitch,
  // browse (Drive) data
  listFolder, addSheets, onAdded,
}) {
  const navigate = useNavigate();
  const { user, signIn } = useGoogleAuth();
  const browseEnabled = cloudMode && typeof listFolder === "function";
  const [mode, setMode] = useState(browseEnabled && initialMode === "browse" ? "browse" : "plan");

  // ── 365 sync (#315, experimental): opt-in state + preloaded auth ────────
  // Rendered only when the BUILD is configured for a document library; the
  // MSAL module preloads on mount so the click handler keeps its user gesture
  // for the popup. Activating 365 hides the folder entry (one shadow at a
  // time — the workspace gate picks 365 first).
  const m365Cfg = !cloudMode ? m365Config() : null;
  const [m365Active, setM365Active] = useState(false);
  const [m365Err, setM365Err] = useState("");
  const m365AuthRef = useRef(null);
  useEffect(() => {
    if (!m365Cfg) return;
    let live = true;
    metaGet(M365_ENABLED_KEY).then((v) => { if (live) setM365Active(v === true); }).catch(() => {});
    import("../lib/msgraph/auth.js")
      .then(({ createMsalAuth }) => { if (live) m365AuthRef.current = createMsalAuth(m365Cfg); })
      .catch(() => { /* module load failure surfaces on click as a readable error */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const doLinkM365 = async () => {
    setM365Err("");
    try {
      const auth = m365AuthRef.current;
      if (!auth) throw new Error("sign-in module didn't load — check the console and report on issue #315");
      await auth.signIn(); // popup — needs this click's gesture
      await metaPut(M365_ENABLED_KEY, true);
      window.location.reload(); // the workspace gate installs the 365 store
    } catch (e) {
      setM365Err(String(e?.message || e));
    }
  };
  const doStopM365 = async () => {
    await metaDelete(M365_ENABLED_KEY);
    window.location.reload();
  };

  // ── folder sync (#316): the local workspace's link state ────────────────
  // Local mode + Chromium only; on other engines (or in cloud mode) none of
  // this UI renders — degrade with no dead controls. Conflict copies are the
  // sync client's fork files ("annotations (1).json") — surfaced by name so a
  // fork is a visible thing to resolve, never an orphan.
  const folderUiOn = !cloudMode && isFolderSyncSupported() && !m365Active;
  const [folderLink, setFolderLink] = useState(null);
  const [folderCopies, setFolderCopies] = useState([]);
  useEffect(() => {
    if (!folderUiOn) return;
    let live = true;
    (async () => {
      const l = await loadFolderLink().catch(() => null);
      if (!live || !l) return;
      setFolderLink(l);
      if ((await queryFolderPermission(l.handle)) !== "granted") return;
      const copies = await listConflictCopies(async () => l.handle).catch(() => []);
      if (live) setFolderCopies(copies);
    })();
    return () => { live = false; };
  }, [folderUiOn]);
  // Link/unlink both reload: the store swap must happen before the canvas
  // mounts (FolderGate's install-then-mount), and a reload IS that path.
  const doLinkFolder = async () => {
    const l = await linkFolder();
    if (l) window.location.reload();
  };
  const doForgetFolder = async () => {
    await forgetFolder();
    window.location.reload();
  };

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
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      // "?" is app-level help, not a canvas tool shortcut, so it is not ours to
      // swallow — and this screen is exactly where someone reaches for it. With
      // no plan open the navigator is what's mounted, so suppressing "?" here
      // meant the manual could not be opened by keyboard by the one person most
      // likely to want it: a first-time visitor who has not loaded anything yet.
      if (e.key === "?") return;
      e.stopPropagation();
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
  // ══ MANAGE state (#301) ═══════════════════════════════════════════════════
  const [mSel, setMSel] = useState([]);            // file names checked in manage mode
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [working, setWorking] = useState(false);   // a bulk remove / clear in flight
  const [, bump] = useState(0);
  const seqRef = useRef(0);
  const queueRef = useRef([]);
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

  // enumerate page counts. The persisted cache answers a known file instantly —
  // no byte read, no pdf.js doc — which is what lets a large plan set's gallery
  // open without loading the set (#302). Only files the cache can't answer for
  // load a doc here, and what they learn is reported up (onPages) so the NEXT
  // open is instant too. Thumbnails stay scroll-lazy either way (the observer/
  // pump below loads a doc only when a card actually becomes visible).
  const pageOf = (name) => pages[name] !== undefined ? pages[name] : knownPages[name];
  useEffect(() => {
    const seq = ++seqRef.current;
    (async () => {
      for (const s of sheets) {
        // truthy counts are settled; a 0 (unreadable last try) retries on the
        // next sheets change, matching the old enumerate's healing behavior —
        // a removed-and-re-added file must not stay hidden behind a stale 0
        if (pageOf(s.name)) continue;
        try {
          const pdf = await getDoc(s.name);
          if (seq !== seqRef.current) return;
          const n = pdf.numPages || 1;
          setPages((m) => (m[s.name] ? m : { ...m, [s.name]: n }));
          onPages?.(s.name, n);
        } catch { if (seq === seqRef.current) setPages((m) => (m[s.name] !== undefined ? m : { ...m, [s.name]: 0 })); }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { seqRef.current++; };
    // pageOf/onPages are stable per render pass — knownPages is the real signal
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheets, getDoc, knownPages]);

  const allKeys = sheets.flatMap((s) => {
    const n = pageOf(s.name);
    if (!n) return [];
    return Array.from({ length: n }, (_, i) => (i ? `${s.name}#${i + 1}` : s.name));
  });

  // a one-sheet project has nothing to choose — open it, but ONLY on the first
  // landing (no tab open yet). Without the openTabs guard this fires on every
  // remount: reopening the gallery for a 1-sheet project would enumerate, auto-
  // open, and bounce straight back to the canvas — leaving Add plans / Browse
  // Drive permanently unreachable.
  const enumerated = sheets.length > 0 && sheets.every((s) => pageOf(s.name) !== undefined);
  useEffect(() => {
    if (mode === "plan" && enumerated && allKeys.length === 1 && openTabs.length === 0) onOpen([allKeys[0]], false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, knownPages, mode]);

  // One card's thumbnail: persisted record first (no pdf.js doc, no raster —
  // the whole reason a known set's gallery opens instantly), else raster at
  // this screen's density, persist, and read the sheet number + plan-noted
  // scale off the same page while it's warm. Any failure just skips the card
  // (destroyed doc on unmount / render-cancel).
  const thumbOne = async (key, seq) => {
    if (thumbCacheRef.current.has(key)) return;
    const want = thumbPixelWidth();
    let rec = await loadThumb(key, want);
    if (seq !== seqRef.current) return;
    if (!rec) {
      const { file, page } = parseSheetKey(key);
      const pdf = await getDoc(file);
      const pg = await pdf.getPage(page);
      if (seq !== seqRef.current) return;
      rec = await renderThumb(pg, want);
      if (seq !== seqRef.current) return;
      if (!labels[key] || !detectedScales[key]) {
        try {
          const tc = await pg.getTextContent();
          const vpL = pg.getViewport({ scale: RENDER_SCALE });
          rec.label = extractSheetNumber(tc, vpL) || null;
          rec.det = detectScale(tc, vpL) || null;
        } catch { /* text layer is optional */ }
      }
      saveThumb(key, rec);
    }
    if (thumbCacheRef.current.has(key)) return;
    thumbCacheRef.current.set(key, URL.createObjectURL(rec.blob));
    if (rec.label && !labels[key]) onLabel(key, rec.label);
    if (rec.det && !detectedScales[key]) onDetect(key, rec.det);
    scheduleBump();
  };

  // coalesce card reveals to one React render per frame
  const bumpRafRef = useRef(0);
  const scheduleBump = () => {
    if (bumpRafRef.current) return;
    bumpRafRef.current = requestAnimationFrame(() => { bumpRafRef.current = 0; bump((n) => n + 1); });
  };

  const activeRef = useRef(0);
  const pump = () => {
    while (activeRef.current < THUMB_PAR && queueRef.current.length) {
      const seq = seqRef.current;
      const key = queueRef.current.shift();
      if (thumbCacheRef.current.has(key)) continue;
      activeRef.current++;
      (async () => {
        // the canvas's own open sequence (doc → page → geometry) owns the main
        // thread for its moment; yield to it rather than compete
        while (busyRef.current === "rendering" && seq === seqRef.current) await new Promise((r) => setTimeout(r, 150));
        if (seq !== seqRef.current) return;
        await thumbOne(key, seq);
      })().catch((e) => {
        // a destroyed doc (unmount / render-cancel) is routine; anything else
        // used to vanish into a bare catch and read as "thumbnails never load"
        if (!/destroyed|cancel/i.test(String(e?.message || e))) console.warn(`[thumbs] ${key}:`, e);
      }).finally(() => { activeRef.current--; pump(); });
    }
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
  // Cards commit their ref callbacks BEFORE the mount effect above creates
  // the observer, so a gallery whose page counts are all known up front
  // (#302's persisted cache — the common reopen) rendered every card in the
  // first pass and none of them was ever observed: 19 skeletons, forever.
  // Sweep the grid after every key-set change and hand the observer whatever
  // it hasn't seen; observe() on an already-observed element is a no-op.
  const gridRef = useRef(null);
  const keySig = allKeys.join("\u0000");
  useEffect(() => {
    const obs = obsRef.current, grid = gridRef.current;
    if (!obs || !grid) return;
    for (const el of grid.querySelectorAll("[data-sheetkey]")) {
      if (!thumbCacheRef.current.has(el.dataset.sheetkey)) obs.observe(el);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySig, mode]);

  const toggleSel = (key) => setSel((g) => (g.includes(key) ? g.filter((k) => k !== key) : [...g, key]));
  // shape tallies once per shapes change, not once per card per render — a
  // thumbnail reveal re-renders the grid, and N cards × M shapes added up
  const shapeTally = useMemo(() => {
    const bySheet = new Map(), byFile = new Map();
    for (const s of shapes) {
      bySheet.set(s.sheet_id, (bySheet.get(s.sheet_id) || 0) + 1);
      const f = parseSheetKey(s.sheet_id).file;
      byFile.set(f, (byFile.get(f) || 0) + 1);
    }
    return { bySheet, byFile };
  }, [shapes]);
  const shapeCount = (key) => shapeTally.bySheet.get(key) || 0;
  const pdfShapeCount = (file) => shapeTally.byFile.get(file) || 0;
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
    if (mode === "manage") { setMode("plan"); return; }
    if (canClose) onExit();
  }, [mode, path.length, canClose, onExit]);
  const canGoBack = mode === "browse" || mode === "manage" || canClose;
  // Esc: leave the current mode in one press (browse/manage → plan, plan →
  // canvas), independent of the back button's per-level folder climb.
  useEffect(() => {
    escRef.current = () => {
      if (mode === "browse" || mode === "manage") { setMode("plan"); return; }
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
  const title = mode === "browse" ? "Add sheets from Drive" : mode === "manage" ? "Manage plan set" : "Plan set";
  const subtitle = mode === "browse"
    ? "pick the PDFs to open — specs & as-builts stay unopened"
    : mode === "manage"
      ? `${sheets.length} PDF${sheets.length === 1 ? "" : "s"} stored in this workspace — remove what this takeoff doesn't need`
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
      {mode === "plan" && sheets.length > 0 && (onCloseMany || onClearWorkspace) && (
        <button onClick={() => { setMSel([]); setMode("manage"); }}
          title="Manage the plan set — remove several PDFs at once, or clear the whole workspace"
          style={ctrlBtn}>
          <Icon name="sheets" size={13} />Manage
        </button>
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
        <input name="sheet-file" ref={fileRef} type="file" accept=".pdf,application/pdf,image/*,.zip,application/zip,application/x-zip-compressed,.otk" multiple style={{ display: "none" }}
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
      <div ref={gridRef} style={{ flex: 1, overflow: "auto", padding: 18 }}>
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
                    ? <img src={thumb} alt={labelOf(key)} decoding="async" draggable={false} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                    : <div className="skeleton" style={{ width: "86%", height: "78%" }} />}
                </div>
                <div style={{ padding: "8px 10px", display: "flex", alignItems: "baseline", gap: 8 }}>
                  <strong style={{ fontFamily: "var(--f-mono)", fontSize: 12.5, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }} title={key}>{labelOf(key)}</strong>
                  {levels[key] && <span title="Level" style={{ fontSize: 9.5, fontFamily: "var(--f-mono)", color: "var(--ink-muted)", border: "1px solid var(--ink-faint)", padding: "1px 5px" }}>{levels[key]}</span>}
                  {isOpenTab && <span title="Already open as a tab" style={{ fontSize: 9.5, fontFamily: "var(--f-mono)", color: "var(--cobalt)", textTransform: "uppercase", letterSpacing: "0.08em" }}>open</span>}
                  {cnt > 0 && <span style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, color: "var(--ink-muted)" }}>{cnt}▦</span>}
                  <span style={{ fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", color: scales[key] ? (scaleUnconfirmed[key] === false ? "var(--c-warning)" : "var(--c-positive)") : detectedScales[key] ? "var(--c-warning)" : "var(--c-danger)" }}
                    title={scales[key] && scaleUnconfirmed[key] === false ? "Scale set by an agent — no person has confirmed it. Open the sheet and confirm from the scale menu." : undefined}>
                    {scales[key] ? (scaleUnconfirmed[key] === false ? "scale ⚠ confirm" : "scale ✓") : detectedScales[key] ? `plan: ${detectedScales[key].label}` : "no scale"}
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
                <div style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--cobalt)", marginBottom: 6 }}>People &amp; agents · one engine</div>
                <div style={{ fontFamily: "var(--f-display)", fontSize: 18, color: "var(--ink)", lineHeight: 1.32, marginBottom: 5 }}>Measure a plan by hand — or point an AI&nbsp;agent at the same engine.</div>
                <div style={{ fontSize: 13, color: "var(--ink-muted)", lineHeight: 1.55, marginBottom: 20 }}>Every measurement keeps its scale and how it was made — a person, one click, or an agent.</div>
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
                {m365Cfg && (
                  <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
                    {!m365Active ? (
                      <>
                        <button type="button" onClick={doLinkM365}
                          title="Sign in with your work account and sync this workspace through the configured document library. Experimental (issue #315) — tokens stay in this browser."
                          style={{ border: "none", background: "transparent", padding: 0, color: "var(--cobalt)", cursor: "pointer", fontSize: 12, textDecoration: "underline", fontFamily: "var(--f-body)" }}>
                          or sync through your Microsoft 365 library (experimental)
                        </button>
                        {m365Err ? <div style={{ color: "var(--c-danger)", fontSize: 11.5, marginTop: 5 }}>365 sign-in failed: {m365Err}</div> : null}
                      </>
                    ) : (
                      <span style={{ color: "var(--ink-muted)" }}>
                        syncing through your <strong style={{ color: "var(--ink)" }}>Microsoft 365 library</strong>
                        {" · "}
                        <button type="button" onClick={doStopM365}
                          style={{ border: "none", background: "transparent", padding: 0, color: "var(--c-danger)", cursor: "pointer", fontSize: 12, textDecoration: "underline", fontFamily: "var(--f-body)" }}>
                          stop
                        </button>
                      </span>
                    )}
                  </div>
                )}
                {folderUiOn && (
                  <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6 }}>
                    {!folderLink ? (
                      <button type="button" onClick={doLinkFolder}
                        title="Pick a folder your team already syncs (a network share, a synced document library) — the takeoff syncs through it as one JSON file. No account, no credentials; the folder's own sync client does the transport."
                        style={{ border: "none", background: "transparent", padding: 0, color: "var(--cobalt)", cursor: "pointer", fontSize: 12, textDecoration: "underline", fontFamily: "var(--f-body)" }}>
                        or sync this workspace through a shared folder
                      </button>
                    ) : (
                      <span style={{ color: "var(--ink-muted)" }}>
                        syncing through folder <strong style={{ color: "var(--ink)" }}>“{folderLink.name}”</strong>
                        {" · "}
                        <button type="button" onClick={doForgetFolder}
                          style={{ border: "none", background: "transparent", padding: 0, color: "var(--c-danger)", cursor: "pointer", fontSize: 12, textDecoration: "underline", fontFamily: "var(--f-body)" }}>
                          stop
                        </button>
                      </span>
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
                <div style={{ marginTop: 30, fontFamily: "var(--f-mono)", fontSize: 10.5, letterSpacing: "0.1em", color: "var(--text-faint)" }}>
                  Apache-2.0 open source · an open project by{" "}
                  <a href="https://kentucky-ai.com" target="_blank" rel="noopener" style={{ color: "var(--ink-muted)" }}>Kentucky&nbsp;AI</a>
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
      {stitches.length > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "9px 18px", borderTop: "1px solid var(--ink-faint)", background: "var(--paper-bright)" }}>
          <span style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--ink-muted)" }}>Stitched surfaces</span>
          {stitches.map((st) => (
            <span key={st.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--ink-faint)", padding: "4px 8px", fontSize: 12 }}>
              <button onClick={() => onOpenStitch && onOpenStitch(st.id)} title={`Open ${st.name} — ${st.members.length} sheets as one working surface`}
                style={{ border: "none", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontWeight: 600, fontSize: 12, padding: 0 }}>{st.name}</button>
              <button onClick={() => onDeleteStitch && onDeleteStitch(st.id)} title="Delete this stitch (refused while takeoffs live on it)"
                style={{ border: "none", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12, padding: 0 }}>×</button>
            </span>
          ))}
        </div>
      )}
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
          {onStitch && (
            <button disabled={sel.length < 2 || sel.length > MAX_GROUP} onClick={() => onStitch(sel)}
              title={sel.length > MAX_GROUP ? `A stitch maxes at ${MAX_GROUP} sheets` : "Stitch — join a floor split at a match line into ONE working surface: the sheets butt edge-to-edge (no gap), you align the match line with two clicks, then a room crossing it traces as one shape"}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 14px", border: "1px solid var(--ink)", background: "transparent", color: sel.length >= 2 && sel.length <= MAX_GROUP ? "var(--ink)" : "var(--ink-faint)", cursor: sel.length >= 2 && sel.length <= MAX_GROUP ? "pointer" : "default", fontWeight: 700, fontSize: 12.5 }}>
              <Icon name="calibrate" size={14} />Stitch {sel.length >= 2 ? sel.length : ""} into one surface
            </button>
          )}
        </div>
      )}
    </>
  );

  // ── MANAGE body + footer (#301) ─────────────────────────────────────────
  // The bulk counterpart of the per-card ✕: pick several PDFs and remove them
  // in one operation, or clear the whole workspace. Removal here is closePdf's
  // semantics exactly — takeoffs persist in the project and restore on re-add —
  // the row says which PDFs actually carry takeoffs so nothing is assumed unused.
  const mToggle = (name) => setMSel((g) => (g.includes(name) ? g.filter((n) => n !== name) : [...g, name]));
  const mAll = sheets.length > 0 && mSel.length === sheets.length;
  const mSelShapes = mSel.reduce((n, f) => n + pdfShapeCount(f), 0);
  const doBulkRemove = async () => {
    setConfirmBulk(false); setWorking(true);
    try { await onCloseMany(mSel); setMSel([]); setMode("plan"); }
    finally { setWorking(false); }
  };
  const doClear = async () => {
    setConfirmClear(false); setWorking(true);
    try { await onClearWorkspace(); setMSel([]); setMode("plan"); }
    finally { setWorking(false); }
  };
  const manageBody = (
    <>
      <div style={{ flex: 1, overflow: "auto" }}>
        <label style={{ ...rowBase, cursor: "pointer", background: "var(--well)" }}>
          <input name="manage-all" type="checkbox" checked={mAll} onChange={() => setMSel(mAll ? [] : sheets.map((s) => s.name))} style={{ width: 16, height: 16, cursor: "pointer" }} />
          <span style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" }}>{mAll ? "Clear selection" : "Select all"}</span>
        </label>
        {sheets.map((s) => {
          const pg = pageOf(s.name);
          const cnt = pdfShapeCount(s.name);
          const tabsOpen = openTabs.filter((k) => parseSheetKey(k).file === s.name).length;
          return (
            <label key={s.name} style={{ ...rowBase, cursor: "pointer" }}>
              <input name="manage-pick" type="checkbox" checked={mSel.includes(s.name)} onChange={() => mToggle(s.name)} style={{ width: 16, height: 16, cursor: "pointer" }} />
              <span style={{ fontFamily: "var(--f-mono)", fontSize: 13, color: "var(--ink)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.name}>{s.name}</span>
              {tabsOpen > 0 && <span style={{ fontFamily: "var(--f-mono)", fontSize: 9.5, color: "var(--cobalt)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{tabsOpen} open</span>}
              <span style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink-muted)", minWidth: 74, textAlign: "right" }}>{pg !== undefined ? `${pg || "?"} sheet${pg === 1 ? "" : "s"}` : "…"}</span>
              <span title={cnt ? "This PDF carries takeoffs — they persist in the project and restore if you re-add the same file" : undefined}
                style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: cnt ? "var(--c-warning)" : "var(--text-faint)", minWidth: 88, textAlign: "right" }}>
                {cnt ? `${cnt} takeoff${cnt === 1 ? "" : "s"}` : "no takeoffs"}
              </span>
            </label>
          );
        })}
        {!sheets.length && (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>The workspace is empty — nothing stored.</div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderTop: "1px solid var(--ink)", background: "var(--paper-bright)", flexWrap: "wrap" }}>
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 11.5, color: "var(--ink-muted)" }}>
          {working ? "Working…" : mSel.length ? `${mSel.length} PDF${mSel.length === 1 ? "" : "s"} selected${mSelShapes ? ` · ${mSelShapes} takeoff${mSelShapes === 1 ? "" : "s"} on them` : ""}` : "check the PDFs to remove — removing never deletes takeoff data"}
        </span>
        <div style={{ flex: 1 }} />
        {m365Cfg && m365Active && (
          <span title="Annotations sync through the configured Microsoft 365 document library (experimental — issue #315)"
            style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink-muted)" }}>
            ⇄ 365 library{" "}
            <button onClick={doStopM365} title="Stop syncing through the 365 library — local work stays in this browser"
              style={{ border: "none", background: "transparent", padding: 0, color: "var(--c-danger)", cursor: "pointer", fontSize: 11, textDecoration: "underline", fontFamily: "var(--f-mono)" }}>
              stop
            </button>
          </span>
        )}
        {folderUiOn && (folderLink ? (
          <span title={folderCopies.length ? `The folder's sync client forked the annotations file — someone should reconcile these by hand:\n${folderCopies.join("\n")}` : `Annotations sync through “${folderLink.name}” — the folder's own sync client replicates them`}
            style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: folderCopies.length ? "var(--c-warning)" : "var(--ink-muted)" }}>
            ⇄ “{folderLink.name}”{folderCopies.length ? ` · ${folderCopies.length} conflict cop${folderCopies.length === 1 ? "y" : "ies"}` : ""}
            {" "}
            <button onClick={doForgetFolder} title="Stop syncing through this folder — local work stays in this browser"
              style={{ border: "none", background: "transparent", padding: 0, color: "var(--c-danger)", cursor: "pointer", fontSize: 11, textDecoration: "underline", fontFamily: "var(--f-mono)" }}>
              stop
            </button>
          </span>
        ) : (
          <button onClick={doLinkFolder} disabled={working}
            title="Pick a folder your team already syncs — the takeoff syncs through it as one JSON file, no credentials involved"
            style={{ ...ctrlBtn, opacity: working ? 0.5 : 1 }}>Sync through a folder…</button>
        ))}
        {onClearWorkspace && (
          <button onClick={() => setConfirmClear(true)} disabled={working}
            title="Remove every stored PDF and reset the takeoff — a snapshot of a non-empty takeoff is saved first (Revisions restores it)"
            style={{ ...ctrlBtn, border: "1px solid var(--c-danger)", color: "var(--c-danger)", opacity: working ? 0.5 : 1 }}>Clear workspace…</button>
        )}
        <button onClick={() => setConfirmBulk(true)} disabled={!mSel.length || working}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 16px", border: "1px solid var(--ink)", background: mSel.length && !working ? "var(--ink)" : "var(--ink-faint)", color: "var(--paper-bright)", cursor: mSel.length && !working ? "pointer" : "default", fontWeight: 700, fontSize: 13 }}>
          Remove {mSel.length || ""} selected
        </button>
      </div>
    </>
  );

  const bulkDialog = confirmBulk && (
    <div onClick={() => setConfirmBulk(false)} style={{ position: "absolute", inset: 0, zIndex: 5, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="panel" style={{ width: 460, maxWidth: "100%", background: "var(--paper-bright)", boxShadow: "var(--shadow-2)", padding: "18px 20px" }}>
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 15, color: "var(--ink)" }}>Remove {mSel.length} PDF{mSel.length === 1 ? "" : "s"} from the plan set?</strong>
        <p style={{ fontSize: 12.5, color: "var(--ink-muted)", lineHeight: 1.6, margin: "10px 0 4px" }}>
          {cloudMode
            ? "They stop loading in this plan set — the files stay in your Drive project and re-add any time from Browse Drive."
            : "Their stored bytes are removed from this browser. Local plans aren't stored anywhere else, so you'd re-open the files to get them back."}
          {mSelShapes > 0 && (
            <><br /><span style={{ color: "var(--c-warning)" }}>{mSelShapes} takeoff{mSelShapes === 1 ? "" : "s"} live on these PDFs — they're preserved in the project and restore if you re-add the same files.</span></>
          )}
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={() => setConfirmBulk(false)} style={{ ...ctrlBtn, color: "var(--ink-muted)" }}>Cancel</button>
          <button onClick={doBulkRemove} style={{ ...ctrlBtn, border: "1px solid var(--ink)", background: "var(--ink)", color: "var(--paper-bright)", fontWeight: 700 }}>Remove {mSel.length}</button>
        </div>
      </div>
    </div>
  );

  const clearDialog = confirmClear && (
    <div onClick={() => setConfirmClear(false)} style={{ position: "absolute", inset: 0, zIndex: 5, background: "var(--scrim)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} className="panel" style={{ width: 460, maxWidth: "100%", background: "var(--paper-bright)", boxShadow: "var(--shadow-2)", padding: "18px 20px" }}>
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 15, color: "var(--c-danger)" }}>Clear the whole workspace?</strong>
        <p style={{ fontSize: 12.5, color: "var(--ink-muted)", lineHeight: 1.6, margin: "10px 0 4px" }}>
          Every stored PDF ({sheets.length}) is removed and the takeoff resets to empty — a clean start without touching browser storage by hand.
          <br /><span style={{ color: "var(--ink)" }}>A non-empty takeoff is snapshotted first</span> — Revisions → restore brings it back (you'd re-open the same PDFs to see its shapes). The PDFs themselves aren't stored anywhere else.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={() => setConfirmClear(false)} style={{ ...ctrlBtn, color: "var(--ink-muted)" }}>Cancel</button>
          <button onClick={doClear} style={{ ...ctrlBtn, border: "1px solid var(--c-danger)", background: "var(--c-danger)", color: "var(--paper-bright)", fontWeight: 700 }}>Clear workspace</button>
        </div>
      </div>
    </div>
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
      {mode === "browse" ? browseBody : mode === "manage" ? manageBody : planBody}
      {confirmDialog}
      {bulkDialog}
      {clearDialog}
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
