// DrivePicker — choose which PDFs from a project's Drive folder to open.
//
// Cloud projects live in a Drive folder that holds EVERYTHING for a job: the
// plan set plus huge multi-hundred-page spec books and rarely-opened as-builts.
// Auto-loading every PDF would download hundreds of MB on open, so instead this
// picker lists the folder from Drive METADATA ONLY (name/size/date — no
// downloads) and lets you pick the sheets you actually want. Only the chosen
// files are ever fetched (in the gallery, on open). Folders vary by job, so it
// browses subfolders too; picks accumulate across folders until you hit Add.
import React, { useCallback, useEffect, useState } from "react";
import { Icon } from "../brand/icons.jsx";

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

export default function DrivePicker({ listFolder, addSheets, existingNames, onAdded, onClose, canClose }) {
  const [path, setPath] = useState([ROOT]);        // breadcrumb stack
  const [data, setData] = useState(null);          // { folders, pdfs } | null
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState([]);        // [{ id, name }] — accumulates across folders
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("name");        // name | size | date
  const [adding, setAdding] = useState(false);

  const here = path[path.length - 1];
  const already = existingNames || new Set();

  const load = useCallback((folderId) => {
    let live = true;
    setLoading(true); setErr("");
    listFolder(folderId)
      .then((d) => { if (live) { setData(d); setLoading(false); } })
      .catch((e) => { if (live) { setErr(String(e?.message || e)); setLoading(false); } });
    return () => { live = false; };
  }, [listFolder]);

  useEffect(() => load(here.id), [here.id, load]);

  // While the picker overlays the canvas, keys must not fall through to the
  // takeoff behind it. The canvas' global shortcuts listen on window in the
  // bubble phase; this capture-phase listener runs FIRST and stops them —
  // Escape closes the picker (as the Close button advertises), and every other
  // shortcut is swallowed unless focus is in the picker's own filter/sort field
  // (where the canvas handlers already bail on INPUT/SELECT anyway).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); if (canClose) onClose(); return; }
      const tag = e.target?.tagName;
      if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [canClose, onClose]);

  const isPicked = (id) => picked.some((p) => p.id === id);
  const pickedNames = new Set(picked.map((p) => p.name));
  // A project keys its sheets by NAME, so two different Drive files can't share
  // one name in the working set. Rather than let both be checked and silently
  // drop one on Add (the store dedupes by name), block the second here and say
  // why — a name already in the set, or already picked under a different id.
  const nameConflict = (f) => !isPicked(f.id) && !already.has(f.name) && pickedNames.has(f.name);
  const togglePick = (f) => setPicked((p) => (p.some((x) => x.id === f.id) ? p.filter((x) => x.id !== f.id) : [...p, { id: f.id, name: f.name }]));
  const drillInto = (folder) => { setPath((p) => [...p, folder]); };
  const jumpTo = (i) => setPath((p) => p.slice(0, i + 1));

  const add = async () => {
    if (!picked.length || adding) return;
    setAdding(true); setErr("");
    try {
      await addSheets(picked);
      await onAdded();   // parent refreshes + switches to the gallery (may unmount us)
    } catch (e) {
      // surface the failure and re-enable the button instead of wedging on "Adding…"
      setErr(String(e?.message || e));
      setAdding(false);
    }
  };

  const needle = q.trim().toLowerCase();
  const folders = (data?.folders || []).filter((f) => !needle || f.name.toLowerCase().includes(needle));
  const pdfs = (data?.pdfs || [])
    .filter((f) => !needle || f.name.toLowerCase().includes(needle))
    .sort((a, b) => {
      if (sort === "size") return (Number(b.size) || 0) - (Number(a.size) || 0);
      if (sort === "date") return String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || ""));
      return a.name.localeCompare(b.name);
    });

  const rowBase = { display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-bright)" };

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 45, display: "flex", flexDirection: "column", background: "var(--paper-cream)" }}>
      {/* header: title + breadcrumb + search + sort + close */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderBottom: "1px solid var(--ink)", background: "var(--paper-bright)", flexWrap: "wrap" }}>
        <Icon name="sheets" size={18} />
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 16, color: "var(--ink)" }}>Add sheets from Drive</strong>
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" }}>
          pick the PDFs to open — specs &amp; as-builts stay unopened
        </span>
        <div style={{ flex: 1 }} />
        <input name="drive-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name…"
          style={{ padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontSize: 12.5, minWidth: 160 }} />
        <select name="drive-sort" value={sort} onChange={(e) => setSort(e.target.value)} title="Sort files"
          style={{ padding: "6px 8px", border: "1px solid var(--ink-faint)", background: "transparent", fontSize: 12 }}>
          <option value="name">Name</option>
          <option value="size">Size</option>
          <option value="date">Modified</option>
        </select>
        {canClose && (
          <button onClick={onClose} title="Back to the sheets (Esc)"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12.5 }}>
            <Icon name="close" size={12} />Close
          </button>
        )}
      </div>

      {/* breadcrumb trail */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 18px", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-bright)", fontFamily: "var(--f-mono)", fontSize: 12 }}>
        {path.map((c, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {i > 0 && <span style={{ color: "var(--ink-faint)" }}>/</span>}
            <button onClick={() => jumpTo(i)} disabled={i === path.length - 1}
              style={{ border: "none", background: "transparent", cursor: i === path.length - 1 ? "default" : "pointer", color: i === path.length - 1 ? "var(--ink)" : "var(--cobalt)", fontFamily: "var(--f-mono)", fontSize: 12, padding: "2px 2px", fontWeight: i === path.length - 1 ? 700 : 400 }}>
              {c.name}
            </button>
          </span>
        ))}
      </div>

      {/* listing */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>Reading folder…</div>
        ) : err ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--c-danger)", fontSize: 13 }}>Couldn't read the folder: {err}</div>
        ) : (folders.length === 0 && pdfs.length === 0) ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>
            {needle ? "Nothing matches that filter." : "This folder has no PDFs or subfolders."}
          </div>
        ) : (
          <>
            {folders.map((f) => (
              <div key={f.id} onClick={() => drillInto(f)} style={{ ...rowBase, cursor: "pointer" }}>
                <span style={{ fontSize: 15, width: 20, textAlign: "center", color: "var(--cobalt)" }}>▸</span>
                <strong style={{ fontFamily: "var(--f-body)", fontSize: 13.5, color: "var(--ink)", flex: 1 }}>{f.name}</strong>
                <span style={{ fontFamily: "var(--f-mono)", fontSize: 10.5, color: "var(--ink-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>folder</span>
              </div>
            ))}
            {pdfs.map((f) => {
              const inSet = already.has(f.name);
              const sel = isPicked(f.id);
              const conflict = nameConflict(f);   // same name as another pick (different id)
              const disabled = inSet || conflict;
              const tagStyle = { fontFamily: "var(--f-mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.08em", minWidth: 72, textAlign: "right" };
              return (
                <label key={f.id} style={{ ...rowBase, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1 }}
                  title={conflict ? "Another selected PDF already uses this name — a project can't have two sheets with the same name" : undefined}>
                  <input name="drive-file-pick" type="checkbox" checked={sel || inSet} disabled={disabled} onChange={() => togglePick(f)}
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

      {/* footer: pick count + Add */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderTop: "1px solid var(--ink)", background: "var(--paper-bright)" }}>
        <span style={{ fontFamily: "var(--f-mono)", fontSize: 11.5, color: "var(--ink-muted)" }}>
          {picked.length ? `${picked.length} selected to open` : "check the PDFs you want to open — nothing downloads until you add them"}
        </span>
        <div style={{ flex: 1 }} />
        {picked.length > 0 && (
          <button onClick={() => setPicked([])} style={{ padding: "7px 12px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--ink-muted)", cursor: "pointer", fontSize: 12 }}>Clear</button>
        )}
        <button onClick={add} disabled={!picked.length || adding}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 16px", border: "1px solid var(--ink)", background: picked.length ? "var(--cobalt)" : "var(--ink-faint)", color: "var(--paper-bright)", cursor: picked.length && !adding ? "pointer" : "default", fontWeight: 700, fontSize: 13 }}>
          <Icon name="plus" size={13} />{adding ? "Adding…" : `Add ${picked.length || ""} sheet${picked.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}
