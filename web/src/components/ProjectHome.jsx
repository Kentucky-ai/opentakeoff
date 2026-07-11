// ProjectHome — the signed-in `/` screen on team-configured builds.
//
// A project IS a direct child of the "Projects" Shared Drive root, so this is a
// FLAT list of those child folders (no drilling — you never navigate above or
// below the project list here). Plus a browser-local recents list. Opening a
// project navigates to `/?project=<folderId>` — the exact same deep link Glide
// hands out, so ProjectGate does all the store work and lands the user in the
// project (empty → the PDF picker, otherwise the sheet gallery); nothing is
// opened here. The listing/recents logic lives in lib/projectHome.js
// (node-testable); this file is only the screen, mirroring PlanNavigator's idiom.
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
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [attempt, setAttempt] = useState(0);   // Retry bumps this to re-run the load
  // Recents are read once on mount — this screen is the only writer, and every
  // write immediately navigates away, so the snapshot can't go stale under us.
  const [recents] = useState(() => createRecents(browserStorage()).list());

  useEffect(() => {
    // live flag (copied from PlanNavigator): StrictMode double-invokes effects, so
    // only the latest run commits state (a stale first run can't clobber it).
    let live = true;
    setLoading(true); setErr("");
    // drive.js must be a DYNAMIC import: this component is statically reachable
    // from main.jsx, and a static import here would drag the Drive client into
    // the anonymous bundle. (getAccessToken is fine to import statically —
    // auth.js already ships in that bundle via main.jsx.)
    import("../lib/google/drive.js")
      .then(({ createDrive }) => listProjectFolders(createDrive({ getToken: getAccessToken }), projectHomeFolderId()))
      .then((list) => { if (live) { setFolders(list); setLoading(false); } })
      .catch((e) => { if (live) { setErr(String(e?.message || e)); setLoading(false); } });
    return () => { live = false; };
  }, [attempt]);

  const open = ({ id, name }) => {
    // A project row passes the name Drive reports RIGHT NOW, so a renamed folder
    // self-heals in recents when opened from the list; a recents-row open
    // re-remembers its stored name and only bumps the ordering.
    createRecents(browserStorage()).remember({ id, name });
    navigate(`/?project=${encodeURIComponent(id)}`);
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--paper-cream)", color: "var(--ink)" }}>
      {/* header: brand + title + local-canvas escape hatch + signed-in chip */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 18px", borderBottom: "1px solid var(--ink)", background: "var(--paper-bright)", flexWrap: "wrap" }}>
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 20, letterSpacing: "-0.02em" }}>
          open<span style={{ fontStyle: "italic", color: "var(--cobalt)" }}>takeoff</span>
        </strong>
        <strong style={{ fontFamily: "var(--f-display)", fontSize: 16, color: "var(--ink)" }}>Projects</strong>
        {/* Escape hatch sits WITH the title (top-left), matching PlanNavigator's
            back/up placement so the "get out of here" control is always in the
            same spot. client-side Link (not a plain anchor): a reload here would
            drop the in-memory Google token; App re-gates off the URL and keeps us
            signed in */}
        <Link to="/" style={{ fontSize: 12, color: "var(--cobalt)" }}>use the local canvas</Link>
        <div style={{ flex: 1 }} />
        <AuthChip />
      </div>

      {/* recently opened — this browser only; hidden entirely when empty */}
      {recents.length > 0 && (
        <div>
          <div style={sectionHead}>Recently opened</div>
          {recents.map((r) => (
            // row and button both open — same action, the button is just an
            // explicit affordance mirroring the project rows below.
            <div key={r.id} onClick={() => open(r)} style={{ ...rowBase, cursor: "pointer" }}>
              <strong style={{ fontFamily: "var(--f-body)", fontSize: 13.5, color: "var(--ink)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.name}>{r.name}</strong>
              <button type="button" onClick={(e) => { e.stopPropagation(); open(r); }} style={openBtn}>Open</button>
            </div>
          ))}
        </div>
      )}

      {/* the project list — flat: every folder here is one project */}
      {recents.length > 0 && <div style={sectionHead}>All projects</div>}

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
            No projects yet — create a folder in the Projects drive.
          </div>
        ) : (
          folders.map((f) => (
            // row and button both open the project — a project is exactly this
            // folder, so there's nothing to drill into; opening lands the user in
            // the project (empty → picker, otherwise the gallery). No leading
            // glyph: a drill triangle would misread as "expand," and this matches
            // the recents rows above.
            <div key={f.id} onClick={() => open(f)} style={{ ...rowBase, cursor: "pointer" }}>
              <strong style={{ fontFamily: "var(--f-body)", fontSize: 13.5, color: "var(--ink)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.name}>{f.name}</strong>
              <button type="button" onClick={(e) => { e.stopPropagation(); open(f); }} style={openBtn}>Open</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
