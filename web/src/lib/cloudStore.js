// Drive-backed store adapter — the same seam as localStore (store.js), but for
// one project's Google Drive folder.
//
// This implements the exact interface the takeoff canvas already talks to, so
// swapping `store` for a cloudStore turns on team storage with no canvas
// changes. Scope is a single Drive folder (`folderId`): the plan PDFs and the
// annotations JSON for one project live as files inside it.
//
// Deliberate split: PROJECT files (PDFs, annotations.json) go to Drive, but the
// BROWSER-GLOBAL, cross-project assets — condition templates, the material and
// stamp libraries, and local snapshots — DELEGATE to localStore unchanged.
// Those aren't project-scoped, and Drive-backed versioning of them is a planned
// follow-up; keeping them local now matches the rollout plan and avoids
// entangling per-project cloud state with browser-wide libraries.

import { localStore, ANN_SCHEMA, emptyAnnotations } from "./store.js";

const PDF_MIME = "application/pdf";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const ANN_NAME = "annotations.json";
const SHEETS_NAME = "sheets.json";
// Our JSON sidecars live in a dedicated per-project subfolder, not loose next to
// the client's plan PDFs. PDFs themselves stay in the project folder.
const SIDECAR_NAME = ".opentakeoff";

/**
 * @param {string} folderId               the project's Drive folder
 * @param {ReturnType<import('./google/drive.js').createDrive>} drive
 * @param {{ local?: typeof localStore }} [opts]  inject localStore for tests
 */
export function createCloudStore(folderId, drive, { local = localStore } = {}) {
  // ── sidecar folder resolution ────────────────────────────────────────────
  // annotations.json / sheets.json live inside <project>/.opentakeoff/. Two
  // resolvers, split by intent so a read-only viewer never litters empty
  // sidecar folders:
  //
  //   findSidecarFolder() — NON-creating, used by every READ path. Deliberately
  //     NOT memoized (and never caches a null): a read that misses the folder
  //     now must still see it once a later write in the same session creates it.
  //   ensureSidecarId()   — memoized create-once, used ONLY by write/create
  //     branches. Mirrors ensureAnnId: locate else create, cache the promise,
  //     clear on failure to retry. Serialization stops two concurrent
  //     first-writes from each spawning a duplicate .opentakeoff.
  async function findSidecarFolder() {
    const child = await drive.findChild(folderId, SIDECAR_NAME);
    // Must be an actual FOLDER: findChild matches by name only, so a stray
    // (non-folder) file named ".opentakeoff" would otherwise be mistaken for the
    // sidecar and we'd try to write JSON "inside" a file. Ignore it — ensureSidecarId
    // then creates a real folder (Drive tolerates the same-name file alongside).
    return child && child.mimeType === FOLDER_MIME ? child.id : null;
  }
  let sidecarIdP = null;
  function ensureSidecarId() {
    if (!sidecarIdP) {
      sidecarIdP = (async () => {
        const existing = await findSidecarFolder();
        if (existing) return existing;
        const { id } = await drive.createFolder(folderId, SIDECAR_NAME);
        return id;
      })().catch((e) => { sidecarIdP = null; throw e; });
    }
    return sidecarIdP;
  }

  // Locate a sidecar JSON file (annotations.json / sheets.json), preferring the
  // canonical copy in .opentakeoff/ but falling back to a LEGACY loose file in
  // the project folder for migration. Returns { child, legacy } where `child`
  // is the record to read content from (or null if neither exists) and `legacy`
  // is true when the winner is the loose file — the caller MUST NOT cache a
  // legacy id (see loadAnnotations / ensureManifest), so the first save
  // create-branches into the sidecar and migrates the content forward.
  //
  // Split-brain tiebreak: if BOTH exist, prefer the newer modifiedTime, so a
  // mid-rollout window where an old tab still writes the loose file and a new
  // client writes the sidecar resolves to whichever was written last.
  async function findSidecarJson(name) {
    const sidecarId = await findSidecarFolder();
    const inSidecar = sidecarId ? await drive.findChild(sidecarId, name) : null;
    const legacy = await drive.findChild(folderId, name);
    if (inSidecar && legacy) {
      // both present → newer modifiedTime wins the tiebreak
      const useLegacy = String(legacy.modifiedTime) > String(inSidecar.modifiedTime);
      return useLegacy ? { child: legacy, legacy: true } : { child: inSidecar, legacy: false };
    }
    if (inSidecar) return { child: inSidecar, legacy: false };
    if (legacy) return { child: legacy, legacy: true };
    return { child: null, legacy: false };
  }

  // Seed content for a sidecar file we're about to create: if a legacy loose
  // file exists, migrate its content forward instead of writing an empty default
  // (an empty sidecar could otherwise shadow real legacy data for a concurrent
  // reader). A corrupt legacy file must NOT wedge the save — unlike a corrupt
  // READ (loadAnnotations throws CloudLoadError to keep autosave disarmed), the
  // seed-on-write branch is best-effort: fall back to `fallback` if getJson
  // throws.
  async function seedFromLegacy(name, fallback) {
    const legacy = await drive.findChild(folderId, name);
    if (!legacy) return fallback;
    try {
      const data = await drive.getJson(legacy.id);
      return data || fallback;
    } catch {
      return fallback;
    }
  }

  // Memoized promise that resolves the single annotations.json file id — locate
  // an existing file (in the sidecar folder), else create one exactly once
  // inside the sidecar. Shared by load and save so that concurrent autosaves on
  // a brand-new project can't each take the "create" branch and spawn duplicate
  // annotations.json files (a later load would then pick one arbitrarily and
  // lose the other's edits). A failed locate/create is not cached, so the next
  // call retries.
  let annIdP = null;
  function ensureAnnId() {
    if (!annIdP) {
      annIdP = (async () => {
        const sidecarId = await ensureSidecarId();
        const child = await drive.findChild(sidecarId, ANN_NAME);
        if (child) return child.id;
        // create branch: migrate legacy loose content forward if present
        const data = await seedFromLegacy(ANN_NAME, emptyAnnotations());
        const { id } = await drive.putJson({ folderId: sidecarId, name: ANN_NAME, data, existingId: null });
        return id;
      })().catch((e) => { annIdP = null; throw e; });
    }
    return annIdP;
  }

  // The working-set manifest (sheets.json): the PDFs the user has explicitly
  // picked into this project, in pick order. The gallery reads ONLY this — we no
  // longer enumerate (and download) every PDF in the Drive folder, which for a
  // real folder of spec books and as-builts would be ruinous.
  //
  // READ path (ensureManifest): memoized locate-or-treat-absent-as-empty, and
  // deliberately DOES NOT create the file (mirrors how loadAnnotations never
  // creates on a read). It caches the located id into `sheetsId` and the chosen
  // set into `manifestFiles`, so listSheets/loadPdfData can resolve name→id
  // synchronously after the first read. A failed read is not cached, so the next
  // call retries.
  //
  // WRITE path (mutateManifest): every mutation is serialized through one
  // promise chain. Serialization is what makes create-once safe — the FIRST
  // write sees existingId null, creates sheets.json, and caches its id; every
  // later write reuses that id. Two overlapping addSheets/addPdf/removePdf can no
  // longer both take putJson's create branch (which would spawn a duplicate
  // sheets.json and lose one set of picks — the exact hazard ensureAnnId guards).
  let manifestP = null;
  /** @type {{ id: string, name: string }[]} */
  let manifestFiles = [];
  /** @type {string | null} */
  let sheetsId = null;
  function ensureManifest() {
    if (!manifestP) {
      manifestP = (async () => {
        const { child, legacy } = await findSidecarJson(SHEETS_NAME);
        if (!child) { manifestFiles = []; sheetsId = null; return manifestFiles; }
        // Cache the id ONLY on a sidecar hit. On a legacy hit we read content but
        // leave sheetsId null, so the first mutateManifest create-branches into
        // the sidecar and migrates the content forward (see loadAnnotations for
        // the same linchpin). Corrupt legacy content must not wedge the first
        // save: mutateManifest awaits ensureManifest, so unlike the annotations
        // READ path we swallow a parse error here and treat it as an empty
        // manifest rather than throwing.
        let data;
        try {
          data = await drive.getJson(child.id);
        } catch (e) {
          if (legacy) { manifestFiles = []; sheetsId = null; return manifestFiles; }
          throw e;
        }
        sheetsId = legacy ? null : child.id;
        manifestFiles = (data && Array.isArray(data.files)) ? data.files : [];
        return manifestFiles;
      })().catch((e) => { manifestP = null; throw e; });
    }
    return manifestP;
  }

  // Serialized, persist-then-commit manifest write. Each mutation waits its turn,
  // reads the latest committed `manifestFiles`, computes the next array via `fn`,
  // persists it, and only ON SUCCESS caches the returned id + commits the new
  // array. If putJson throws, in-memory state is left untouched (so a failed
  // write can't diverge memory from disk) and the error propagates.
  let writeChain = Promise.resolve();
  /** @param {(files: { id: string, name: string }[]) => { id: string, name: string }[]} fn */
  function mutateManifest(fn) {
    const run = writeChain.then(async () => {
      await ensureManifest();
      const next = fn(manifestFiles);
      // Resolve the write target. If we already hold the sidecar file's id (a
      // sidecar-hit read cached it), update in place. Otherwise resolve the
      // sidecar folder and RE-DISCOVER an existing sheets.json before
      // create-branching: a legacy-tiebreak read leaves sheetsId null even when a
      // sidecar file already exists, so a blind create would spawn a DUPLICATE
      // sheets.json (a later findChild then picks one arbitrarily and loses
      // picks). This mirrors the re-discovery ensureAnnId does at its create
      // branch. `next` was computed from `manifestFiles`, which ensureManifest
      // already seeded from any legacy loose file, so an in-place update or a
      // fresh create both migrate that content forward.
      let writeId = sheetsId;
      let createIn = folderId;   // only consulted when writeId stays null (create)
      if (!writeId) {
        createIn = await ensureSidecarId();
        const existing = await drive.findChild(createIn, SHEETS_NAME);
        if (existing) writeId = existing.id;
      }
      const { id } = await drive.putJson({ folderId: createIn, name: SHEETS_NAME, data: { files: next }, existingId: writeId });
      sheetsId = id;
      manifestFiles = next;
      return next;
    });
    // keep the chain alive even if this mutation rejects, so a failed write
    // doesn't wedge every subsequent one.
    writeChain = run.then(() => {}, () => {});
    return run;
  }

  return {
    async listSheets() {
      // Metadata/JSON only — deliberately NO getFileBytes on any PDF. Read the
      // live `manifestFiles` (not the promise's array), since writes swap it for
      // a fresh array on commit.
      await ensureManifest();
      return manifestFiles.map((f) => ({ name: f.name }));
    },

    async loadPdfData(name) {
      // Resolve by id from the manifest: picked files may live in SUBFOLDERS, so
      // a findChild-by-name in the project folder wouldn't find them.
      await ensureManifest();
      const entry = manifestFiles.find((f) => f.name === name);
      if (!entry) throw new Error(`PDF not in project sheet set: ${name}`);
      const bytes = await drive.getFileBytes(entry.id);
      // hand pdf.js a fresh view each call — getDocument({data}) may detach it
      return new Uint8Array(bytes);
    },

    /**
     * Browse a Drive folder for the picker: split children into folders and
     * PDFs. Metadata only — nothing downloads. Other file types are ignored.
     * @param {string} [browseFolderId]  defaults to the project folder
     */
    async listFolder(browseFolderId = folderId) {
      const children = await drive.listChildren(browseFolderId);
      const folders = [];
      const pdfs = [];
      for (const c of children) {
        // Hide our own sidecar folder from the picker — it's config, not a
        // browsable project subfolder. Match the EXACT name (not any leading-dot
        // folder) so a legit dot-prefixed user folder still shows.
        if (c.mimeType === FOLDER_MIME && c.name === SIDECAR_NAME) continue;
        if (c.mimeType === FOLDER_MIME) folders.push({ id: c.id, name: c.name });
        else if (c.mimeType === PDF_MIME) pdfs.push({ id: c.id, name: c.name, size: c.size, modifiedTime: c.modifiedTime });
      }
      return { folders, pdfs };
    },

    /**
     * Add picked PDFs to the working set, deduping by id AND by name (a file
     * already present under either key is skipped), then persist sheets.json.
     * @param {{ id: string, name: string }[]} items
     */
    async addSheets(items) {
      // Append, deduping by id AND name against the CURRENT committed set. Build
      // a fresh array (persist-then-commit) — mutateManifest only commits it if
      // the write lands.
      return mutateManifest((files) => {
        const next = [...files];
        for (const it of items) {
          if (next.some((f) => f.id === it.id || f.name === it.name)) continue;
          next.push({ id: it.id, name: it.name });
        }
        return next;
      });
    },

    async removePdf(name) {
      // Remove from the working set only — do NOT delete the Drive file, which
      // may be a shared spec book owned by someone else. No-op (no write) when
      // the name isn't in the set.
      await ensureManifest();
      if (!manifestFiles.some((f) => f.name === name)) return;
      await mutateManifest((cur) => cur.filter((f) => f.name !== name));
    },

    async removeFromProject(name) {
      // The DESTRUCTIVE sibling of removePdf: delete the actual Drive file, then
      // drop it from the working set. The manifest is name-keyed but Drive delete
      // needs the id, so resolve it from the manifest entry first. No-op when the
      // name isn't in the set (e.g. a sheet that never came from this manifest) —
      // there's no id to delete, and we must not guess one.
      await ensureManifest();
      const entry = manifestFiles.find((f) => f.name === name);
      if (!entry) return;
      // Delete the bytes BEFORE the manifest write so a failed delete leaves the
      // manifest (and the user's picks) intact rather than orphaning a live file.
      await drive.deleteFile(entry.id);
      await mutateManifest((cur) => cur.filter((f) => f.name !== name));
    },

    async addPdf(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // de-dupe by name: a re-dropped file replaces the existing bytes
      const existing = await drive.findChild(folderId, file.name);
      let fileId;
      if (existing) {
        await drive.updateFileBytes(existing.id, bytes, PDF_MIME);
        fileId = existing.id;
      } else {
        const created = await drive.uploadFile({ name: file.name, parentId: folderId, mimeType: PDF_MIME, bytes });
        fileId = created.id;
      }
      // a dropped PDF joins the working set (dedupe by id/name in addSheets)
      await this.addSheets([{ id: fileId, name: file.name }]);
      return { name: file.name };
    },

    async loadAnnotations() {
      const { child, legacy } = await findSidecarJson(ANN_NAME);
      // No file yet = a fresh project → the empty default (same as localStore).
      if (!child) return emptyAnnotations();
      // Cache the id for saves ONLY on a sidecar hit (bypass ensureAnnId's create
      // branch). On a legacy hit we read content but leave annIdP null — the
      // linchpin of migration: caching the legacy id would make the first
      // saveAnnotations rewrite the loose file in place, and the sidecar would
      // never be created. Instead ensureAnnId create-branches into the sidecar,
      // seeding from this same legacy content.
      if (!legacy) annIdP = Promise.resolve(child.id);
      let data;
      try {
        data = await drive.getJson(child.id);
      } catch (e) {
        // The file EXISTS but couldn't be read/parsed (network blip, truncated
        // upload, hand-edited JSON). Do NOT fall back to the empty default here:
        // the canvas would hydrate empty and autosave that over the real project.
        // Tagged so the canvas load can leave autosave DISARMED (like a stale tab)
        // instead of overwriting Drive. See TakeoffCanvas mount-load catch.
        throw Object.assign(
          new Error(`Couldn't read this project's saved takeoff from Drive — reload to retry. (${e?.message || e})`),
          { name: "CloudLoadError" },
        );
      }
      // A file that parsed to null/falsy is treated as empty (localStore's `a ||`
      // guard) — a degenerate file, safe to replace on the next save.
      return data || emptyAnnotations();
    },

    async saveAnnotations(payload) {
      const existingId = await ensureAnnId();
      // existingId is always truthy here, so putJson PATCHes by id and ignores
      // folderId — but target the SIDECAR folder anyway (both memoized, no extra
      // round-trip) so this never writes annotations loose into the project
      // folder if a future refactor makes existingId nullable.
      const sidecarId = await ensureSidecarId();
      await drive.putJson({ folderId: sidecarId, name: ANN_NAME, data: { ...payload, schema: ANN_SCHEMA }, existingId });
    },

    // ── browser-global assets (delegated untouched) ──────────────────────────
    // Condition templates and the material/stamp libraries are cross-project by
    // design, so they stay in localStore for now (see header).
    loadTemplates(...args) { return local.loadTemplates(...args); },
    saveTemplates(...args) { return local.saveTemplates(...args); },
    loadMaterialLibrary(...args) { return local.loadMaterialLibrary(...args); },
    saveMaterialLibrary(...args) { return local.saveMaterialLibrary(...args); },
    loadStampLibrary(...args) { return local.loadStampLibrary(...args); },
    saveStampLibrary(...args) { return local.saveStampLibrary(...args); },

    // ── snapshots: browser-local, but SCOPED to this Drive project ────────────
    // Storage stays in localStore (Drive-backed versioning is a later item), but
    // we pass folderId as the scope so one browser opening several projects can't
    // see or load another project's snapshots. deleteSnapshot is by unique id;
    // the panel only ever surfaces this project's ids.
    saveSnapshot(label, payload) { return local.saveSnapshot(label, payload, folderId); },
    listSnapshots() { return local.listSnapshots(folderId); },
    getSnapshot(id) { return local.getSnapshot(id, folderId); },
    deleteSnapshot(id) { return local.deleteSnapshot(id); },
  };
}
