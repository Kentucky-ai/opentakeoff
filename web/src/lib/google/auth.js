// Google sign-in — the optional team-only cloud mode.
//
// OpenTakeoff runs fully anonymous and local by default (see store.js); nothing
// here is required to load a plan, draw a takeoff, or export. This module only
// lights up when a deployment sets VITE_GOOGLE_CLIENT_ID: it lets a Workspace
// team sign in with Google and store projects in a shared Drive folder instead
// of this browser's IndexedDB.
//
// Trust model: the OAuth app is registered as "Internal", so Google itself only
// issues tokens to accounts in the org — the domain is enforced at Google, not
// by us (VITE_GOOGLE_HD is only a UI hint to the account chooser). The client_id
// is public by design (that's how browser OAuth works) and there is NO
// client_secret — this is the Google Identity Services token-client flow.
// Access tokens live in a module-level variable ONLY; they are never written to
// localStorage/sessionStorage/IndexedDB, so a closed tab forgets them.

const GSI_SRC = "https://accounts.google.com/gsi/client";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

// openid/email/profile identify the user; drive is the project storage; the
// spreadsheets scope is read-only (report/template sheets are pulled, never
// written by this build).
const SCOPE = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
].join(" ");

// Refresh a bit before the real expiry so an in-flight Drive call never races
// the token going stale.
const EXPIRY_SKEW_MS = 60_000;

// ── in-memory state (never persisted) ───────────────────────────────────────
let tokenClient = null;         // the GIS token client, created once
let scriptPromise = null;       // de-dupes the <script> injection
let token = null;               // { accessToken, expiresAt } | null
let user = null;                // { email, name, picture, sub, hd } | null
let pending = null;             // resolver/rejecter for the current requestAccessToken
let pendingPromise = null;      // in-flight requestToken() promise, for coalescing
const listeners = new Set();

function clientId() {
  // Vite inlines this at build; empty string = cloud mode off.
  return (import.meta.env && import.meta.env.VITE_GOOGLE_CLIENT_ID) || "";
}

function domainHint() {
  return (import.meta.env && import.meta.env.VITE_GOOGLE_HD) || "";
}

export function isGoogleConfigured() {
  return !!clientId();
}

function notify() {
  for (const cb of listeners) {
    try { cb(user); } catch { /* a subscriber throwing must not break the rest */ }
  }
}

// Subscribe to sign-in / sign-out. Returns an unsubscribe fn.
export function onAuthChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getUser() {
  return user;
}

export function isSignedIn() {
  return !!token && !!user;
}

// Inject the GIS script once and resolve when its oauth2 API is live. Guards
// against double-injection: concurrent callers share one Promise, and a script
// tag already in the DOM (e.g. a preload) is reused.
function loadGsi() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    // Null the cached promise on any failure so a later preload/sign-in retries
    // the load — otherwise one offline/errored attempt would wedge sign-in until
    // a full page refresh.
    const fail = (msg) => { scriptPromise = null; reject(new Error(msg)); };
    const done = () => {
      if (window.google?.accounts?.oauth2) resolve();
      else fail("Google Identity Services loaded but oauth2 API is unavailable.");
    };
    const existing = document.querySelector(`script[src="${GSI_SRC}"]`);
    if (existing) {
      if (window.google?.accounts?.oauth2) return resolve();
      existing.addEventListener("load", done, { once: true });
      existing.addEventListener("error", () => fail("Failed to load Google Identity Services."), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = GSI_SRC;
    s.async = true;
    s.defer = true;
    s.onload = done;
    s.onerror = () => fail("Failed to load Google Identity Services.");
    document.head.appendChild(s);
  });
  return scriptPromise;
}

// Preload the GIS script without triggering any sign-in prompt — lets the
// provider warm the API on mount so the first click is instant.
export function preloadGoogle() {
  if (!isGoogleConfigured()) return Promise.resolve();
  return loadGsi();
}

async function ensureTokenClient() {
  if (!isGoogleConfigured()) {
    throw new Error("Google sign-in is not configured for this build.");
  }
  await loadGsi();
  if (tokenClient) return tokenClient;
  const hd = domainHint();
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId(),
    scope: SCOPE,
    ...(hd ? { hd } : {}),
    // GIS calls back event-style; we route each response to the resolver that
    // requestToken() parked in `pending` before calling requestAccessToken().
    callback: (resp) => {
      const p = pending;
      pending = null;
      if (!p) return;
      if (resp?.error) {
        p.reject(new Error(resp.error_description || resp.error));
        return;
      }
      token = {
        accessToken: resp.access_token,
        // expires_in is seconds from now
        expiresAt: Date.now() + (Number(resp.expires_in) || 0) * 1000,
      };
      p.resolve(token.accessToken);
    },
    // GIS fires error_callback (NOT callback) when the user closes/dismisses the
    // consent popup or it fails to open (popup_closed_by_user /
    // popup_failed_to_open). Without this, `pending` would never settle: signIn()
    // would hang and every later token request would coalesce onto a promise that
    // never resolves. Reject so the UI can show it and the user can retry.
    error_callback: (err) => {
      const p = pending;
      pending = null;
      if (p) p.reject(new Error(err?.message || err?.type || "Google sign-in was cancelled."));
    },
  });
  return tokenClient;
}

// Wrap the event-style requestAccessToken in a Promise. `prompt: 'consent'`
// forces the account chooser (first sign-in); `prompt: ''` refreshes silently.
async function requestToken(prompt) {
  const client = await ensureTokenClient();
  // Coalesce concurrent requests onto one in-flight token call. The canvas issues
  // Drive calls in parallel, so at expiry several getAccessToken() callers hit the
  // silent-refresh branch on the same tick; they must share the refresh, not have
  // all-but-one reject. `pending` still carries the resolver GIS's callbacks fire.
  if (pendingPromise) return pendingPromise;
  pendingPromise = new Promise((resolve, reject) => {
    pending = { resolve, reject };
    try {
      client.requestAccessToken({ prompt });
    } catch (e) {
      reject(e);
    }
  }).finally(() => { pending = null; pendingPromise = null; });
  return pendingPromise;
}

async function fetchProfile(accessToken) {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to load Google profile (HTTP ${res.status}).`);
  const p = await res.json();
  return { email: p.email, name: p.name, picture: p.picture, sub: p.sub, hd: p.hd };
}

// Try to restore a session with NO visible prompt — a live Google session plus
// a prior consent grant for our scopes lets GIS hand back a token silently.
// Resolves to null (never rejects) when that's not possible, so callers can
// fall back to an interactive sign-in instead of surfacing this as an error.
export async function trySilentSignIn() {
  if (!isGoogleConfigured()) return null;
  try {
    const accessToken = await requestToken("");
    user = await fetchProfile(accessToken);
    notify();
    return user;
  } catch {
    return null;
  }
}

// Interactive sign-in: try silently first (covers a returning user whose
// earlier consent grant just wasn't picked up automatically, e.g. this is the
// first GIS call of the tab) and only fall back to the full consent/account
// picker when that fails — `prompt: "consent"` always shows that screen even
// for a user who already granted access, so it's a last resort, not the
// default. Resolves with the user object. The token stays in memory only.
export async function signIn() {
  if (!isGoogleConfigured()) {
    throw new Error("Google sign-in is not configured for this build.");
  }
  let accessToken;
  try {
    accessToken = await requestToken("");
  } catch {
    accessToken = await requestToken("consent");
  }
  user = await fetchProfile(accessToken);
  notify();
  return user;
}

// Return a valid access token, refreshing silently when it's missing or within
// the skew window of expiry. Callers (the Drive client) treat this as the one
// source of truth for the Bearer header.
export async function getAccessToken() {
  if (token && Date.now() < token.expiresAt - EXPIRY_SKEW_MS) {
    return token.accessToken;
  }
  return requestToken("");
}

// Sign out: forget the token + user and best-effort revoke at Google. Revoke
// failures are ignored — the token is already unreachable once we drop it.
export function signOut() {
  const t = token?.accessToken;
  token = null;
  user = null;
  if (t && window.google?.accounts?.oauth2?.revoke) {
    try { window.google.accounts.oauth2.revoke(t); } catch { /* best effort */ }
  }
  notify();
}
