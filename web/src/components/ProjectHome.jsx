// ProjectHome — the signed-in `/` screen on team-configured builds.
//
// Browses the team's "Projects" folder in the Shared Drive (folders only — a
// project IS a folder) plus a browser-local recents list, and opens a project
// by navigating to `/?project=<folderId>` — the exact same deep link Glide
// hands out, so ProjectGate does all the store work; nothing is opened here.
// The listing/recents logic lives in lib/projectHome.js (node-testable); this
// file is only the screen, mirroring DrivePicker's visual idiom.
import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import AuthChip from "./AuthChip.jsx";
import { projectHomeFolderId, listProjectFolders, createRecents, browserStorage } from "../lib/projectHome.js";
import { getAccessToken } from "../lib/google/auth.js";

const rowBase = { display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderBottom: "1px solid var(--ink-faint)", background: "var(--paper-bright)" };
const sectionHead = { padding: "10px 18px 6px", fontFamily: "var(--f-mono)", fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-muted)" };
const openBtn = { padding: "5px 10px", border: "1px solid var(--ink-faint)", background: "transparent", color: "var(--cobalt)", cursor: "pointer", fontSize: 12, fontWeight: 600, lineHeight: 1, whiteSpace: "nowrap" };

export default function ProjectHome() {
  const navigate = useNavigate();
  const [path, setPath] = useState(() => [{ id: projectHomeFolderId(), name: "Projects" }]);
  const here = path[path.length - 1];
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [attempt, setAttempt] = useState(0);   // Retry bumps this to re-run the load
  // Recents are read once on mount — this screen is the only writer, and every
  // write immediately navigates away, so the snapshot can't go stale under us.
  const [recents] = useState(() => createRecents(browserStorage()).list());

  useEffect(() => {
    // live flag (copied from DrivePicker): StrictMode double-invokes effects and
    // breadcrumb hops can overlap in flight — only the latest run commits state.
    let live = true;
    setLoading(true); setErr("");
    // drive.js must be a DYNAMIC import: this component is statically reachable
    // from main.jsx, and a static import here would drag the Drive client into
    // the anonymous bundle. (getAccessToken is fine to import statically —
    // auth.js already ships in that bundle via main.jsx.)
    import("../lib/google/drive.js")
      .then(({ createDrive }) => listProjectFolders(createDrive({ getToken: getAccessToken }), here.id))
      .then((list) => { if (live) { setFolders(list); setLoading(false); } })
      .catch((e) => { if (live) { setErr(String(e?.message || e)); setLoading(false); } });
    return () => { live = false; };
  }, [here.id, attempt]);

  const open = ({ id, name }) => {
    // Browse rows pass the name Drive reports RIGHT NOW, so a renamed folder
    // self-heals in recents when opened from Browse; a recents-row open
    // re-remembers its stored name and only bumps the ordering.
    createRecents(browserStorage()).remember({ id, name });
    navigate(`/?project=${encodeURIComponent(id)}`);
  };

  const drillInto = (folder) => setPath((p) => [...p, folder]);
  const jumpTo = (i) => setPath((p) => p.slice(0, i + 1));

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--paper-cream)", color: "var(--ink)" }}>
      {/* header: brand + title + local-canvas escape hatch + signed-in chip */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderBottom: "1px solid var(--ink)", background: "var(--paper-bright)", flexWrap: "wrap" }}>
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 20, letterSpacing: "-0.02em" }}>
          open<span style={{ fontStyle: "italic", color: "var(--cobalt)" }}>takeoff</span>
        </strong>
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 16, color: "var(--ink)" }}>Projects</strong>
        <div style={{ flex: 1 }} />
        {/* client-side Link (not a plain anchor): a reload here would drop the
            in-memory Google token; App re-gates off the URL and keeps us signed in */}
        <Link to="/" style={{ fontSize: 12, color: "var(--ink-muted)" }}>use the local canvas</Link>
        <AuthChip />
      </div>

      {/* recently opened — this browser only; hidden entirely when empty */}
      {recents.length > 0 && (
        <div>
          <div style={sectionHead}>Recently opened</div>
          {recents.map((r) => (
            // row and button both open — the button exists only for visual
            // parity with the browse rows below, where the split is meaningful
            <div key={r.id} onClick={() => open(r)} style={{ ...rowBase, cursor: "pointer" }}>
              <strong style={{ fontFamily: "var(--f-body)", fontSize: 13.5, color: "var(--ink)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.name}>{r.name}</strong>
              <button type="button" onClick={(e) => { e.stopPropagation(); open(r); }} style={openBtn}>Open</button>
            </div>
          ))}
        </div>
      )}

      {/* browse — breadcrumb trail into the team's Projects folder */}
      {recents.length > 0 && <div style={sectionHead}>Browse</div>}
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

      {/* folder listing */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>Reading projects…</div>
        ) : err ? (
          <div style={{ padding: 40, textAlign: "center", fontSize: 13 }}>
            <div style={{ color: "var(--c-danger)", marginBottom: 12 }}>Couldn't list the projects: {err}</div>
            {/* Retry must be a BUTTON: the click is a user gesture, so if the
                token expired, the silent-refresh popup GIS may need to open
                isn't popup-blocked — an auto-retry's would be. */}
            <button type="button" onClick={() => setAttempt((n) => n + 1)}
              style={{ padding: "7px 14px", border: "1px solid var(--ink)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>
              Retry
            </button>
          </div>
        ) : folders.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--ink-muted)", fontSize: 13 }}>
            No project folders here yet — create one in this folder in Drive.
          </div>
        ) : (
          folders.map((f) => (
            // row click drills IN (projects often nest under year/client folders);
            // the button is the explicit "this folder is the project" action
            <div key={f.id} onClick={() => drillInto(f)} style={{ ...rowBase, cursor: "pointer" }}>
              <span style={{ fontSize: 15, width: 20, textAlign: "center", color: "var(--cobalt)" }}>▸</span>
              <strong style={{ fontFamily: "var(--f-body)", fontSize: 13.5, color: "var(--ink)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.name}>{f.name}</strong>
              <button type="button" onClick={(e) => { e.stopPropagation(); open(f); }} style={openBtn}>Open project</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
