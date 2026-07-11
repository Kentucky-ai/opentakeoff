# Serverless functions

The app is otherwise fully static; the only server code is the gated
schedule-scan reader. It stays **dark by default** — with no `GEMINI_API_KEY`
set, `/ai/parse-schedule` returns `501` and the "Import from a scanned schedule"
path never reaches a paid API. A default deploy is still 100% client-side.

## `parse-schedule.mjs` — gated scanned-schedule reader

When a marqueed schedule region has **no text layer** (a scanned/raster plan),
the canvas rasterizes it and POSTs the PNG here. This function reads the finishes
with a vision model and returns the same `ScheduleRow` shape the browser's vector
parser produces, so both feed the one approval dialog.

This endpoint spends money on every call, so it is **never public**:

1. Every request must carry a Google OAuth access token
   (`Authorization: Bearer …`). The client hides the feature when signed out,
   but **this server check is the real gate** — a hidden button doesn't stop
   `curl`.
2. The token is verified against Google, and the account's domain must match
   `ALLOWED_HD` when set.
3. The vision-model key lives **only** in this function's env — never in the
   browser bundle, never `VITE_`-prefixed, never committed.

### Environment variables (Netlify → Site settings → Environment)

| Variable         | Required | Default             | Notes |
| ---------------- | -------- | ------------------- | ----- |
| `GEMINI_API_KEY` | to enable | *(unset ⇒ off)*    | Google AI Studio key. Server-only secret. If unset, the endpoint returns `501` and the scan path stays off. |
| `GEMINI_MODEL`   | no       | `gemini-3.5-flash`  | Any `generateContent`-capable Gemini model id. Bump the default when Google retires it (early `404 NOT_FOUND` retirements happen — the function logs them distinctly). |
| `ALLOWED_HD`     | no       | *(any verified Google account)* | Restrict to one Workspace domain, e.g. `345flooring.com`. Leave unset to allow any account that passes Google verification. |

Set `ALLOWED_HD` to your Workspace domain in a real deployment so only your team
can spend against the key.
