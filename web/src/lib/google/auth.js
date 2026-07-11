// Google sign-in — the optional team-only cloud mode.
//
// OpenTakeoff runs fully anonymous and local by default (see store.js); nothing
// here is required to load a plan, draw a takeoff, or export. This module only
// lights up when a deployment sets VITE_GOOGLE_CLIENT_ID: it lets a Workspace
// team sign in with Google and store projects in a shared Drive folder instead
// of this browser's IndexedDB.
//
// Trust model: the OAuth app is registered as "Internal", so Google itself only
// issues tokens to accounts in the org — Google and the server (ALLOWED_HD) are
// the real domain enforcement. VITE_GOOGLE_HD drives the account-chooser hint
// and a client-side defense-in-depth gate (isAllowedDomain) so a non-org account
// can't ping the paid scan reader even if the app is ever set External. The client_id
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

// How long we'll wait on a SILENT (prompt: "") token request before giving up.
// GIS's popup-close detection polls `window.closed`, which the browser blocks
// once Google's own popup response sets Cross-Origin-Opener-Policy: same-origin
// (a documented GIS/COOP interaction bug, not something our own headers can
// fix — the restriction is imposed by accounts.google.com's response, not
// ours). When that happens the silent attempt can open a blank popup that
// never reports back, hanging the caller indefinitely. This timeout is ONLY
// for the silent path — the interactive consent popup below is never
// time-boxed, since a human is expected to take their time on it.
const SILENT_TIMEOUT_MS = 4000;

// ── in-memory state (never persisted) ───────────────────────────────────────
let tokenClient = null;         // the GIS token client, created once
let scriptPromise = null;       // de-dupes the <script> injection
let token = null;               // { accessToken, expiresAt } | null
let user = null;                // { email, name, picture, sub, hd } | null
let pending = null;             // { resolve, reject, id } for the current requestAccessToken, or null
let pendingPromise = null;      // in-flight requestToken() promise, for coalescing
let requestSeq = 0;             // monotonic id — correlates a GIS callback back to ITS request
const listeners = new Set();

function clientId() {
  // Vite inlines this at build; empty string = cloud mode off.
  return (import.meta.env && import.meta.env.VITE_GOOGLE_CLIENT_ID) || "";
}

function domainHint() {
  return (import.meta.env && import.meta.env.VITE_GOOGLE_HD) || "";
}

// The raw build-time org domain (VITE_GOOGLE_HD), exposed so the scan caller can
// stamp it on its request for the server's drift cross-check (the server compares
// it to its runtime ALLOWED_HD and warns on mismatch — see parse-schedule.mjs).
// Diagnostic only: the server's token+ALLOWED_HD gate stays authoritative and
// never trusts this value. Returns "" when cloud mode is unlocked (no domain).
export function orgDomainHint() {
  return domainHint();
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

// Pure org-domain match — the decision behind isAllowedDomain(), split out so it
// is unit-testable without the module's private sign-in state. `allowed` is a
// comma-separated list (an org whose one Workspace spans several domains lists
// them all, e.g. "345flooring.com,345constructionco.com"); the account is in if
// its domain is ANY of them. Derives the domain EXACTLY as the server does
// (netlify/functions/parse-schedule.mjs): the Workspace `hd` claim, falling back
// to the email's domain, case-folded. An empty `allowed` ⇒ any account (parity
// with an empty server ALLOWED_HD). No user + a set list ⇒ false (fails closed).
export function domainAllows(allowed, user) {
  const list = (allowed || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;             // no domains configured ⇒ any account (server parity)
  if (!user) return false;
  const dom = (user.hd || (user.email || "").split("@")[1] || "").toLowerCase();
  return list.includes(dom);
}

// Is the signed-in user inside the configured org domain? Client-side
// defense-in-depth for the PAID scan reader: so a signed-in account OUTSIDE the
// domain never even pings the paid endpoint — the server would 403 it, but we
// don't want, e.g., a personal gmail that signed in for the free local features
// to be able to trigger a spend. NOTE: VITE_GOOGLE_HD is inlined at BUILD time
// and must match the server's runtime ALLOWED_HD — see the deploy workflow. If
// the build var is unset this returns true (server stays authoritative). The
// scan caller stamps orgDomainHint() on its request so the server can warn if
// these two ever drift apart (#91).
export function isAllowedDomain() {
  return domainAllows(domainHint(), user);
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
    // `state` round-trips the request id we passed in (see requestToken) — a
    // SILENT request abandoned on timeout (requestTokenSilentWithTimeout) is
    // no longer the current `pending` by the time its popup eventually (if
    // ever) calls back, so without this check a late, stale response could
    // resolve/reject whatever NEWER request has since taken its place.
    callback: (resp) => {
      const p = pending;
      if (!p) return;
      if (resp?.state !== undefined && String(p.id) !== resp.state) return;
      pending = null;
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
    // Same stale-response guard as `callback` above, best-effort: GIS's public
    // reference doesn't document `state` being echoed on the error path (only
    // `type` is guaranteed), so when it's absent we fall back to the prior
    // behavior of trusting whatever is in `pending`. In practice this residual
    // gap is narrow — the failure mode we're guarding against (the COOP bug
    // blocking window.closed) is what stops GIS from detecting a popup closing
    // in the first place, so an abandoned request's error_callback firing late
    // with a mismatched-but-absent state is an edge case, not the common path.
    error_callback: (err) => {
      const p = pending;
      if (!p) return;
      if (err?.state !== undefined && String(p.id) !== err.state) return;
      pending = null;
      p.reject(new Error(err?.message || err?.type || "Google sign-in was cancelled."));
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
  const id = ++requestSeq;
  const attempt = new Promise((resolve, reject) => {
    pending = { resolve, reject, id };
    try {
      client.requestAccessToken({ prompt, state: String(id) });
    } catch (e) {
      reject(e);
    }
  });
  pendingPromise = attempt;
  attempt.finally(() => {
    // Only clear the shared slot if it's still THIS request's — a timeout
    // elsewhere (requestTokenSilentWithTimeout) may already have abandoned us
    // and installed a newer one; clearing unconditionally here would corrupt
    // that newer request's state.
    if (pending && pending.id === id) pending = null;
    if (pendingPromise === attempt) pendingPromise = null;
  });
  return attempt;
}

// Race a SILENT token request against a timeout. On timeout we abandon it —
// null out `pending`/`pendingPromise` — so a subsequent requestToken() call
// (e.g. signIn()'s fallback to "consent") issues a genuinely new request
// instead of coalescing onto the stuck one. If the abandoned request's popup
// eventually DOES call back, requestToken()'s per-request `id` (round-tripped
// via GIS's `state`) keeps it from resolving/rejecting whatever newer request
// has since taken its place — see the callback/error_callback comments above.
function requestTokenSilentWithTimeout() {
  const attempt = requestToken("");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending = null;
      pendingPromise = null;
      reject(new Error("Silent Google sign-in timed out"));
    }, SILENT_TIMEOUT_MS);
    attempt.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function fetchProfile(accessToken) {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to load Google profile (HTTP ${res.status}).`);
  const p = await res.json();
  return { email: p.email, name: p.name, picture: p.picture, sub: p.sub, hd: p.hd };
}

// Interactive sign-in — ALWAYS user-initiated (a click on "Sign in with Google
// Drive"). A single `prompt: ""` request does the right thing on its own: GIS
// returns a token with no visible UI for a user who already granted our scopes
// ("just log me in"), and shows the account chooser / consent screen for anyone
// who hasn't. We deliberately do NOT use the timeout-guarded silent path here:
// the consent screen is a human reading a dialog, which routinely takes longer
// than SILENT_TIMEOUT_MS — timing it out would abandon the request mid-consent
// and (via the state guard) drop the token the moment the user clicks Allow,
// breaking first-time sign-in. The timeout is only for the non-interactive
// getAccessToken() refresh, where a stuck popup must never hang a Drive call.
// The token stays in memory only. Resolves with the user object; rejects (so
// the caller can surface it) if the user closes/cancels the dialog.
export async function signIn() {
  if (!isGoogleConfigured()) {
    throw new Error("Google sign-in is not configured for this build.");
  }
  const accessToken = await requestToken("");
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
  return requestTokenSilentWithTimeout();
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
