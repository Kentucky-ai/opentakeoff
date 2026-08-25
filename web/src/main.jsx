import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/print.css";   // OT-only print block — kept out of app.css so tokens/app stay byte-synced with Spline
import TakeoffCanvas from "./pages/TakeoffCanvas.jsx";
import ProjectHome from "./components/ProjectHome.jsx";
import { GoogleAuthProvider, useGoogleAuth } from "./lib/google/AuthContext.jsx";
import { projectIdFromUrl, setActiveStore, metaGet, metaDelete } from "./lib/store.js";
import { isGoogleConfigured, getAccessToken } from "./lib/google/auth.js";
import { loadFolderLink, queryFolderPermission, requestFolderPermission, forgetFolder } from "./lib/fs/fsAccess.js";
import { m365Config, M365_ENABLED_KEY } from "./lib/msgraph/config.js";
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

// Folder-synced workspace (#316): when a folder link is persisted, wrap the
// anonymous local store with the folder-sync composite BEFORE mounting the
// canvas — same install-then-mount discipline as ProjectGate. Every state is
// readable, never a wedge:
//   • no link            → the plain local canvas, byte-identical to today
//   • permission granted → build + install the folder store, then mount
//   • permission lapsed  → a one-click re-grant screen (requestPermission
//     needs a user gesture, so boot can only ask via a button)
//   • handle dead        → say so, offer "work locally" and "forget folder"
function FolderGate() {
  // status: checking | plain | building | ready | prompt | dead
  const [status, setStatus] = useState("checking");
  const [link, setLink] = useState(null);
  const [err, setErr] = useState("");
  const folderStoreRef = React.useRef(null);

  // Lazy remote poll while synced: a folder read costs nothing and hits no
  // quota, so a slow interval (plus a check when the tab regains focus) is
  // how a teammate's push through the sync client shows up without waiting
  // for a local edit to conflict. checkRemote never throws and self-skips
  // while a push is in flight.
  useEffect(() => {
    if (status !== "ready") return;
    const check = () => {
      const bridge = folderStoreRef.current?.syncBridge;
      bridge?.checkRemote?.();
      bridge?.presence?.beat?.(); // regaining focus refreshes the coat-on-the-chair line too
    };
    const t = setInterval(() => folderStoreRef.current?.syncBridge?.checkRemote?.(), 30_000);
    window.addEventListener("focus", check);
    return () => { clearInterval(t); window.removeEventListener("focus", check); };
  }, [status]);

  // Build + install the folder composite for a link whose permission is granted.
  async function install(l) {
    setStatus("building");
    try {
      const { buildFolderStore } = await import("./lib/fs/composite.js");
      // getDir re-checks permission on every provider call: a lapse mid-session
      // throws, which the reconciler treats as offline (local stays canonical).
      const getDir = async () => {
        if ((await queryFolderPermission(l.handle)) !== "granted") {
          throw new Error("folder permission lapsed");
        }
        return l.handle;
      };
      const next = buildFolderStore(l.scope, getDir);
      setActiveStore(next);
      folderStoreRef.current = next;
      setStatus("ready");
    } catch (e) {
      setErr(String(e?.message || e));
      setStatus("dead");
    }
  }

  useEffect(() => {
    let live = true;
    (async () => {
      let l = null;
      try {
        l = await loadFolderLink();
      } catch {
        l = null; // unreadable meta → plain local, never a wall
      }
      if (!live) return;
      if (!l) { setStatus("plain"); return; }
      setLink(l);
      const perm = await queryFolderPermission(l.handle);
      if (!live) return;
      if (perm === "granted") await install(l);
      else setStatus("prompt"); // "denied" also lands here — the button re-asks
    })();
    // Uninstall on unmount so leaving the route restores the plain local store
    // (mirrors ProjectGate's exit cleanup).
    return () => { live = false; setActiveStore(); };
  }, []);

  if (status === "checking" || status === "building") return null; // ~ms IDB read — no flash
  if (status === "plain") return <TakeoffCanvas />;
  if (status === "ready") return <TakeoffCanvas key={`folder:${link.scope}`} />;

  const forget = async () => { await forgetFolder(); setStatus("plain"); };
  if (status === "prompt") {
    return (
      <div style={centered}>
        {brand}
        <div style={{ fontSize: 15, fontWeight: 600 }}>This workspace syncs to the folder “{link.name}”</div>
        <div style={{ fontSize: 13, color: "var(--ink-muted)", maxWidth: 460 }}>
          The browser needs you to re-allow access after a restart — one click, and your takeoff
          keeps syncing through that folder. Nothing leaves your machine except what the folder's
          own sync client replicates.
        </div>
        <button type="button"
          onClick={async () => {
            const perm = await requestFolderPermission(link.handle);
            if (perm === "granted") await install(link);
            else setErr("The browser did not grant access. You can keep working locally, or forget the folder.");
          }}
          style={{ padding: "9px 16px", border: "1px solid var(--ink)", background: "var(--ink)",
            color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 13.5 }}>
          Resume folder sync
        </button>
        {err ? <div style={{ fontSize: 12.5, color: "var(--c-danger)", maxWidth: 460 }}>{err}</div> : null}
        <div style={{ display: "flex", gap: 16 }}>
          <button type="button" onClick={() => setStatus("plain")}
            style={{ border: "none", background: "transparent", color: "var(--ink-muted)", fontSize: 12.5, cursor: "pointer", textDecoration: "underline" }}>
            not now — work locally
          </button>
          <button type="button" onClick={forget}
            style={{ border: "none", background: "transparent", color: "var(--c-danger)", fontSize: 12.5, cursor: "pointer", textDecoration: "underline" }}>
            forget this folder
          </button>
        </div>
      </div>
    );
  }
  // dead: the handle exists but the store can't build (folder deleted, drive
  // unplugged). Local work is safe; say exactly that.
  return (
    <div style={centered}>
      {brand}
      <div style={{ fontSize: 15, fontWeight: 600 }}>The synced folder “{link?.name}” can't be opened</div>
      <div style={{ fontSize: 13, color: "var(--ink-muted)", maxWidth: 460 }}>
        {err || "The folder may have been moved or deleted."} Your takeoff is safe in this browser —
        you can keep working locally, or forget the folder link.
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        <button type="button" onClick={() => setStatus("plain")}
          style={{ padding: "9px 16px", border: "1px solid var(--ink)", background: "var(--ink)",
            color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 13.5 }}>
          Work locally
        </button>
        <button type="button" onClick={forget}
          style={{ border: "none", background: "transparent", color: "var(--c-danger)", fontSize: 12.5, cursor: "pointer", textDecoration: "underline" }}>
          forget this folder
        </button>
      </div>
    </div>
  );
}

// 365-synced workspace (#315, EXPERIMENTAL — awaiting a live tenant proof):
// when the build is configured for a document library (msgraph/config.js) AND
// this browser opted in, wrap the anonymous workspace with the Graph-backed
// composite. Same install-then-mount discipline as the other gates; every
// state is readable, never a wedge. MSAL and all Graph code load only here.
function M365Gate({ cfg }) {
  // status: checking | signin | building | ready | local | dead
  const [status, setStatus] = useState("checking");
  const [err, setErr] = useState("");
  const modRef = React.useRef(null);
  const storeRef = React.useRef(null);

  async function loadModules() {
    if (modRef.current) return modRef.current;
    const [{ createMsalAuth }, { buildM365Store }, { createGraphDrive }] = await Promise.all([
      import("./lib/msgraph/auth.js"),
      import("./lib/msgraph/composite.js"),
      import("./lib/msgraph/graphDrive.js"),
    ]);
    modRef.current = { auth: createMsalAuth(cfg), buildM365Store, createGraphDrive };
    return modRef.current;
  }
  async function install() {
    const m = await loadModules();
    const graph = m.createGraphDrive({ getToken: m.auth.getToken, driveId: cfg.driveId });
    const next = m.buildM365Store(cfg, graph);
    setActiveStore(next);
    storeRef.current = next;
    setStatus("ready");
  }

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const m = await loadModules();
        const acc = await m.auth.currentAccount();
        if (!live) return;
        if (acc) await install();
        else setStatus("signin"); // cached session gone — one readable click re-enters
      } catch (e) {
        if (live) { setErr(String(e?.message || e)); setStatus("dead"); }
      }
    })();
    return () => { live = false; setActiveStore(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lazy remote poll: Graph reads cost quota, so 2 minutes + a focus check —
  // still inside one coffee refill for noticing a teammate's push.
  useEffect(() => {
    if (status !== "ready") return;
    const check = () => {
      const bridge = storeRef.current?.syncBridge;
      bridge?.checkRemote?.();
      bridge?.presence?.beat?.();
    };
    const t = setInterval(() => storeRef.current?.syncBridge?.checkRemote?.(), 120_000);
    window.addEventListener("focus", check);
    return () => { clearInterval(t); window.removeEventListener("focus", check); };
  }, [status]);

  const stop = async () => {
    try { await modRef.current?.auth.signOut(); } catch { /* local cache clear is best-effort */ }
    await metaDelete(M365_ENABLED_KEY);
    window.location.reload();
  };

  if (status === "checking" || status === "building") return null;
  if (status === "ready") return <TakeoffCanvas key={`m365:${cfg.driveId}:${cfg.folderId}`} />;
  if (status === "local") return <TakeoffCanvas />;

  const linkBtn = { border: "none", background: "transparent", color: "var(--ink-muted)", fontSize: 12.5, cursor: "pointer", textDecoration: "underline" };
  if (status === "signin") {
    return (
      <div style={centered}>
        {brand}
        <div style={{ fontSize: 15, fontWeight: 600 }}>This workspace syncs through your Microsoft 365 library</div>
        <div style={{ fontSize: 13, color: "var(--ink-muted)", maxWidth: 460 }}>
          Sign in with your work account to keep syncing. The token stays in this browser —
          there is no server of ours between you and your tenant. (Experimental — issue #315.)
        </div>
        <button type="button"
          onClick={async () => {
            setErr("");
            try {
              const m = await loadModules();
              await m.auth.signIn();
              setStatus("building");
              await install();
            } catch (e) {
              setErr(`Sign-in failed: ${String(e?.message || e)} — if this is an admin-consent block, SELF_HOSTING.md names the scope to consent.`);
            }
          }}
          style={{ padding: "9px 16px", border: "1px solid var(--ink)", background: "var(--ink)",
            color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 13.5 }}>
          Sign in with Microsoft
        </button>
        {err ? <div style={{ fontSize: 12.5, color: "var(--c-danger)", maxWidth: 460 }}>{err}</div> : null}
        <div style={{ display: "flex", gap: 16 }}>
          <button type="button" onClick={() => setStatus("local")} style={linkBtn}>not now — work locally</button>
          <button type="button" onClick={stop} style={{ ...linkBtn, color: "var(--c-danger)" }}>stop syncing through 365</button>
        </div>
      </div>
    );
  }
  // dead: modules or store failed — say exactly that, local work is safe.
  return (
    <div style={centered}>
      {brand}
      <div style={{ fontSize: 15, fontWeight: 600 }}>365 sync can't start</div>
      <div style={{ fontSize: 13, color: "var(--ink-muted)", maxWidth: 460 }}>
        {err || "The Microsoft sign-in layer failed to load."} Your takeoff is safe in this browser.
        This path is experimental (issue #315) — a report of this exact message is exactly the
        external testing it needs.
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        <button type="button" onClick={() => setStatus("local")}
          style={{ padding: "9px 16px", border: "1px solid var(--ink)", background: "var(--ink)",
            color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 13.5 }}>
          Work locally
        </button>
        <button type="button" onClick={stop} style={{ ...linkBtn, color: "var(--c-danger)" }}>stop syncing through 365</button>
      </div>
    </div>
  );
}

// Pick the local workspace's shadow: the 365 library when configured AND this
// browser opted in, else the folder link, else the plain local canvas —
// decided before any store installs, so the canvas never mounts twice.
function WorkspaceGate() {
  const cfg = m365Config();
  const [pick, setPick] = useState(cfg ? null : "folder");
  useEffect(() => {
    if (!cfg) return;
    let live = true;
    metaGet(M365_ENABLED_KEY)
      .then((v) => { if (live) setPick(v === true ? "m365" : "folder"); })
      .catch(() => { if (live) setPick("folder"); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (pick === null) return null; // ~ms IDB read — no flash
  return pick === "m365" ? <M365Gate cfg={cfg} /> : <FolderGate />;
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
  // opt-in link on that screen, never a wall in front of it. A persisted
  // folder link (#316) or 365 opt-in (#315) wraps this same local workspace
  // with sync.
  return <WorkspaceGate />;
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
