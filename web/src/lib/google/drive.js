// Google Drive v3 REST client — browser talks to Google directly.
//
// Drive's API allows CORS, so there is no backend or proxy in the loop: each
// call carries a Bearer access token minted for the signed-in user (auth.js),
// and the browser fetches straight from googleapis.com. Every request is
// Shared-Drive aware (`supportsAllDrives`, plus `includeItemsFromAllDrives` on
// listings) so a team can keep projects on a Shared Drive, not just My Drive.
//
// Built as a factory over injected `getToken` + `fetch` so the whole surface is
// testable without a network or a real login — see test/drive.test.ts.

const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";

/**
 * @param {object} opts
 * @param {() => Promise<string>} opts.getToken  async access-token source
 * @param {typeof fetch} [opts.fetch]            injectable for tests
 */
export function createDrive({ getToken, fetch = globalThis.fetch }) {
  // Escape a value for the Drive `q` search grammar, where '...' delimits string
  // literals. Both backslash and single quote must be backslash-escaped —
  // backslash FIRST, or we'd double-escape the ones we add for quotes. (A name
  // like O'Brien or one containing a literal backslash would otherwise break the
  // query and silently miss.)
  function escapeQ(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  async function authHeaders(extra) {
    const t = await getToken();
    return { Authorization: `Bearer ${t}`, ...extra };
  }

  // Throw a message that carries the HTTP status and any response body, so a
  // failed call is diagnosable from the console — mirrors contribute.js.
  async function assertOk(res, what) {
    if (res.ok) return res;
    let detail = "";
    try { detail = (await res.text()) || ""; } catch { /* body may be unreadable */ }
    throw new Error(`Drive ${what} failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}.`);
  }

  async function listChildren(folderId, { mimeType } = {}) {
    const clauses = [`'${escapeQ(folderId)}' in parents`, "trashed=false"];
    if (mimeType) clauses.push(`mimeType='${escapeQ(mimeType)}'`);
    const out = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: clauses.join(" and "),
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await fetch(`${FILES_URL}?${params}`, { headers: await authHeaders() });
      await assertOk(res, "list");
      const data = await res.json();
      for (const f of data.files || []) {
        out.push({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, size: f.size });
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    return out;
  }

  async function findChild(folderId, name) {
    const params = new URLSearchParams({
      q: `'${escapeQ(folderId)}' in parents and name='${escapeQ(name)}' and trashed=false`,
      fields: "files(id,name,mimeType,modifiedTime)",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    const res = await fetch(`${FILES_URL}?${params}`, { headers: await authHeaders() });
    await assertOk(res, "find");
    const data = await res.json();
    const f = (data.files || [])[0];
    return f ? { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime } : null;
  }

  async function getFileBytes(fileId) {
    const params = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
    const res = await fetch(`${FILES_URL}/${encodeURIComponent(fileId)}?${params}`, { headers: await authHeaders() });
    await assertOk(res, "download");
    return new Uint8Array(await res.arrayBuffer());
  }

  async function getJson(fileId) {
    const bytes = await getFileBytes(fileId);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async function uploadFile({ name, parentId, mimeType, bytes }) {
    // Multipart upload: a JSON metadata part, then the media part, glued with a
    // boundary into one body. We build it by hand as a Blob so the media stays
    // raw binary (no base64) — the metadata names the file and its parent.
    const boundary = "otk_boundary_" + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name, parents: [parentId] });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      meta,
      `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      bytes,
      `\r\n--${boundary}--\r\n`,
    ]);
    const params = new URLSearchParams({ uploadType: "multipart", supportsAllDrives: "true" });
    const res = await fetch(`${UPLOAD_URL}?${params}`, {
      method: "POST",
      headers: await authHeaders({ "Content-Type": `multipart/related; boundary=${boundary}` }),
      body,
    });
    await assertOk(res, "upload");
    const data = await res.json();
    return { id: data.id, name: data.name };
  }

  async function updateFileBytes(fileId, bytes, mimeType) {
    const params = new URLSearchParams({ uploadType: "media", supportsAllDrives: "true" });
    const res = await fetch(`${UPLOAD_URL}/${encodeURIComponent(fileId)}?${params}`, {
      method: "PATCH",
      headers: await authHeaders(mimeType ? { "Content-Type": mimeType } : undefined),
      body: bytes,
    });
    await assertOk(res, "update");
    const data = await res.json();
    return { id: data.id };
  }

  // Create-or-replace a JSON file in a folder: update in place when we already
  // know its id, otherwise create a fresh one.
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
    const params = new URLSearchParams({ supportsAllDrives: "true" });
    const res = await fetch(`${FILES_URL}/${encodeURIComponent(fileId)}?${params}`, {
      method: "DELETE",
      headers: await authHeaders(),
    });
    await assertOk(res, "delete");
  }

  return { listChildren, findChild, getFileBytes, getJson, uploadFile, updateFileBytes, putJson, deleteFile };
}
