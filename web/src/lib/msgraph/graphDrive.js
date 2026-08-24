// Microsoft Graph driveItem client (#315) — the second provider. Mirrors the
// EXACT surface of google/drive.js (listChildren / findChild / getFileBytes /
// getJson / createFolder / uploadFile / updateFileBytes / putJson /
// deleteFile), so both sync layers — the annotation provider
// (sync/provider.js) and snapshot sync (google/snapshotSync.js) — drop on top
// of a 365 tenant's document library UNCHANGED. syncStore.js never learns
// which cloud it is on; that is the whole point of the seam.
//
// Addressing: a SharePoint document library / OneDrive folder is a Graph
// drive; folders and files are driveItems addressed by id within one
// `driveId`. The project "folder id" the app threads around is the driveItem
// id, exactly as a Drive folder id is today. Name lookups use Graph's
// path-relative addressing (/items/{parent}:/{name}) — no fragile $filter.
//
// Auth stays OUT of this file: the client takes an injected async getToken,
// the same shape auth.js gives the Drive client. Tokens live in the user's
// browser (MSAL against the user's OWN tenant when that wiring ships) —
// there is no relay, no token store, no server of ours in the path. That
// invariant is the security model and it is non-negotiable.
//
// Throttling (the RFC's named hazard): Graph answers 429 (and sometimes 503)
// with a Retry-After. The reconciler treats provider throws as "offline", so
// backoff lives HERE: honor Retry-After up to 3 attempts with a hard cap per
// wait, then throw — a sustained throttle degrades to offline, never a wedge.

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// The sync layers compare against the Drive folder mime; the Graph client
// speaks the same token so consumers stay provider-blind.
const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * @param {object} opts
 * @param {() => Promise<string>} opts.getToken async access-token source (MSAL later; injected in tests)
 * @param {string} opts.driveId   the document library's Graph drive id
 * @param {typeof fetch} [opts.fetch]    injectable for tests
 * @param {(ms:number)=>Promise<void>} [opts.sleep] injectable for tests
 * @param {string} [opts.base]    injectable Graph origin for tests
 */
export function createGraphDrive({ getToken, driveId, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), base = GRAPH_BASE }) {
  const item = (id) => `${base}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}`;
  // Path-relative child addressing: /items/{parent}:/{name} to address the
  // item, /items/{parent}:/{name}:/content to reach its content stream (the
  // closing colon appears only when a further segment follows — Graph's rule).
  const childPath = (parentId, name, suffix = "") =>
    `${base}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parentId)}:/${encodeURIComponent(name)}${suffix ? `:${suffix}` : ""}`;

  async function authHeaders(extra) {
    const t = await getToken();
    return { Authorization: `Bearer ${t}`, ...extra };
  }

  // fetch with Retry-After honor. Waits are capped (15 s) and bounded (3
  // tries) so a hard throttle surfaces as a throw — "offline" upstream — not
  // an unbounded stall under the user's autosave.
  async function graphFetch(url, init) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, init);
      if ((res.status !== 429 && res.status !== 503) || attempt >= 2) return res;
      const ra = Number(res.headers?.get?.("Retry-After"));
      await sleep(Math.min(Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 1000, 15_000));
    }
  }

  async function assertOk(res, what) {
    if (res.ok) return res;
    let detail = "";
    try { detail = (await res.text()) || ""; } catch { /* body may be unreadable */ }
    throw new Error(`Graph ${what} failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}.`);
  }

  // driveItem → the record shape google/drive.js returns, folder facet mapped
  // onto the Drive folder mime so mimeType comparisons keep working.
  const record = (it) => ({
    id: it.id,
    name: it.name,
    mimeType: it.folder ? FOLDER_MIME : (it.file?.mimeType || "application/octet-stream"),
    modifiedTime: it.lastModifiedDateTime,
    size: it.size,
  });

  async function listChildren(folderId, { mimeType } = {}) {
    const out = [];
    let url = `${item(folderId)}/children?$select=id,name,folder,file,lastModifiedDateTime,size&$top=200`;
    while (url) {
      const res = await graphFetch(url, { headers: await authHeaders() });
      await assertOk(res, "list");
      const data = await res.json();
      for (const it of data.value || []) out.push(record(it));
      url = data["@odata.nextLink"] || "";
    }
    return mimeType ? out.filter((r) => r.mimeType === mimeType) : out;
  }

  async function findChild(folderId, name) {
    const res = await graphFetch(childPath(folderId, name), { headers: await authHeaders() });
    if (res.status === 404) return null;
    await assertOk(res, "find");
    return record(await res.json());
  }

  async function getFileBytes(fileId) {
    // /content answers 302 to a pre-authenticated download URL; fetch follows.
    const res = await graphFetch(`${item(fileId)}/content`, { headers: await authHeaders() });
    await assertOk(res, "download");
    return new Uint8Array(await res.arrayBuffer());
  }

  async function getJson(fileId) {
    const bytes = await getFileBytes(fileId);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async function uploadFile({ name, parentId, mimeType, bytes }) {
    // Simple upload: PUT to the path creates-or-replaces in one call (the
    // annotation sidecars are far under Graph's 4 MB simple-upload ceiling;
    // large-media uploads are cloudStore's future problem, not the sync seam's).
    const res = await graphFetch(childPath(parentId, name, "/content"), {
      method: "PUT",
      headers: await authHeaders(mimeType ? { "Content-Type": mimeType } : undefined),
      body: bytes,
    });
    await assertOk(res, "upload");
    const data = await res.json();
    return { id: data.id, name: data.name };
  }

  // Folder create must NOT let Graph's default conflictBehavior "rename" mint
  // a silent "presence 1" sibling — fail on conflict, then resolve the
  // existing folder by path so concurrent creators converge on ONE folder
  // (the F4 split-brain discipline, enforced at the API's own seam).
  async function createFolder(parentId, name) {
    const res = await graphFetch(`${item(parentId)}/children`, {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    if (res.status === 409) {
      const existing = await findChild(parentId, name);
      if (existing) return { id: existing.id, name: existing.name };
    }
    await assertOk(res, "create folder");
    const data = await res.json();
    return { id: data.id, name: data.name };
  }

  async function updateFileBytes(fileId, bytes, mimeType) {
    const res = await graphFetch(`${item(fileId)}/content`, {
      method: "PUT",
      headers: await authHeaders(mimeType ? { "Content-Type": mimeType } : undefined),
      body: bytes,
    });
    await assertOk(res, "update");
    const data = await res.json();
    return { id: data.id };
  }

  /** @param {{ folderId: string, name: string, data: unknown, existingId?: string | null }} opts */
  async function putJson({ folderId, name, data, existingId = null }) {
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    if (existingId) {
      return updateFileBytes(existingId, bytes, "application/json");
    }
    const created = await uploadFile({ name, parentId: folderId, mimeType: "application/json", bytes });
    return { id: created.id };
  }

  async function deleteFile(fileId) {
    const res = await graphFetch(item(fileId), { method: "DELETE", headers: await authHeaders() });
    if (res.status === 404) return; // already gone — deletion is idempotent here
    await assertOk(res, "delete");
  }

  return { listChildren, findChild, getFileBytes, getJson, createFolder, uploadFile, updateFileBytes, putJson, deleteFile };
}
