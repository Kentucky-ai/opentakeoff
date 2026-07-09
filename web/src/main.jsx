import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./styles/tokens.css";
import "./styles/app.css";
import TakeoffCanvas from "./pages/TakeoffCanvas.jsx";
import { GoogleAuthProvider, useGoogleAuth } from "./lib/google/AuthContext.jsx";
import { projectIdFromUrl, setActiveStore } from "./lib/store.js";
import { isGoogleConfigured, getAccessToken } from "./lib/google/auth.js";
import { initTheme } from "./lib/theme.js";

initTheme();   // index.html set data-theme pre-paint; this keeps it live

// Client-only SPA. By default there is no backend: the canvas runs entirely in
// the browser and persists to IndexedDB / localStorage (anonymous local mode).
//
// The OPTIONAL team-only cloud mode kicks in only when the build is configured
// for Google (VITE_GOOGLE_CLIENT_ID) AND the app is deep-linked to a project:
// `/?project=<driveFolderId>` (Glide hands us that id). We then require a
// domain Google sign-in, build a Drive-backed store, and swap it into the shared
// `store` binding BEFORE mounting the canvas — so the canvas's mount-time load
// reads/writes that project's Drive folder with no changes to the canvas.

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

function SignInScreen({ ready, signIn }) {
  const [err, setErr] = useState("");
  return (
    <div style={centered}>
      {brand}
      <div style={{ fontSize: 15, fontWeight: 600 }}>This project is stored in your team's Google Drive</div>
      <div style={{ fontSize: 13, color: "var(--ink-muted)", maxWidth: 460 }}>
        Sign in with your team Google account to open it. Only accounts on the team
        domain can sign in.
      </div>
      <button type="button" disabled={!ready}
        onClick={() => { setErr(""); signIn().catch((e) => setErr(String(e?.message || e))); }}
        style={{ padding: "9px 16px", border: "1px solid var(--ink)", background: "var(--ink)",
          color: "var(--paper-bright)", cursor: ready ? "pointer" : "default", fontWeight: 600,
          fontSize: 13.5, opacity: ready ? 1 : 0.5 }}>
        Sign in with Google
      </button>
      {err ? <div style={{ fontSize: 12.5, color: "var(--c-danger)", maxWidth: 460 }}>Sign-in failed: {err}</div> : null}
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
        const [{ createDrive }, { createCloudStore }] = await Promise.all([
          import("./lib/google/drive.js"),
          import("./lib/cloudStore.js"),
        ]);
        const drive = createDrive({ getToken: getAccessToken });
        setActiveStore(createCloudStore(projectId, drive));
        if (live) setStoreReady(true);
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

function App() {
  const projectId = projectIdFromUrl();
  // Cloud project mode only when configured AND deep-linked; otherwise the
  // classic anonymous local-only canvas, byte-for-byte unchanged.
  if (projectId && isGoogleConfigured()) return <ProjectGate projectId={projectId} />;
  return <TakeoffCanvas />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <GoogleAuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<App />} />
        </Routes>
      </BrowserRouter>
    </GoogleAuthProvider>
  </React.StrictMode>
);
