# Google setup — team cloud mode (one-time)

This is the operator's guide for turning on OpenTakeoff's **optional** team-only
cloud mode: Google sign-in plus a shared Google Drive. It's a one-time setup,
done once for the whole team.

None of this changes the default app. Anonymous visitors keep the local-only
browser experience — no account, no upload, nothing here required. Signing in
just unlocks the shared-Drive mode for your crew. All the values you produce
below are **public** (a client id, a domain, folder/file ids) and are safe to
ship in the bundle; the actual access boundary is enforced by Google, not by a
secret. See the security model at the end.

You'll need: a Google Cloud account, and a team that's on **Google Workspace**
(a shared domain, e.g. `345flooring.com`). Workspace is what makes the "Internal"
consent screen — and therefore the whole "just our team" guarantee — possible.

---

## 1. Create a Google Cloud project and enable APIs

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a
   project (or choose an existing one) — e.g. `opentakeoff`.
2. Enable the APIs the app calls, under **APIs & Services → Library**:
   - **Google Drive API** — reads/writes project files in the shared Drive.
   - **Google Sheets API** — reads tabular per-project data and the pricing feed.

## 2. Configure the OAuth consent screen as **Internal**

Under **APIs & Services → OAuth consent screen**:

1. Choose **User type: Internal**, and finish the basic app details.
2. Add these scopes:
   - `openid`
   - `email`
   - `profile`
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/spreadsheets.readonly`

**Why Internal is the whole security win.** An Internal app can only be used by
accounts inside your Workspace domain — **Google itself refuses the login** for
anyone outside it. That single setting is what enforces "just our team": there's
no allow-list for us to maintain and no way for an outside Google account to get
in. Internal apps also **skip Google's app-verification / review** process, even
with the broad `drive` scope, because the audience is your own organization.

> **Least-privilege alternative (future tightening).** The `drive` scope grants
> access to all of a user's Drive. A tighter setup uses `drive.file` plus the
> **Google Picker** — the app then only ever sees files the user explicitly
> opens or that the app itself created. It's more moving parts, so it's noted
> here as a later hardening step rather than the starting point.

## 3. Create an OAuth 2.0 Client ID (Web application)

Under **APIs & Services → Credentials → Create credentials → OAuth client ID**:

1. **Application type: Web application.**
2. **Authorized JavaScript origins** — add:
   - `https://takeoff.345flooring.com` (production)
   - `http://localhost:5173` (local dev)
3. There is **no client secret** in this flow. OpenTakeoff uses the Google
   Identity Services browser token-client (PKCE-style) flow, which authenticates
   with the public client id and the authorized origin — nothing secret ships in
   the bundle. If Google shows you a client secret, you can ignore it; the
   browser app doesn't use it.
4. Copy the **Client ID** into your build environment:

   ```dotenv
   VITE_GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   VITE_GOOGLE_HD=345flooring.com
   ```

   `VITE_GOOGLE_HD` is your Workspace domain — the "hosted domain" hint that,
   together with the Internal consent screen, keeps login scoped to your team.
   See [`web/.env.example`](../web/.env.example) for the full list of variables.

## 4. Create the shared Drive

The app stores everything in the team's own Google Drive — there is no database
of ours.

1. Create a **Shared Drive** named `OpenTakeoff`.
2. Inside it, create a `Projects/` folder.
3. **Share the Shared Drive with your team's Google group** (e.g. the group that
   maps to your Workspace domain). Drive's own sharing is what decides who can
   read and write the files — grant it to the team, no wider.

The layout the app expects:

```
OpenTakeoff/ (Shared Drive)
  pricing.json              (synced material costs: material, unit, unit_cost)
  Projects/
    <project folder>/       (one per takeoff project)
      *.pdf                  (plan sheets)
      annotations.json       (the takeoff payload)
      project.json / *.csv   (ingestable per-project data beside the documents)
      proposal.pdf           (generated)
```

Each **per-project folder lives under `Projects/`**, and its Drive **folder id**
is the handle to the project. That folder id is what your Glide project list
deep-links to — `https://takeoff.345flooring.com/?project=<driveFolderId>` — so
opening a project from Glide lands the signed-in user directly in that folder.
See [`GLIDE_INTEGRATION.md`](GLIDE_INTEGRATION.md).

Drop the `pricing.json` file id into `VITE_PRICING_FILE_ID` once the pricing
sync job (also in [`GLIDE_INTEGRATION.md`](GLIDE_INTEGRATION.md)) is writing it.

## 5. (Optional) Enable local-first sync

By default a cloud project is **Drive-canonical**: the canvas reads and writes the
project's `annotations.json` straight to Drive, so every edit waits on the network.

Setting **`VITE_CLOUD_SYNC=1`** at build time flips the whole deployment to
**local-first**: annotations and snapshots become canonical in the browser
(IndexedDB) and sync to Drive in the background. The canvas is instant, survives a
flaky connection, and a project opens from its last local state immediately. PDFs
and the sheet manifest stay Drive-canonical (they're big and team-owned). How the
pieces fit together is in [`SYNC_ARCHITECTURE.md`](SYNC_ARCHITECTURE.md).

```dotenv
VITE_CLOUD_SYNC=1
```

**Roll it out to the whole fleet at once — this is a safety rule, not a preference.**
Only a build with the flag on honors the sync **revision precondition** that keeps
two devices from overwriting each other. A build with it off does an unconditional
write. So if some teammates are on an enabled build and others aren't, the flag-off
clients can silently clobber a flag-on client's edits on a **shared** project. The
flag is therefore **deployment-wide on purpose** (not a per-user toggle):

1. Deploy the enabled build to everyone (one env var — no per-user setup, nothing
   to click). The unit of rollout is the deployment.
2. Until the whole crew is on the enabled build, **don't share a project across a
   mixed fleet.** Solo/unshared projects are always safe; the risk is only two
   people on one project across different builds.
3. **Rollback is one env change + redeploy** — set `VITE_CLOUD_SYNC=` (empty) and
   ship; the app is byte-for-byte back to Drive-canonical, no code revert. Caveat:
   edits made while local-first that hadn't yet pushed live in that browser's
   IndexedDB, so they're invisible to teammates after a rollback until re-pushed
   (inherent to local-first).

Mixed-fleet protection is a *net*, not a guarantee: an enabled client treats a
flag-off teammate's write as an authoritative external edit and **snapshots the
local side before adopting it** (recoverable via the Snapshots panel), rather than
losing it silently. The actual guarantee is the process rule above — flip everyone,
then share.

---

## Security model

- **The bundle has no secrets.** The client id, the Workspace domain, and the
  Drive folder/file ids are all public identifiers. There is no client secret,
  API key, or database credential in the browser.
- **The Internal app enforces the team boundary.** Google refuses login to any
  account outside your Workspace domain — that, not any code of ours, is what
  keeps the app team-only.
- **Drive sharing enforces data access.** Files are read and written with the
  signed-in user's own Google token; Google checks that user's Drive permissions
  on every call. Access is exactly whoever you shared the Shared Drive with.
- **Access tokens are short-lived and held in memory only.** The browser token
  client obtains a short-lived access token for the session; nothing long-lived
  is persisted.
- **It stays a static site.** Turning this on adds no backend — OpenTakeoff is
  still a static build talking directly to Google's APIs from the browser.

## Troubleshooting

- **A non-domain account can't sign in.** Expected. An Internal consent screen
  rejects any account outside your Workspace domain — that's the feature working.
- **"Access blocked" / "app blocked" on sign-in.** Almost always one of two
  things: the OAuth consent screen isn't set to **Internal**, or the site's
  origin isn't in **Authorized JavaScript origins** (check for an exact match,
  including `https://` and no trailing slash).
- **Sign-in works but Drive calls fail.** Confirm the **Drive API** and
  **Sheets API** are enabled in the project, that the requested scopes were
  granted, and that the user has been shared into the `OpenTakeoff` Shared Drive.
