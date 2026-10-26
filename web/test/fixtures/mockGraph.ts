// The mock Graph tenant shared by the #315 test files: in-memory driveItems,
// real URL shapes (path addressing, children paging, content streams,
// conflictBehavior), auth-header enforcement, and a call log.
export const BASE = "https://graph.test/v1.0";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

// ── a tiny Graph tenant: driveItems in memory, real URL shapes ─────────────
export const DOWNLOAD_HOST = "https://download.test";

export function mockGraph({ pageSize = 200, downloadUrls = true, expireToken = 0 }: { pageSize?: number; downloadUrls?: boolean; expireToken?: number } = {}) {
  type Item = { id: string; name: string; parentId: string | null; folder: boolean; content: Uint8Array | null };
  const items = new Map<string, Item>();
  items.set("root", { id: "root", name: "root", parentId: null, folder: true, content: null });
  let nextId = 1;
  const mint = () => `it${nextId++}`;

  const childrenOf = (pid: string) => [...items.values()].filter((i) => i.parentId === pid);
  const byPath = (pid: string, name: string) => childrenOf(pid).find((i) => i.name === name) || null;
  const asItem = (i: Item) => ({
    id: i.id, name: i.name, lastModifiedDateTime: "2026-08-24T00:00:00Z", size: i.content?.length ?? 0,
    ...(i.folder ? { folder: { childCount: childrenOf(i.id).length } } : { file: { mimeType: "application/json" } }),
    // the pre-authenticated download URL a real tenant hands out on a file
    // item — a different host, short-lived, no auth expected
    ...(!i.folder && downloadUrls ? { "@microsoft.graph.downloadUrl": `${DOWNLOAD_HOST}/dl/${i.id}?tempauth=t` } : {}),
  });

  const resp = (status: number, body: any = null, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => body,
    text: async () => (body == null ? "" : JSON.stringify(body)),
    arrayBuffer: async () => (body instanceof Uint8Array ? body.buffer.slice(0) : new TextEncoder().encode(JSON.stringify(body)).buffer),
  });

  const calls: string[] = [];
  const tokensSeen: string[] = [];
  let expireLeft = expireToken;
  async function fetchImpl(url: string, init: any = {}) {
    const method = (init.method || "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    // the download host: a pre-authenticated URL, and a bearer on it is the
    // corner tenants disagree on — the mock REFUSES it, so a client that
    // leaks the token onto the redirect host fails here instead of in the field
    if (url.startsWith(DOWNLOAD_HOST)) {
      if (init.headers?.Authorization) return resp(401, { error: "bearer on a pre-authenticated URL" });
      const it = items.get(url.match(/\/dl\/([^?]+)/)?.[1] || "");
      if (!it || it.folder) return resp(404, { error: "expired" });
      return resp(200, it.content ?? new Uint8Array());
    }
    if (!init.headers?.Authorization?.startsWith("Bearer ")) return resp(401, { error: "no token" });
    tokensSeen.push(init.headers.Authorization.slice(7));
    // an expired / revoked token: the first `expireToken` authenticated calls
    // answer 401 (the tenant re-evaluated the session), then accept
    if (expireLeft > 0) { expireLeft--; return resp(401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired" } }); }
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    const m = path.match(/\/drives\/([^/]+)\/items\/(.+)$/);
    if (!m) return resp(400, { error: `bad url ${path}` });
    const rest = m[2];

    // /items/{parent}:/{name}(:/content)?  — path addressing
    const pm = rest.match(/^([^:]+):\/([^:]+)(?::?\/content)?$/);
    const isContent = /:\/content$/.test(rest) || /\/content$/.test(rest);
    if (pm && rest.includes(":")) {
      const [, pid, name] = pm;
      const parent = items.get(pid);
      if (!parent || !parent.folder) return resp(404, { error: "no parent" });
      const hit = byPath(pid, name);
      if (method === "GET") {
        return hit ? resp(200, asItem(hit)) : resp(404, { error: "not found" });
      }
      if (method === "PUT" && isContent) {
        const bytes = init.body instanceof Uint8Array ? init.body : new TextEncoder().encode(String(init.body));
        if (hit) { hit.content = bytes; return resp(200, asItem(hit)); }
        const it: Item = { id: mint(), name, parentId: pid, folder: false, content: bytes };
        items.set(it.id, it);
        return resp(201, asItem(it));
      }
      return resp(405, { error: "method" });
    }

    // /items/{id}/children
    const cm = rest.match(/^([^/:]+)\/children$/);
    if (cm) {
      const pid = cm[1];
      const parent = items.get(pid);
      if (!parent || !parent.folder) return resp(404, { error: "no folder" });
      if (method === "GET") {
        const all = childrenOf(pid).map(asItem);
        const skip = Number(u.searchParams.get("$skip") || 0);
        const page = all.slice(skip, skip + pageSize);
        const body: any = { value: page };
        if (skip + pageSize < all.length) {
          body["@odata.nextLink"] = `${BASE}/drives/${m[1]}/items/${pid}/children?$skip=${skip + pageSize}`;
        }
        return resp(200, body);
      }
      if (method === "POST") {
        const meta = JSON.parse(String(init.body));
        const existing = byPath(pid, meta.name);
        if (existing) {
          if (meta["@microsoft.graph.conflictBehavior"] === "fail") return resp(409, { error: "nameAlreadyExists" });
        }
        const it: Item = { id: mint(), name: meta.name, parentId: pid, folder: !!meta.folder, content: null };
        items.set(it.id, it);
        return resp(201, asItem(it));
      }
    }

    // /items/{id}/content
    const km = rest.match(/^([^/:]+)\/content$/);
    if (km) {
      const it = items.get(km[1]);
      if (!it || it.folder) return resp(404, { error: "not found" });
      if (method === "GET") return resp(200, it.content ?? new Uint8Array());
      if (method === "PUT") {
        it.content = init.body instanceof Uint8Array ? init.body : new TextEncoder().encode(String(init.body));
        return resp(200, asItem(it));
      }
    }

    // /items/{id}
    const im = rest.match(/^([^/:]+)$/);
    if (im) {
      const it = items.get(im[1]);
      if (method === "DELETE") {
        if (!it) return resp(404, { error: "gone" });
        items.delete(it.id);
        return resp(204);
      }
      if (method === "GET") return it ? resp(200, asItem(it)) : resp(404, { error: "not found" });
    }
    return resp(400, { error: `unhandled ${method} ${rest}` });
  }

  return { fetchImpl, items, calls, tokensSeen };
}

