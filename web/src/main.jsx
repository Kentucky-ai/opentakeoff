import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import "./styles/tokens.css";
import "./styles/app.css";
import TakeoffCanvas from "./pages/TakeoffCanvas.jsx";
import ProjectHome from "./components/ProjectHome.jsx";
import { GoogleAuthProvider, useGoogleAuth } from "./lib/google/AuthContext.jsx";
import { projectIdFromUrl, setActiveStore } from "./lib/store.js";
import { isGoogleConfigured, getAccessToken } from "./lib/google/auth.js";
import { cloudSyncEnabled } from "./lib/prefs.js";
import { projectHomeFolderId } from "./lib/projectHome.js";
import { initTheme } from "./lib/theme.js";

initTheme();   // index.html set data-theme pre-paint; this keeps it live

// Client-only SPA. By default there is no backend: the canvas runs entirely in
// the browser and persists to IndexedDB / localStorage (anonymous local mode).
// Bare `/` ALWAYS lands here first — open the bundled demo plan or drop your
// own — never behind a sign-in wall, even on a build with cloud mode configured.
//
// The OPTIONAL team-only cloud mode kicks in only when the build is configured
// for Google (VITE_GOOGLE_CLIENT_ID) AND the app is deep-linked to a project:
// `/?project=<driveFolderId>` (Glide hands us that id, or the in-app project
// browser below does). We then require a domain Google sign-in, build a
// Drive-backed store, and swap it into the shared `store` binding BEFORE
// mounting the canvas — so the canvas's mount-time load reads/writes that
// project's Drive folder with no changes to the canvas.
//
// When the build ALSO names the team's Projects folder (VITE_DRIVE_ROOT_FOLDER_ID),
// `/projects` is a signed-in project browser (ProjectHome) that emits those
// same `?project=` links — reachable only through an explicit, subtle "browse
// team projects" link, never the default landing screen.

const centered = {
  minHeight: "100vh", display: "flex", flexDirection: "column",
  alignItems: "center", justifyContent: "center", gap: 14, padding: 24,
  textAlign: "center", background: "var(--paper-bright)", color: "var(--ink)",
};
const brand = (
  <strong style={{ fontFamily: "var(--f-display)", fontSize: 20, letterSpacing: "-0.02em" }}>
    open<span style={{ fontStyle: "italic", color: "var(--cobalt)" }}>takeoff</span>
  </strong>
);

function Centered({ title, body }) {
  return (
    <div style={centered}>
      {brand}
      <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      {body ? <div style={{ fontSize: 13, color: "var(--ink-muted)", maxWidth: 460 }}>{body}</div> : null}
    </div>
  );
}

// Defaults are the deep-linked-project copy (ProjectGate renders it bare);
// the project-home gate passes its own title/body, and `footer` slots an
// extra element under the button (the home flavor's skip link).
function SignInScreen({
  ready, signIn,
  title = "This project is stored in your team's Google Drive",
  body = "Sign in with your team Google account to open it. Only accounts on the team domain can sign in.",
  footer = null,
}) {
  const [err, setErr] = useState("");
  return (
    <div style={centered}>
      {brand}
      <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 13, color: "var(--ink-muted)", maxWidth: 460 }}>{body}</div>
      <button type="button" disabled={!ready}
        onClick={() => { setErr(""); signIn().catch((e) => setErr(String(e?.message || e))); }}
        style={{ padding: "9px 16px", border: "1px solid var(--ink)", background: "var(--ink)",
          color: "var(--paper-bright)", cursor: ready ? "pointer" : "default", fontWeight: 600,
          fontSize: 13.5, opacity: ready ? 1 : 0.5 }}>
        Sign in with Google
      </button>
      {err ? <div style={{ fontSize: 12.5, color: "var(--c-danger)", maxWidth: 460 }}>Sign-in failed: {err}</div> : null}
      {footer}
    </div>
  );
}

// Deep-linked cloud project: gate on sign-in, then build + install the
// Drive-backed store before rendering the canvas. The Google/Drive modules are
// dynamically imported so the anonymous bundle never pulls them in.
function ProjectGate({ projectId }) {
  const { user, ready, signIn } = useGoogleAuth();
  const [storeReady, setStoreReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // Signed out → show SignInScreen, but KEEP the cloud store active: the
    // canvas is unmounting and its best-effort flush must target Drive, not get
    // redirected into local IndexedDB. The store is reset to local only when we
    // leave cloud mode entirely (the unmount cleanup below).
    if (!user) { setStoreReady(false); return; }
    let live = true;
    // Rebuild for THIS project: clear the previous project's ready/error so we
    // never mount the canvas against a stale store, and a past failure can't
    // keep blocking a later successful init (projectId changed while signed in).
    setStoreReady(false);
    setError("");
    (async () => {
      try {
        const optedIn = cloudSyncEnabled();   // build flag (VITE_CLOUD_SYNC), default OFF → legacy path
        const [{ createDrive }, { createCloudStore }] = await Promise.all([
          import("./lib/google/drive.js"),
          import("./lib/cloudStore.js"),
        ]);
        const drive = createDrive({ getToken: getAccessToken });
        // BUILD only while this effect is still current. A stale continuation (user
        // navigated away before the imports resolved, or React StrictMode's dev
        // double-invoke) must not construct the composite: createSyncStore's bootstrap
        // fires on construction, so an orphan that's never installed would still run a
        // reconciler (redundant pulls/pushes over the same sync meta). Gating the
        // build on `live` — re-checked after the dynamic import's await — keeps this to
        // exactly the installed store, and matches the pre-5a "build inside if(live)".
        let next;
        if (optedIn) {
          // Local-first: assemble the composite. composite.js (and the sync modules
          // it imports) is pulled in ONLY here, so the legacy path and the anonymous
          // bundle never load any Drive-sync code.
          const { buildLocalFirstStore } = await import("./lib/sync/composite.js");
          if (!live) return;   // navigated away during the import → don't build an orphan reconciler
          next = buildLocalFirstStore(projectId, drive, createCloudStore(projectId, drive));
        } else {
          if (!live) return;   // navigated away → don't install over whatever replaced the store
          next = createCloudStore(projectId, drive);   // LEGACY Drive-canonical path — byte-identical to today
        }
        setActiveStore(next);
        setStoreReady(true);
      } catch (e) {
        if (live) setError(String(e?.message || e));
      }
    })();
    return () => { live = false; };
  }, [user, projectId]);

  // Restore the local store when ProjectGate leaves cloud mode (app navigates
  // away from ?project). ProjectGate isn't remounted when projectId changes
  // (no key on it), so this fires only on a real exit from cloud mode — not
  // between projects, and not on sign-out.
  useEffect(() => () => { setActiveStore(); }, []);

  if (!user) return <SignInScreen ready={ready} signIn={signIn} />;
  if (error) return <Centered title="Couldn't open this project" body={error} />;
  if (!storeReady) return <Centered title="Opening project…" />;
  // key on projectId so switching projects (or sign-in) remounts a fresh canvas
  return <TakeoffCanvas key={projectId} />;
}

// `/projects` on a build configured with a Projects root: sign in, then browse
// the team's project folders. No store swap here — opening a project
// navigates to `?project=`, where ProjectGate installs the Drive-backed store
// as usual. Google sign-in is opt-in, not the default landing (see App below)
// — this route only exists for whoever explicitly asks to browse team
// projects, so a build with no root configured just bounces back to `/`.
function ProjectHomeGate() {
  const { user, ready, signIn } = useGoogleAuth();
  if (!isGoogleConfigured() || !projectHomeFolderId()) return <Navigate to="/" replace />;
  if (!user) {
    return (
      <SignInScreen ready={ready} signIn={signIn}
        title="Your team's projects live in Google Drive"
        body="Sign in with your team Google account to browse and open them. Only accounts on the team domain can sign in."
        footer={
          <Link to="/" style={{ fontSize: 12.5, color: "var(--ink-muted)" }}>
            skip — use the local canvas
          </Link>
        } />
    );
  }
  return <ProjectHome />;
}

function App() {
  // Subscribe to navigation: react-router bails out of re-rendering the same
  // element on navigate(), so App must watch the location itself. The store.js
  // URL helpers read window.location, which history has already updated by the
  // time this re-render runs — useLocation() is purely the re-render trigger.
  useLocation();
  const projectId = projectIdFromUrl();
  // ?project= deep link → the cloud project.
  if (projectId && isGoogleConfigured()) return <ProjectGate projectId={projectId} />;
  // Otherwise the anonymous local canvas is the default landing screen —
  // open the bundled demo plan or drop your own, no sign-in required.
  // Google sign-in (to browse team projects at /projects) is a subtle,
  // opt-in link on that screen, never a wall in front of it.
  return <TakeoffCanvas />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <GoogleAuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/projects" element={<ProjectHomeGate />} />
          <Route path="*" element={<App />} />
        </Routes>
      </BrowserRouter>
    </GoogleAuthProvider>
  </React.StrictMode>
);
