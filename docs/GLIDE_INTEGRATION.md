# Glide integration — wiring the project list to the takeoff app

Your team already runs its projects in **Glide**. This guide wires that existing
app to OpenTakeoff so an estimator can open any project's takeoff in one tap,
against the shared Google Drive.

This is part of the optional team cloud mode. It assumes the one-time Google
setup is done — see [`GOOGLE_SETUP.md`](GOOGLE_SETUP.md).

---

## The model

- **Glide owns the project list.** There is no project database of ours; Glide
  is the source of truth for what projects exist.
- **Each project row carries its Drive folder id.** Add a column (text) to your
  projects table that holds the Drive **folder id** of that project's folder
  under `OpenTakeoff/Projects/`. Optionally keep a second column with the full
  folder URL for humans.
- **The folder id is the handle.** OpenTakeoff opens a project by its Drive
  folder id, passed in the URL. Everything else — the plan PDFs, the takeoff
  payload, the generated proposal — lives inside that folder in Drive.

```
OpenTakeoff/ (Shared Drive)
  Projects/
    <project folder>/   ← the id of THIS folder goes in the Glide row
```

## Add an "Open takeoff" action in Glide

Give each project row a button (or link) that opens:

```
https://takeoff.345flooring.com/?project=<driveFolderId>
```

In Glide:

1. Add a **template column** — call it *Takeoff URL* — that builds the link from
   your folder-id column. The template is:

   ```
   https://takeoff.345flooring.com/?project={FolderId}
   ```

   (replace `{FolderId}` with a reference to your Drive-folder-id column).
2. Add an **Open Link** action / button to the project detail screen that opens
   that template column, labeled **Open takeoff**.

Tapping it drops the user straight into that project inside OpenTakeoff. If they
aren't signed in yet, the app prompts for Google sign-in first (and, being an
Internal app, only domain accounts get through).

## Why the folder id in the URL is safe

Passing `?project=<driveFolderId>` is **not** handing out a credential:

- A Drive folder id is an **identifier, not a key**. Knowing it grants nothing.
- **Google still gates every access.** The app reads and writes that folder with
  the signed-in user's own token; Google checks that user's Drive permissions on
  each call. Someone without access to the Shared Drive gets nothing, folder id
  or not.
- **Signing in is still required and domain-enforced.** The Internal OAuth app means
  only accounts in your Workspace domain can even sign in (see
  [`GOOGLE_SETUP.md`](GOOGLE_SETUP.md)).

So a folder-id link is safe to store in Glide, put in a button, or paste in a
team chat — it's only useful to someone Google already lets in.

## Optional: auto-create the Drive folder from Glide

To avoid creating folders by hand, add a Glide **automation / workflow** that
fires when a project row is created:

1. Create a folder under `OpenTakeoff/Projects/` (through a Drive step, or a call
   out to Apps Script / a small automation).
2. **Write the new folder id back** to that project row's folder-id column.

From then on the *Open takeoff* button works the moment a project exists.

## The pricing feed

Material costs come from a `pricing.json` file in the shared Drive
(`material`, `unit`, `unit_cost`). Its source of truth is your pricing database — **Postgres/Neon**,
or **Glide Big Tables**.

A background **sync job** exports that data to `pricing.json` and drops it in the
`OpenTakeoff/` Drive folder; the app reads the file (through `VITE_PRICING_FILE_ID`)
with the signed-in user's token.

Key points, kept brief:

- **The sync job is the only place credentials live.** Database URLs and any
  Glide/Neon API keys stay in that job's own environment — **never** in the
  browser bundle.
- **It can start simple.** A manual export or a scheduled **Glide automation**
  writing `pricing.json` is enough to begin. A live API proxy that serves prices
  on demand is a later option, not required for v1.
- Once the file exists, copy its Drive **file id** into `VITE_PRICING_FILE_ID`
  (see [`web/.env.example`](../web/.env.example)).
