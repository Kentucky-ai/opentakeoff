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
import SheetPreview from "./SheetPreview.jsx";
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
import * as pdfjsLib from "pdfjs-dist";
import { runPlanSearch, filesToIndex, pagesToIndex, galleryEscStep, createChangeSignal, needsRead, keysToLookUp, canLookUp, galleryReadView, unreadLine, thumbIndexStep, adoptEntry, galleryCountLine, needsTextPass, createWalkFailures, searchFailedLine, retryWalk } from "../lib/planSearch";
import { measurePage } from "../lib/pictures";
import { inOtherModal, otherModalOpen } from "../lib/modalKeys";

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
  canClose, onExit, onPremium, initialMode = "plan", cloudMode,
  // plan-set (gallery) data
  sheets, withDoc, withLoadedDoc, scales, detectedScales, scaleUnconfirmed = {}, shapes, labels, onLabel, onDetect,
  thumbCacheRef, busyRef, openTabs, onOpen,
  // plan-set search (#471): the canvas-owned index map, a subscription to its
  // changes (at most one call a frame), the setter that stores one sheet's
  // entry, and whether the canvas holds a sheet's pdf.js page
  planIndexRef, subscribeIndex, onIndexed, pageHeld, docLoaded,
  // on-device page reads (#471), the canvas's (TakeoffCanvas ocrApi): enabled,
  // availability(), read(key, {force, signal}), cancel, status, subscribe,
  // lookup(key). A read or lookup hit is already in the index when it lands.
  ocr,
  onAddFiles, onClosePdf, onRemoveFromProject,
  // manage mode (#301/#302): bulk close + workspace reset, and the persisted
  // page-count cache that lets a known set open without reading its bytes
  onCloseMany, onClearWorkspace, knownPages = {}, onPages,
  onCloseProject, onBrowseProjects,
  levels = {}, onAssignLevel,
  // sheet-number namer (Sheets tree): the file's naming generation, and an offer of page text already read
  nameGen, onSheetText,
  // stitches (#161): persisted match-line composites — created from a 2..MAX_GROUP
  // selection, reopened/deleted from their strip
  stitches = [], onStitch, onOpenStitch, onDeleteStitch,
  // browse (Drive) data
  listFolder, addSheets, onAdded,
}) {
  const navigate = useNavigate();
  const [previewSheet, setPreviewSheet] = useState(null);
  const previewOpenRef = useRef(false);
  previewOpenRef.current = !!previewSheet;
  const [previewSize, setPreviewSize] = useState("large");
  const closePreview = useCallback(() => setPreviewSheet(null), []);
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
      if (previewOpenRef.current || inOtherModal(e.target)) return; // The preview (and the OCR download notice) own Escape and focus.
      if (e.key === "Escape" && otherModalOpen(document)) return; // a modal over the gallery (guide, OCR notice) takes Esc, focus anywhere
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
  // ══ SEARCH state (#471) ═══════════════════════════════════════════════════
  // Plan mode only. Any mode switch clears the query — adjusted during render
  // (React's "reset state when a value changes" pattern), so no effect runs.
  const [query, setQuery] = useState("");
  const [queryMode, setQueryMode] = useState(mode);
  if (queryMode !== mode) { setQueryMode(mode); setQuery(""); }
  const searching = mode === "plan" && query.trim() !== "" && !!planIndexRef;
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
          const n = await withDoc(s.name, (pdf) => pdf.numPages || 1);
          if (seq !== seqRef.current) return;
          setPages((m) => (m[s.name] ? m : { ...m, [s.name]: n }));
          onPages?.(s.name, n);
        } catch { if (seq === seqRef.current) setPages((m) => (m[s.name] !== undefined ? m : { ...m, [s.name]: 0 })); }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { seqRef.current++; };
    // pageOf/onPages are stable per render pass — knownPages is the real signal
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheets, withDoc, knownPages]);

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
    const kept = !!rec;
    // the card's thumbnail, unless another pass already showed it
    const show = () => {
      if (thumbCacheRef.current.has(key)) return false;
      thumbCacheRef.current.set(key, URL.createObjectURL(rec.blob));
      scheduleBump();
      return true;
    };
    const emit = () => {
      if (rec.label && !labels[key]) onLabel(key, rec.label);
      if (rec.det && !detectedScales[key]) onDetect(key, rec.det);
    };
    if (!rec) {
      const { file, page } = parseSheetKey(key);
      const nameGenAtRead = nameGen?.(file);
      // held from the page to the saved record: the file may be in no tab
      await withDoc(file, async (pdf) => {
        const pg = await pdf.getPage(page);
        if (seq !== seqRef.current) return;
        rec = await renderThumb(pg, want);
        if (seq !== seqRef.current) return;
        // the thumbnail first: measuring waits on the page's op list (#489)
        const shown = show();
        // the page is warm: read its text once, for the sheet number +
        // plan-noted scale when those are missing (shown as soon as the text
        // is in), and measure its pictures (#489: pictures.ts measurePage; its
        // op list only when the text says it isn't a scan), for the plan-set
        // search index and the record's text-layer flag and pictures. Then
        // release what the page parsed, unless the canvas holds it, and save
        // the record with what was read.
        try {
          const text = pg.getTextContent();
          const vpL = pg.getViewport({ scale: RENDER_SCALE });
          text.then((tc) => onSheetText?.(file, page, nameGenAtRead, tc, vpL)).catch(() => {});
          if (!labels[key] || !detectedScales[key]) {
            const tc = await text;
            rec.label = extractSheetNumber(tc, vpL) || null;
            rec.det = detectScale(tc, vpL) || null;
            if (shown) emit();
          }
          const { index, pictures } = await measurePage(key, { getTextContent: () => text, getOperatorList: () => pg.getOperatorList() }, vpL, pdfjsLib.OPS);
          rec.textLayer = index.textLayer;
          rec.pictures = pictures;   // saveThumb never keeps "failed"
          if (seq === seqRef.current && onIndexed && planIndexRef && needsTextPass(planIndexRef.current.get(key))) onIndexed(key, index);
        } catch { /* text layer is optional */ }
        finally { if (!pageHeld?.(key)) { try { pg.cleanup(); } catch { /* already released */ } } }
        saveThumb(key, rec);
      });
      return;
    }
    if (!show()) return;
    emit();
    if (kept && onIndexed && planIndexRef) {
      // a kept record (planSearch thumbIndexStep): a scan's or a hybrid's
      // seeds its empty text entry (no PDF parsed), so its card offers a read
      // and its kept read is looked up; its measured pictures go onto an
      // entry that has none ("adopt": the canvas's label loop doesn't
      // measure); a record without the flag or the pictures takes them from
      // the sheet's entry ("flag") or, if its document is already loaded,
      // reads and measures the page once ("read"), and is saved again with
      // them, so the next open asks nothing
      const has = (k) => !needsTextPass(planIndexRef.current.get(k));
      const step = thumbIndexStep(rec, key, (k) => planIndexRef.current.get(k), (f) => !!docLoaded?.(f));
      if (step.kind === "seed") onIndexed(key, step.ix);
      else if (step.kind === "adopt") {
        const have = planIndexRef.current.get(key);
        if (have) onIndexed(key, adoptEntry(have, step));
      } else if (step.kind === "flag") saveThumb(key, step.pictures ? { ...rec, textLayer: step.textLayer, pictures: step.pictures } : { ...rec, textLayer: step.textLayer });
      else if (step.kind === "read") {
        const { file, page } = parseSheetKey(key);
        // only while its document is still loaded (trimmed since: asked
        // again next open), and held while it's read
        const nameGenAtRead = nameGen?.(file);
        await withLoadedDoc(file, async (pdf) => {
          let pg = null;
          try {
            pg = await pdf.getPage(page);
            if (seq !== seqRef.current) return;
            const vp = pg.getViewport({ scale: RENDER_SCALE });
            // one text read, shared with the sheet-number offer
            const text = pg.getTextContent();
            text.then((tc) => onSheetText?.(file, page, nameGenAtRead, tc, vp)).catch(() => {});
            const { index, pictures } = await measurePage(key, { getTextContent: () => text, getOperatorList: () => pg.getOperatorList() }, vp, pdfjsLib.OPS);
            if (seq !== seqRef.current) return;
            if (!has(key)) onIndexed(key, index);
            rec = { ...rec, textLayer: index.textLayer, pictures };
            saveThumb(key, rec);
          } catch { /* text layer is optional; asked again next open */ }
          finally { if (pg && !pageHeld?.(key)) { try { pg.cleanup(); } catch { /* already released */ } } }
        });
      }
    }
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

  // ── plan-set search: index the sheets no text pass has reached (#471) ──
  // The canvas indexes the sheets it renders and scans; the thumbnail pump
  // indexes each thumbnail it rasters. Everything else is read here, once a
  // query is typed: each file by its page count (read from its document when
  // the count isn't known yet, or when a known page is missing from the
  // index — a fully indexed set loads no document), one sheet at a time,
  // yielding to the canvas's open sequence as the thumbnail pump does. Its own
  // generation counter, not seqRef: the page-count effect bumps seqRef on
  // every knownPages change, which would cancel the walk part-way through.
  // Restarts on a sheets change; stops on unmount or when the query clears.
  // In a cloud project this downloads every PDF not yet opened, the same as
  // opening them; each document is held while its pages are read, then
  // joins the canvas's few idle ones like the pump's, oldest out first.
  const indexGenRef = useRef(0);
  const [indexProg, setIndexProg] = useState(null);   // { done, total } while the walk runs
  // what the last walk couldn't read ({ sheets, incomplete }); Retry, or the
  // next query, walks again for it
  const [walkFail, setWalkFail] = useState({ sheets: 0, incomplete: false });
  const [walkTick, setWalkTick] = useState(0);
  const walkFailRef = useRef(walkFail);
  walkFailRef.current = walkFail;
  const allKeysRef = useRef(allKeys);
  allKeysRef.current = allKeys;

  // ── on-device reads (#471): the probe, and each sheet's read status ──
  // The probe is asked once a scan (little or no text layer) is known (never on
  // open): disabled / uninstalled hide every Read and the unread line, and
  // stop the cache lookups. Status changes (the canvas's reader) repaint the
  // cards at most once a frame.
  const [ocrAvail, setOcrAvail] = useState(null);    // the probe's state, null until asked
  const probeRef = useRef(null);
  const probeOcr = useCallback(() => {
    if (!ocr?.enabled) return Promise.resolve("disabled");
    return (probeRef.current ??= ocr.availability()
      .then((a) => a.state, () => "error")
      .then((st) => { if (st === "error") probeRef.current = null; setOcrAvail(st); return st; }));
  }, [ocr]);
  // the session forgets an error answer, so asking again re-probes
  const retryProbe = () => { probeRef.current = null; probeOcr(); };
  const [, setReadTick] = useState(0);
  useEffect(() => {
    if (!ocr) return;
    const sig = createChangeSignal();
    const offSig = sig.subscribe(() => setReadTick((t) => t + 1));
    const off = ocr.subscribe(() => sig.notify());
    return () => { off(); offSig(); };
  }, [ocr]);
  // the card whose Read was pressed last: focus returns to it after the
  // download notice (its button changes under the notice)
  const [lastReadKey, setLastReadKey] = useState(null);
  const readCard = (key, force = false) => {
    setLastReadKey(key);
    ocr.read(key, { force }).then((r) => { if (!r.ok && (r.status === "disabled" || r.status === "uninstalled")) setOcrAvail(r.status); });
  };
  const pageOfRef = useRef(pageOf);
  pageOfRef.current = pageOf;
  useEffect(() => {
    if (!searching || !onIndexed) return;
    const gen = ++indexGenRef.current;
    const live = () => gen === indexGenRef.current;
    // a seeded entry (from a thumbnail's flag) is read for real, and so is a
    // cached read that replaced one (its stamp terms: needsTextPass); every
    // other indexed sheet is done, so no other file is opened again
    const has = (k) => !needsTextPass(planIndexRef.current.get(k));
    // progress repaints at most once a frame, not once a page
    let done = 0, total = 0;
    const tick = createChangeSignal();
    tick.subscribe(() => { if (live()) setIndexProg({ done, total }); });
    // the OCR cache is asked only once the probe allows it (asked lazily, at
    // the first scan); unanswered, a sheet stays unread
    let allowed = null;
    const lookupsAllowed = () => (allowed ??= probeOcr().then((a) => canLookUp(!!ocr?.enabled, a)));
    const failures = createWalkFailures();
    let incomplete = false;
    (async () => {
      // sheets other passes indexed as scans (the canvas, the thumbnails):
      // only a hash already in hand, so nothing downloads just to hash
      for (const key of keysToLookUp(allKeysRef.current, planIndexRef.current)) {
        if (!live() || !(await lookupsAllowed())) break;
        await ocr.lookup(key, { known: true });
      }
      if (!live()) return;
      const todo = filesToIndex(sheets.map((s) => s.name), (f) => pageOfRef.current(f), has);
      if (!todo.length) return;
      total = todo.reduce((t, f) => t + f.knownPages, 0);
      tick.notify();
      for (const { file, knownPages } of todo) {
        // one lease for all the file's pages; true: the walk is over
        let opened = false, stop;
        try {
          const nameGenAtRead = nameGen?.(file);
          stop = await withDoc(file, async (pdf) => {
            opened = true;
            if (!live()) return true;
            const n = pdf.numPages || 1;
            total += n - knownPages;
            const keys = pagesToIndex(file, n, has);
            done += n - keys.length;   // pages already indexed count as checked
            tick.notify();
            for (const key of keys) {
              if (!has(key)) {
                while (busyRef.current === "rendering" && live()) await new Promise((r) => setTimeout(r, 150));
                if (!live()) return true;
                let page = null;
                try {
                  const pageNo = parseSheetKey(key).page;
                  page = await pdf.getPage(pageNo);
                  if (!live()) return true;
                  // its text, and its pictures (#489: measurePage; the op list
                  // only on a page that isn't a scan), in the entry before the
                  // lookup below asks whether the sheet needs a read
                  const vp = page.getViewport({ scale: RENDER_SCALE });
                  const text = page.getTextContent();
                  text.then((tc) => onSheetText?.(file, pageNo, nameGenAtRead, tc, vp)).catch(() => {});
                  const pg = page;
                  const { index } = await measurePage(key, { getTextContent: () => text, getOperatorList: () => pg.getOperatorList() }, vp, pdfjsLib.OPS);
                  if (!live()) return true;
                  if (!has(key)) onIndexed(key, index);
                  // a scan's or a hybrid's cached read (if any) joins the search
                  // now, under the hash of the document the walk just loaded
                  if (needsRead(planIndexRef.current.get(key)) && await lookupsAllowed()) await ocr.lookup(key);
                } catch (e) {
                  // destroyed doc (file closed / revised) or unreadable page: not
                  // checked, so search doesn't claim it has no match
                  if (live() && !has(key)) {
                    console.warn(`Search couldn't read ${file} (${key})`, e);
                    failures.fail(key);
                    continue;
                  }
                }
                // release only what the walk alone holds: getPage hands back the
                // document's shared page proxy, and the canvas may have taken this
                // page during the awaits above
                finally { if (page && !pageHeld?.(key)) { try { page.cleanup(); } catch { /* already released */ } } }
              }
              done++;
              tick.notify();
            }
            return false;
          });
        } catch (e) {
          if (opened) throw e;
          // unreadable file: not checked; say so and move on
          if (!live()) return;
          console.warn(`Search couldn't open ${file}`, e);
          failures.failFile(file, knownPages);
          continue;
        }
        if (stop) return;
      }
    // done: retire this generation so a progress frame still queued can't
    // repaint "Indexing" after the clear
    })().catch((e) => {
      console.warn("Search stopped before reading every sheet", e);
      incomplete = true;
    }).finally(() => {
      if (!live()) return;
      setWalkFail({ sheets: failures.count(), incomplete });
      indexGenRef.current++;
      setIndexProg(null);
    });
    // bumping the LIVE counter is the point: it invalidates this walk (seqRef's pattern)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { indexGenRef.current++; setIndexProg(null); };
    // planIndexRef/withDoc/busyRef/onIndexed/pageHeld are stable; pageOf is read through
    // its ref so a page-count update doesn't restart the walk
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, sheets, walkTick]);
  // a new query walks again for what the last walk couldn't read
  useEffect(() => {
    if (searching && retryWalk(walkFailRef.current)) setWalkTick((t) => t + 1);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps -- searching is read with the query
  // The canvas announces index changes on a signal; this re-renders the
  // gallery for them. The map is read fresh on mount, so nothing written while
  // the gallery was closed is missed; one catch-up bump after subscribing
  // covers a write between this render and the subscription.
  const [indexVersion, setIndexVersion] = useState(0);
  useEffect(() => {
    if (!subscribeIndex) return;
    const bumpIndex = () => setIndexVersion((v) => v + 1);
    const off = subscribeIndex(bumpIndex);
    bumpIndex();
    return off;
  }, [subscribeIndex]);
  // Scans in the index with no read: ask the probe (once)
  // so their cards can offer Read page text, and look each one's kept read up
  // (one at a time; cache only, memoized per sheet), so a sheet read before
  // shows as read, not as Read page text, search or no search.
  const unreadKeys = planIndexRef ? keysToLookUp(allKeys, planIndexRef.current) : [];
  const unreadSig = unreadKeys.join("\u0000");
  useEffect(() => {
    if (!unreadKeys.length || !ocr?.enabled) return;
    let live = true;
    (async () => {
      if (!canLookUp(true, await probeOcr())) return;
      // background: only hashes the store already has (no download in a
      // cloud project; a card may offer Read page text for a sheet read
      // before, and Read then finds the saved read)
      for (const key of unreadKeys) {
        if (!live) return;
        await ocr.lookup(key, { known: true });
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unreadSig stands for unreadKeys
  }, [unreadSig, ocr, probeOcr]);
  // Results. The map is the same object every time, so indexVersion is what
  // says it changed; keySig covers the set itself.
  const search = useMemo(
    () => (searching ? runPlanSearch(query, planIndexRef.current, allKeys) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searching, query, indexVersion, keySig],
  );

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
  // a search shows its hits as one ungrouped run, in searchPlan's rank order —
  // never through the level grouping/sort above, which would reorder them
  const shownGroups = search ? (search.hits.length ? [{ level: null, keys: search.hits.map((h) => h.key) }] : []) : groups;
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
      // a typed search clears first; the next Esc leaves as before
      const step = galleryEscStep({ query, mode, canClose });
      if (step === "clear-query") setQuery("");
      else if (step === "to-plan") setMode("plan");
      else if (step === "exit") onExit();
    };
  }, [mode, canClose, onExit, query]);

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
  // the search's count and indexing progress sit beside its box, so the
  // header (and the grid under it) never moves while a query is typed
  // only the hit count is announced; the indexing ticks aren't
  const countLine = galleryCountLine(search && { hits: search.hits.length }, allKeys.length);
  const failLine = search && !indexProg ? searchFailedLine(walkFail) : null;

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
      {onPremium && <button type="button" data-premium-trigger onClick={onPremium} style={{...ctrlBtn, color:"var(--cobalt)", borderColor:"var(--cobalt)"}}>Request Premium</button>}
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

  // ── a card's Read row (#471, #489): a scan (little or no text layer) or a
  // hybrid (a picture the text layer can't read) ─
  // Read page text, or Read picture text on a hybrid (the canvas's reader:
  // cache first, the download notice before the first read), then its
  // progress with Cancel, Stopping…, and the time once read, labelled OCR.
  // Clicks stay off the card (it toggles selection).
  const readRow = (key) => {
    if (!ocr || !planIndexRef) return null;
    const v = galleryReadView(planIndexRef.current.get(key), ocrAvail, ocr.status(key));
    if (v.kind === "hidden") return null;
    const btn = (label, onClick) => (
      <button type="button" onClick={(e) => { e.stopPropagation(); onClick(); }} style={{ ...ctrlBtn, padding: "3px 8px", fontSize: 11 }}>{label}</button>
    );
    return (
      <div data-gallery-read={key} data-state={v.kind} data-last-read={key === lastReadKey ? "" : undefined} onClick={(e) => e.stopPropagation()}
        style={{ padding: "0 10px 8px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink-muted)", cursor: "default" }}>
        {v.kind === "read" && <>{btn(v.what === "picture" ? "Read picture text" : "Read page text", () => readCard(key))}<span>{v.what === "picture" ? "text in a picture isn't searchable yet" : "little or no text layer"}</span>{v.note && <span style={{ color: "var(--c-danger)", flexBasis: "100%" }}>{v.note}</span>}</>}
        {v.kind === "reading" && <><span className="pip" aria-hidden="true" /><span aria-live="polite">{v.text}</span>{btn("Cancel", () => ocr.cancel(key))}</>}
        {v.kind === "stopping" && <span aria-live="polite">{v.text}</span>}
        {v.kind === "unreadable" && <span aria-live="polite" style={{ color: "var(--c-danger)" }}>{v.text}</span>}
        {v.kind === "unreachable" && <><span aria-live="polite" style={{ color: "var(--c-danger)" }}>{v.text}</span>{btn("Retry", retryProbe)}</>}
        {v.kind === "done" && <><span aria-live="polite" style={{ color: "var(--c-warning)" }}>{v.text}</span>{v.readAgain && btn("Read again", () => readCard(key, true))}</>}
      </div>
    );
  };
  const unread = search ? unreadLine(search.unreadCount, ocrAvail) : null;

  // ── PLAN body + footer ──────────────────────────────────────────────────
  const planBody = (
    <>
      <div className="sheet-preview-controls"><label>Page previews</label>{["medium", "large"].map(size => <button type="button" key={size} aria-pressed={previewSize === size} onClick={() => setPreviewSize(size)}>{size === "large" ? "Large" : "Medium"}</button>)}<span style={{ color: "var(--ink-muted)", fontSize: "var(--fs-s)" }}>Preview to inspect · View to open · Select cards for tabs or stitching</span>
        {/* plan-set search (#471), right-aligned in this row: the browse filter's field styling */}
        {sheets.length > 0 && planIndexRef && (<>
          <span style={{ flex: 1 }} />
          {countLine && <span aria-live="polite" style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink-muted)" }}>{countLine}</span>}
          {search && indexProg && <span style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--ink-muted)" }}>· Indexing {indexProg.done} / {indexProg.total}</span>}
          {failLine && <span data-search-failed="" style={{ fontFamily: "var(--f-mono)", fontSize: 11, color: "var(--c-danger)" }}>· {failLine} <button type="button" onClick={() => setWalkTick((t) => t + 1)} style={{ ...ctrlBtn, padding: "1px 6px", fontSize: 11 }}>Retry</button></span>}
          <input name="plan-search" type="text" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sheet text…" aria-label="Search the text on every sheet"
            title="Find sheets by the text on them — a finish tag, room number, sheet number or word (Esc clears)"
            autoComplete="off" spellCheck={false}
            style={{ padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontSize: 12.5, minWidth: 180 }} />
        </>)}
      </div>
      <div ref={gridRef} style={{ flex: 1, overflow: "auto", padding: 18 }}>
        {shownGroups.map((grp) => (
        <div key={grp.level ?? "__all"} style={{ marginBottom: grp.level !== null ? 22 : 0 }}>
        {grp.level !== null && (
          <div style={{ fontFamily: "var(--f-mono)", fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--ink-muted)", margin: "0 0 8px 2px" }}>
            {grp.level || "Unassigned"} · {grp.keys.length}
          </div>
        )}
        <div className="sheet-preview-grid" data-size={previewSize}>
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
                role="group" aria-label={`Sheet ${labelOf(key)}`}
                style={{ border: isSel ? "1.5px solid var(--cobalt)" : "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", position: "relative", boxShadow: isSel ? "var(--shadow-2)" : "var(--shadow-1)" }}>
                <button type="button" aria-label={`Select ${labelOf(key)}`} aria-pressed={isSel} onClick={(e) => { e.stopPropagation(); toggleSel(key); }} style={{ position: "absolute", top: 8, left: 8, zIndex: 2, width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", border: isSel ? "none" : "1.5px solid var(--ink-faint)", background: isSel ? "var(--cobalt)" : "var(--paper-bright)", color: "var(--paper-bright)", fontFamily: "var(--f-mono)", fontSize: 12, fontWeight: 700 }}>{isSel ? idx + 1 : ""}</button>
                <div style={{ position: "absolute", top: 8, right: 8, zIndex: 2, display: "flex", gap: 6 }}>
                  <button type="button" onClick={(e) => { e.stopPropagation(); setPreviewSheet(key); }} style={ctrlBtn}>Preview</button>
                  {isFirstPageOfPdf && onClosePdf && (
                    <button onClick={(e) => { e.stopPropagation(); requestClose(parsed.file); }} title={cloudMode ? "Close this PDF — unload it from the plan set (it stays in Drive)" : "Close this PDF — remove it from the plan set (local plans aren't stored elsewhere)"}
                      style={{ padding: "5px 8px", border: "none", background: "var(--paper-bright)", color: "var(--ink-muted)", cursor: "pointer", fontFamily: "var(--f-mono)", fontSize: 11, boxShadow: "var(--shadow-1)" }}>✕</button>
                  )}
                  <button onClick={(e) => { e.stopPropagation(); onOpen([key], false); }} title="Open just this sheet"
                    style={{ padding: "5px 12px", border: "none", background: "var(--ink)", color: "var(--paper-bright)", cursor: "pointer", fontFamily: "var(--f-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase" }}>View</button>
                </div>
                <div data-preview-well style={{ height: 185, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--well)", borderBottom: "1px solid var(--ink-faint)", overflow: "hidden" }}>
                  {thumb
                    ? <img src={thumb} alt={labelOf(key)} decoding="async" draggable={false} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                    : <div className="skeleton" style={{ width: "86%", height: "78%" }} />}
                </div>
                <div data-preview-caption style={{ padding: "8px 10px", display: "flex", alignItems: "baseline", gap: 8 }}>
                  <strong style={{ fontFamily: "var(--f-mono)", fontSize: 12.5, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }} title={key}>{labelOf(key)}</strong>
                  {levels[key] && <span title="Level" style={{ fontSize: 9.5, fontFamily: "var(--f-mono)", color: "var(--ink-muted)", border: "1px solid var(--ink-faint)", padding: "1px 5px" }}>{levels[key]}</span>}
                  {search?.chipsByKey[key]?.map((t) => (
                    <span key={`m:${t}`} title="Matched text on this sheet" style={{ fontSize: 9.5, fontFamily: "var(--f-mono)", color: "var(--cobalt)", border: "1px solid var(--cobalt)", padding: "1px 5px", whiteSpace: "nowrap" }}>{t}</span>
                  ))}
                  {search?.ocrKeys.has(key) && <span title="Matched in text the on-device text reader (OCR) read from the page image, not the PDF's own text — check the sheet" style={{ fontSize: 9.5, fontFamily: "var(--f-mono)", color: "var(--c-warning)", textTransform: "uppercase", letterSpacing: "0.08em" }}>OCR</span>}
                  {isOpenTab && <span title="Already open as a tab" style={{ fontSize: 9.5, fontFamily: "var(--f-mono)", color: "var(--cobalt)", textTransform: "uppercase", letterSpacing: "0.08em" }}>open</span>}
                  {cnt > 0 && <span style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, color: "var(--ink-muted)" }}>{cnt}▦</span>}
                  <span style={{ fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", color: scales[key] ? (scaleUnconfirmed[key] === false ? "var(--c-warning)" : "var(--c-positive)") : detectedScales[key] ? "var(--c-warning)" : "var(--c-danger)" }}
                    title={scales[key] && scaleUnconfirmed[key] === false ? "Scale set by an agent — no person has confirmed it. Open the sheet and confirm from the scale menu." : undefined}>
                    {scales[key] ? (scaleUnconfirmed[key] === false ? "scale ⚠ confirm" : "scale ✓") : detectedScales[key] ? `plan: ${detectedScales[key].label}` : "no scale"}
                  </span>
                </div>
                {readRow(key)}
              </div>
            );
          })}
        </div>
        </div>
        ))}
        {search && !search.hits.length && allKeys.length > 0 && (
          <div style={{ padding: 48, textAlign: "center", color: "var(--ink-muted)", fontSize: 13.5, lineHeight: 1.7 }}>
            <div style={{ fontFamily: "var(--f-display)", fontSize: 16, color: "var(--ink)", marginBottom: 6 }}>No sheet matches “{query.trim()}”</div>
            {indexProg
              ? `Still reading sheet text — ${indexProg.done} of ${indexProg.total} checked.`
              : "Search reads each sheet's own text: finish tags, room and sheet numbers, and words of three letters or more."}
          </div>
        )}
        {unread && (
          <div data-unread-line style={{ padding: "14px 2px 0", fontFamily: "var(--f-mono)", fontSize: 11.5, color: "var(--ink-muted)", textAlign: search.hits.length ? "left" : "center" }}>
            {unread}
            {ocrAvail === "error" && <> <button type="button" onClick={retryProbe} style={{ ...ctrlBtn, padding: "1px 6px", fontSize: 11 }}>Retry</button></>}
          </div>
        )}
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
      {previewSheet && <SheetPreview sheet={previewSheet} label={labelOf(previewSheet)} withDoc={withDoc} onClose={closePreview} onOpen={(key) => { setPreviewSheet(null); onOpen([key], false); }} />}
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
