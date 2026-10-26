# Self-hosting — the one gotcha

OpenTakeoff's own production deploy is Netlify-only (see
[`DEPLOYMENT.md`](DEPLOYMENT.md)), and Netlify's CDN gets content types right
automatically. If you build `web/dist` yourself and serve it from your own
reverse proxy instead—nginx behind Docker or Tailscale, for example—there's
one gotcha worth knowing about before you run into it blind.

## `.mjs` served as `application/octet-stream`

`npm run build` emits some chunks as `.mjs` (ES modules). Stock nginx's
default `mime.types` file has no entry for `.mjs`—only `.js`—so it falls
back to `application/octet-stream`. Browsers enforce strict MIME checking on
`<script type="module">`, so the module is silently refused and the app fails
to load with no obvious error beyond the browser console.

**Fix—if you control `mime.types`:** add `mjs` to the existing
`application/javascript` line:

```nginx
# /etc/nginx/mime.types
types {
    application/javascript                          js mjs;
    ...
}
```

**Fix—if you're on a base image and don't want to fork `mime.types`**
(for example, a minimal `nginx:alpine` Docker image), override only this extension in
your server block instead—this doesn't touch the rest of the type table:

```nginx
location ~* \.mjs$ {
    default_type application/javascript;
}
```

Confirmed against a real self-hosted deployment (Docker + nginx + Tailscale)—not
hypothetical.

## Microsoft 365 annotation sync (experimental — issue #315)

Sync the local workspace's annotations through a SharePoint document library
in **your own tenant**. Tokens live in the user's browser via MSAL — there is
no relay and no server of ours in the path. The feature is dark unless the
build is configured, and per-browser opt-in even then.

**Status: engine-proven, tenant-unproven.** The sync engine passes the full
reconciler suite against a mock Graph tenant, but nobody on this project has a
365 tenant to run the sign-in flow against. If you self-host with 365, you are
the validation path — success or failure, please report on
[#315](https://github.com/Kentucky-ai/opentakeoff/issues/315).

### 1. Register an app in Entra

- Microsoft Entra admin center → App registrations → **New registration**
- Supported account types: *Accounts in this organizational directory only*
  (single tenant) is the usual choice
- Platform: **Single-page application**, redirect URI = the exact origin you
  serve the app from (e.g. `https://takeoff.yourshop.com`)
- API permissions → Microsoft Graph → **Delegated** → `Files.ReadWrite.All`,
  then **Grant admin consent** (without it, users see a consent error at
  sign-in — that error is worth reporting too)

### 2. Find the document library's drive id

In [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer),
signed into your tenant:

- your OneDrive: `GET /me/drive` → `id`
- a SharePoint library: `GET /sites/{hostname}:/sites/{site-path}` → site `id`,
  then `GET /sites/{site-id}/drives` → pick the library → `id`
- optionally, a specific project folder inside it:
  `GET /drives/{drive-id}/root/children` → the folder's `id`

### 3. Configure the build

```bash
VITE_MSAL_CLIENT_ID=<application (client) id>
VITE_MSAL_TENANT=<tenant id or domain>          # default: organizations
VITE_GRAPH_DRIVE_ID=<drive id>
VITE_GRAPH_FOLDER_ID=<folder item id>           # default: root
npm run build
```

A configured build shows "sync through your Microsoft 365 library
(experimental)" on the landing screen. Signing in opts that browser in;
annotations then sync as `.opentakeoff/annotations.json` inside the folder —
the same sidecar, rev discipline, three-way merge, and presence heartbeats the
folder and Drive transports use. "Stop" (landing or Manage panel) opts back
out without touching local work.

### No tenant? Test with a personal Microsoft account

You do not need a business tenant to run the live round trip. Any Microsoft
account (outlook.com / hotmail.com / live.com) has a consumer OneDrive, which is
a Graph drive like any SharePoint library, and an app registration can be made
in a free Entra tenant:

1. [Sign up for a free Azure account](https://azure.microsoft.com/free) — it
   comes with an Entra tenant you administer. No subscription is needed for an
   app registration.
2. Register the app as in step 1 above, but choose **Accounts in any
   organizational directory and personal Microsoft accounts** as the supported
   account type. `Files.ReadWrite.All` is a delegated permission personal
   accounts grant themselves at sign-in — no admin consent.
3. In Graph Explorer, signed in with the personal account: `GET /me/drive` →
   `id`. That is `VITE_GRAPH_DRIVE_ID`; leave the folder as `root` or create a
   folder and use its item id.
4. Configure the build with `VITE_MSAL_TENANT=consumers` (or `common` if you
   will test both account types) and sign in with the personal account.

Two browsers (or one normal window and one incognito window signed into the
same account) are the two machines for the round trip. Report the result as a
consumer-OneDrive run — the corners it shares with business SharePoint are the
sign-in, the download path and throttling; the corners it does not are
admin-consent policies and library permissions.

### What the client does at the corners a tenant may hit

Written to Graph's documented contract and exercised against a mock tenant in
`web/test/graphDrive.test.ts` — but only a real tenant proves them:

- **A token the tenant revokes mid-session** (consent changed, password reset,
  conditional access): Graph answers 401; the client asks MSAL for **one
  forced refresh** and retries with the new token. A second 401 is surfaced
  as *"Microsoft 365 rejected the sign-in token … sign in again"* — never a
  silent "offline".
- **File content** is read through the item's `@microsoft.graph.downloadUrl`
  with **no Authorization header**. The `/content` stream redirects to that
  same URL on a different host, and whether a bearer on the redirected request
  is ignored or refused is exactly where business SharePoint and consumer
  OneDrive diverge; fetching the URL bare removes the question.
- **Throttling**: 429, 503 and 504 honor `Retry-After` in seconds or as an
  HTTP-date, capped at 15 s per wait, three tries, then a throw the reconciler
  reads as offline until its next poll.
- **403** names the permission stage (the account cannot reach the library, or
  the app lacks `Files.ReadWrite.All`).
- **Sign-in failures** name their stage in the landing screen — *consent*,
  *tenant*, *app registration*, *popup*, *network*, *sign-in* — with the
  AADSTS code in parentheses (`web/src/lib/msgraph/errors.js`).

### What to report on #315

- tenant type (business SharePoint / consumer OneDrive) and whether admin
  consent was needed
- the two-machine round trip: edit on A, see it on B within a couple of
  minutes (there's a 2-minute lazy poll plus a check on window focus)
- any error text verbatim — every failure state is written to be readable, and
  the exact wording tells us which stage broke
