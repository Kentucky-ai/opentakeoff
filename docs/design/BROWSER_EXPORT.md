# Export everything (.otkx) and the backup reminder

OpenTakeoff keeps a person's work in the browser (IndexedDB plus
localStorage) and nowhere else. A browser can clear that storage to free disk
space, and until now nothing asked it not to, and no export carried more than
one project. This change adds three things:

1. a one-time `navigator.storage.persist()` request on load;
2. a reminder to back up, shown while there is something to lose;
3. **Export everything** and **Import everything**: every project in this
   browser as one `.otkx` file, and back.

## Scope

- **In:** every record of the four IndexedDB stores (`pdfs`, `pdf_revs`,
  `snapshots`, `meta`), which covers every project (`annotations` and each
  `annotations:<id>`), every plan PDF and every archived revision, every
  snapshot, the condition template, material and stamp libraries, sheet page
  and rotation caches, sync state and OCR caches. The app's own localStorage
  keys go in too, and so does a copy of the `.otprofile`.
- **Left out on purpose, and listed in the manifest's `excluded`:** a folder
  link (`fsync:handle`, a `FileSystemDirectoryHandle` that only works in the
  browser that made it), sheet thumbnails (`thumb:*`, redrawn when needed),
  credentials (`opentakeoff_ai_key`, the assistant link's token in
  `ot.assistant.link.v1`, any app key ending in key, token, secret or
  password), and this browser's own backup state.
- **Out:** syncing, scheduling, encryption. Import adds and replaces by key;
  it never deletes a record the backup doesn't carry.
- **Never changes:** the persisted formats. No field, store or DB version is
  added. The only new localStorage key is `opentakeoff_backup_state`.

## File format

`.otkx` is a plain zip, readable by any unzip tool:

```
manifest.json            schema opentakeoff.browser_export.v1
local_storage.json       { key: raw string }
profile.otprofile        the same document Export profile writes
idb/<store>/000001.json  [{ "k": key, "v": encoded value }, …] in ~4 MB batches
bin/<store>/<n>.bin      a binary part of a record (PDF bytes), stored (level 0)
```

The manifest carries `app_version`, `created`, `complete`, counts (projects,
pdfs, pdf_revs, snapshots, meta records, local storage keys, libraries, bytes,
entries), the project keys, every batch file per store, the local storage key
names, `omitted` (each record left out by a limit, with its size and reason),
`excluded` (above) and the limits in force. It is written last, so it
describes what is actually in the file.

Values are encoded so JSON says them exactly. Binary parts (`Blob`, `File`,
`ArrayBuffer`, typed arrays) move to their own `bin/` entry and leave a tag;
`Date`, `undefined`, non-finite numbers, `BigInt` and an object that owns the
tag key `$otkx` are tagged as well. A value that holds anything else (a file
handle, a class instance) can't travel, and its record is listed in `omitted`
rather than half-written.

Readers refuse an unknown `schema` loudly, like the `.otk` and `.otprofile`.

## Streaming and limits

Export reads one record at a time, reads a PDF in 8 MB slices, and hands each
slice to fflate's streaming `Zip`. Output chunks go straight to the sink: a
file on disk through `showSaveFilePicker` where the browser has it (Chromium),
otherwise Blob parts rolled every 64 MB, which the browser can keep on disk,
then a download.

Import reads the zip's central directory from the end of the chosen file and
never inflates the archive whole. A stored PDF goes back into IndexedDB as a
slice of the chosen `File`, which the browser copies from disk. Before writing
anything it checks the manifest and the CRC-32 of every entry (binary entries
in 8 MB slices), so a damaged file is refused before it touches the database.

The budgets match the `.otk` and the zip ingest: 2 GB and 10,000 entries.
Export takes records in priority order (project and library records, then
snapshots, plans, older revisions, OCR caches) and skips any record that would
cross a budget; the dialog lists what was left out with sizes. Import refuses
a file whose directory exceeds either budget before reading it.

## Overwrite rule

Import first inspects the file against this browser. A key that already
exists here with a different record is a conflict; an identical record is
not, so re-importing a backup into the browser that made it changes nothing
and asks nothing. With any conflict the dialog names the items and the button
stays disabled until the person ticks **Replace … with the backup's copy**.
`applyBrowserExport` repeats the check itself and throws
`ImportConflictError` unless called with `overwrite: true`. No `confirm()`.

## Reminder rule

`backupReminder(state, { hasData })` in `web/src/lib/backupStatus.js`:

- nothing shown while the browser holds no plan, snapshot or project record;
- nothing shown within 14 days of **Not now**;
- nothing shown within 14 days of a finished export;
- otherwise shown, with copy that depends on whether the browser granted
  persistent storage.

Note on the brief: it read "shown when persistence was not granted or no
backup was made in 14 days". Applied literally, a browser that refuses
persistence (headless Chromium does) would show the reminder right after a
backup. Here a recent backup satisfies both conditions; persistence only
changes the wording. The rule is one function with its own tests if this
reading is wrong.

## Placement

- **File menu** (the top-right overflow menu, and the sheet menu that shares
  its items, plus Find an action): **Back up everything…**, next to Export
  project archive.
- **Reminder:** lower left, above the status footer, clear of the tool tray at
  desktop widths; capped to the viewport width on a phone.
- The dialog and reminder are one component mounted at the app root
  (`BackupCenter.jsx`), opened by a window event, so the canvas gained one
  menu row and no props.

## Files

| Path | What |
|---|---|
| `web/src/lib/browserExport.js` | format, encoder, streaming writer, zip directory reader, inspect, apply, sinks |
| `web/src/lib/backupStatus.js` | persist request, backup state, reminder rule |
| `web/src/components/BackupCenter.jsx` | reminder and dialog |
| `web/src/lib/store.js` | `withStoreDb`: the database opened and always closed, for whole-store reads |
| `web/src/main.jsx` | mounts `BackupCenter` |
| `web/src/pages/TakeoffCanvas.jsx` | the File menu row |
| `web/test/browserExport.test.ts`, `web/test/backupStatus.test.ts` | tests |

## Known limits

- Firefox and Safari have no `showSaveFilePicker`, so the archive is gathered
  as Blob parts before the download. Browsers usually keep large Blobs on disk,
  but this path was only measured in Node and headless Chromium.
- A legacy plan record stored as an `ArrayBuffer` (before #580) is read whole
  once to write it; it comes back as an `ArrayBuffer`, as it was stored.
- After an import, the page has to reload to open the restored projects (the
  dialog offers the button). The store's per-session hash memo is rebuilt on
  reload.
- No ZIP64: a file over 4 GB can't be read, which the 2 GB budget keeps from
  happening.
