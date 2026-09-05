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
// Throttling (the RFC's named hazard): Graph answers 429 (and sometimes 503 /
// 504) with a Retry-After — in seconds, or as an HTTP-date. The reconciler
// treats provider throws as "offline", so backoff lives HERE: honor Retry-After
// up to 3 attempts with a hard cap per wait, then throw — a sustained throttle
// degrades to offline, never a wedge.
//
// Real-tenant corners (#315 hardening, tenant-unproven but written to Graph's
// documented contract so a tester's failure names its stage):
// - A 401 mid-session is a token that expired or was revoked (consent changed,
//   password reset, conditional-access re-evaluation). The client asks the
//   token source ONCE for a forced refresh and retries; a second 401 throws a
//   GraphAuthError naming the sign-in stage, which the gate shows instead of
//   silently reading as "offline" forever.
// - File content is read through the item's `@microsoft.graph.downloadUrl` —
//   a short-lived pre-authenticated URL fetched with NO Authorization header.
//   `/content` answers 302 to that same URL on a different host
//   (*.sharepoint.com / *.1drv.com); a bearer on the redirected request is
//   exactly the corner where business SharePoint and consumer OneDrive diverge
//   (one ignores it, the other can refuse it), and browsers differ on whether
//   they strip it. Reading the URL and fetching it bare removes the question.

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// The sync layers compare against the Drive folder mime; the Graph client
// speaks the same token so consumers stay provider-blind.
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** A Graph reply that means "this browser is no longer signed in usefully" —
 *  the token source could not produce a token Graph accepts. Surfaced as its
 *  own class so the gate can say "sign in again" instead of "offline". */
export class GraphAuthError extends Error {
  constructor(message, status) { super(message); this.name = "GraphAuthError"; this.stage = "sign-in"; this.status = status; }
}

/** Retry-After as milliseconds: Graph sends seconds; RFC 7231 also allows an
 *  HTTP-date. Anything unparseable → the fallback. */
export function retryAfterMs(value, now = Date.now(), fallbackMs = 1000) {
  if (value == null || value === "") return fallbackMs;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs >= 0 ? secs * 1000 : fallbackMs;
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - now) : fallbackMs;
}

/**
 * @param {object} opts
 * @param {(opts?: {forceRefresh?: boolean}) => Promise<string>} opts.getToken async access-token source
 *   (MSAL in the app; injected in tests). Called with {forceRefresh: true} exactly once after a 401.
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

  async function authHeaders(extra, tokenOpts) {
    const t = await getToken(tokenOpts);
    return { Authorization: `Bearer ${t}`, ...extra };
  }

  const THROTTLED = new Set([429, 503, 504]);

  // fetch with Retry-After honor and ONE forced token refresh on 401. Waits
  // are capped (15 s) and bounded (3 tries) so a hard throttle surfaces as a
  // throw — "offline" upstream — not an unbounded stall under the user's
  // autosave. `init.headers` is rebuilt for the retry after a 401 so the
  // refreshed token is what goes out.
  async function graphFetch(url, init) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, init);
      if (res.status === 401 && !refreshed && init?.headers?.Authorization) {
        refreshed = true;
        let fresh;
        try { fresh = await getToken({ forceRefresh: true }); }
        catch (e) { throw new GraphAuthError(`Microsoft 365 sign-in expired and could not be refreshed silently — sign in again (${String(e?.message || e)}).`, 401); }
        init = { ...init, headers: { ...init.headers, Authorization: `Bearer ${fresh}` } };
        continue;
      }
      if (!THROTTLED.has(res.status) || attempt >= 2) return res;
      await sleep(Math.min(retryAfterMs(res.headers?.get?.("Retry-After")), 15_000));
    }
  }

  async function assertOk(res, what) {
    if (res.ok) return res;
    let detail = "";
    try { detail = (await res.text()) || ""; } catch { /* body may be unreadable */ }
    if (res.status === 401) throw new GraphAuthError(`Microsoft 365 rejected the sign-in token on ${what} (HTTP 401) even after a refresh — sign in again${detail ? `: ${detail}` : "."}`, 401);
    if (res.status === 403) throw new GraphAuthError(`Microsoft 365 refused ${what} (HTTP 403) — the signed-in account cannot reach this library, or the app was not granted Files.ReadWrite.All (see SELF_HOSTING.md, Microsoft 365 → step 1)${detail ? `: ${detail}` : "."}`, 403);
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
    // The item's pre-authenticated download URL, fetched BARE (no bearer): the
    // documented browser path, and the one that does not depend on what a
    // given tenant's download host does with an Authorization header.
    const meta = await graphFetch(`${item(fileId)}?$select=id,content.downloadUrl`, { headers: await authHeaders() });
    await assertOk(meta, "download");
    const data = await meta.json();
    const url = data["@microsoft.graph.downloadUrl"];
    if (typeof url === "string" && url) {
      const res = await graphFetch(url, { method: "GET" });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      // the short-lived URL can expire between the two calls — one more
      // round through the item, then give up readably
      const again = await graphFetch(`${item(fileId)}?$select=id,content.downloadUrl`, { headers: await authHeaders() });
      await assertOk(again, "download");
      const url2 = (await again.json())["@microsoft.graph.downloadUrl"];
      const res2 = url2 ? await graphFetch(url2, { method: "GET" }) : res;
      await assertOk(res2, "download (pre-authenticated URL)");
      return new Uint8Array(await res2.arrayBuffer());
    }
    // no downloadUrl on the item (a folder, a zero-byte placeholder, an odd
    // tenant): the /content stream with the bearer, as before
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
