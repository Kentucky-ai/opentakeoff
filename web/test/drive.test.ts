// Google Drive REST client — exercised entirely against a stub `fetch`, so no
// network and no real login. Each test builds a fetch that records the request
// (url/method/headers/body) and returns a canned Response-shaped object, then
// asserts the client sent the right query, headers, and multipart body, and
// that non-2xx responses throw with the HTTP status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDrive } from "../src/lib/google/drive.js";

// Minimal Response-shaped object. Provide whatever the call under test reads.
function makeRes(init: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
  arrayBuffer?: ArrayBuffer;
}) {
  const status = init.status ?? (init.ok === false ? 500 : 200);
  return {
    ok: init.ok ?? status < 300,
    status,
    async json() { return init.json; },
    async text() { return init.text ?? ""; },
    async arrayBuffer() { return init.arrayBuffer ?? new ArrayBuffer(0); },
  };
}

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

// A fetch stub that replays a queue of responses and records every call.
// Typed as `typeof fetch` so it drops cleanly into createDrive's fetch param
// (the real signature is stricter than what these tests exercise).
function stubFetch(responses: ReturnType<typeof makeRes>[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const stub = (async (url: any, opts: any = {}) => {
    calls.push({ url: String(url), method: opts.method || "GET", headers: opts.headers || {}, body: opts.body });
    const next = queue.shift();
    if (!next) throw new Error("stubFetch: no response queued");
    return next;
  }) as unknown as typeof fetch;
  return { fetch: stub, calls };
}

const getToken = async () => "tok";

test("every request carries the Bearer token", async () => {
  const { fetch, calls } = stubFetch([makeRes({ json: { files: [] } })]);
  const drive = createDrive({ getToken, fetch });
  await drive.listChildren("folder1");
  assert.equal(calls[0].headers.Authorization, "Bearer tok");
});

test("listChildren builds q/fields, adds Shared-Drive flags, and maps files", async () => {
  const { fetch, calls } = stubFetch([
    makeRes({ json: { files: [{ id: "a", name: "one.pdf", mimeType: "application/pdf", modifiedTime: "t1", size: "1234" }] } }),
  ]);
  const drive = createDrive({ getToken, fetch });
  const out = await drive.listChildren("folder1", { mimeType: "application/pdf" });

  const url = calls[0].url;
  const params = new URLSearchParams(url.split("?")[1]);
  assert.equal(params.get("q"), "'folder1' in parents and trashed=false and mimeType='application/pdf'");
  // size is requested so the picker can show file sizes without downloading
  assert.match(params.get("fields")!, /files\(id,name,mimeType,modifiedTime,size\)/);
  assert.equal(params.get("supportsAllDrives"), "true");
  assert.equal(params.get("includeItemsFromAllDrives"), "true");
  assert.deepEqual(out, [{ id: "a", name: "one.pdf", mimeType: "application/pdf", modifiedTime: "t1", size: "1234" }]);
});

test("findChild escapes both backslash and single-quote in the q grammar", async () => {
  const { fetch, calls } = stubFetch([makeRes({ json: { files: [] } })]);
  const drive = createDrive({ getToken, fetch });
  await drive.findChild("folder1", "a'b\\c.pdf");   // name contains a quote AND a backslash
  const q = new URLSearchParams(calls[0].url.split("?")[1]).get("q")!;
  // backslash escaped first (\\), then quote (\') — a name like this must not
  // break the query or silently miss (would cause dup uploads / not-found).
  assert.ok(q.includes("name='a\\'b\\\\c.pdf'"), q);
});

test("listChildren follows nextPageToken pagination", async () => {
  const { fetch, calls } = stubFetch([
    makeRes({ json: { files: [{ id: "a", name: "a" }], nextPageToken: "PAGE2" } }),
    makeRes({ json: { files: [{ id: "b", name: "b" }] } }),
  ]);
  const drive = createDrive({ getToken, fetch });
  const out = await drive.listChildren("folder1");
  assert.deepEqual(out.map((f) => f.id), ["a", "b"]);
  // second request must carry the page token from the first response
  assert.equal(new URLSearchParams(calls[1].url.split("?")[1]).get("pageToken"), "PAGE2");
});

test("findChild returns the first match, escapes single quotes in the name", async () => {
  const { fetch, calls } = stubFetch([
    makeRes({ json: { files: [{ id: "x", name: "O'Brien.pdf" }, { id: "y", name: "other" }] } }),
  ]);
  const drive = createDrive({ getToken, fetch });
  const hit = await drive.findChild("folder1", "O'Brien.pdf");
  assert.equal(hit!.id, "x");
  assert.match(new URLSearchParams(calls[0].url.split("?")[1]).get("q")!, /name='O\\'Brien\.pdf'/);
});

test("findChild returns null when no file matches", async () => {
  const { fetch } = stubFetch([makeRes({ json: { files: [] } })]);
  const drive = createDrive({ getToken, fetch });
  assert.equal(await drive.findChild("folder1", "nope.pdf"), null);
});

test("getFileBytes returns a Uint8Array from the media response", async () => {
  const src = new Uint8Array([37, 80, 68, 70]); // %PDF
  const { fetch, calls } = stubFetch([makeRes({ arrayBuffer: src.buffer })]);
  const drive = createDrive({ getToken, fetch });
  const bytes = await drive.getFileBytes("id1");
  assert.deepEqual(bytes, src);
  assert.match(calls[0].url, /alt=media/);
});

test("file ids are percent-encoded so a planted id can't escape the path segment", async () => {
  // A manifest id from sheets.json is attacker-controllable; without encoding,
  // `../../drive/v3/about` would steer the GET to a different googleapis path
  // with the user's Bearer token. Encoding pins it to a single path segment.
  const evil = "../../drive/v3/about";
  const enc = encodeURIComponent(evil);
  const { fetch, calls } = stubFetch([
    makeRes({ arrayBuffer: new ArrayBuffer(0) }), // getFileBytes
    makeRes({ json: { id: evil } }),              // updateFileBytes (via putJson)
    makeRes({ ok: true }),                        // deleteFile
  ]);
  const drive = createDrive({ getToken, fetch });

  await drive.getFileBytes(evil);
  await drive.putJson({ folderId: "f", name: "n", data: {}, existingId: evil });
  await drive.deleteFile(evil);

  for (const c of calls) {
    assert.ok(c.url.includes(enc), `expected encoded id in ${c.url}`);
    assert.ok(!c.url.includes(evil), `raw id leaked into ${c.url}`);
  }
});

test("getJson downloads, decodes UTF-8, and parses", async () => {
  const obj = { hello: "wörld", n: 3 };
  const buf = new TextEncoder().encode(JSON.stringify(obj)).buffer;
  const { fetch } = stubFetch([makeRes({ arrayBuffer: buf })]);
  const drive = createDrive({ getToken, fetch });
  assert.deepEqual(await drive.getJson("id1"), obj);
});

test("uploadFile posts multipart to the upload endpoint", async () => {
  const { fetch, calls } = stubFetch([makeRes({ json: { id: "new1", name: "f.json" } })]);
  const drive = createDrive({ getToken, fetch });
  const bytes = new TextEncoder().encode("{}");
  const out = await drive.uploadFile({ name: "f.json", parentId: "folder1", mimeType: "application/json", bytes });
  assert.deepEqual(out, { id: "new1", name: "f.json" });
  assert.equal(calls[0].method, "POST");
  assert.match(calls[0].url, /\/upload\/drive\/v3\/files/);
  assert.match(calls[0].url, /uploadType=multipart/);
  assert.match(calls[0].headers["Content-Type"], /^multipart\/related; boundary=/);
  // body is a Blob with the metadata part naming the parent folder
  const bodyText = await (calls[0].body as Blob).text();
  assert.match(bodyText, /"parents":\["folder1"\]/);
  assert.match(bodyText, /"name":"f\.json"/);
});

test("putJson creates when no existingId, updates when given one", async () => {
  const { fetch, calls } = stubFetch([
    makeRes({ json: { id: "created1", name: "annotations.json" } }),
    makeRes({ json: { id: "existing1" } }),
  ]);
  const drive = createDrive({ getToken, fetch });

  const created = await drive.putJson({ folderId: "folder1", name: "annotations.json", data: { a: 1 } });
  assert.deepEqual(created, { id: "created1" });
  assert.equal(calls[0].method, "POST"); // multipart create

  const updated = await drive.putJson({ folderId: "folder1", name: "annotations.json", data: { a: 2 }, existingId: "existing1" });
  assert.deepEqual(updated, { id: "existing1" });
  assert.equal(calls[1].method, "PATCH"); // media update
  assert.match(calls[1].url, /\/upload\/drive\/v3\/files\/existing1/);
  assert.match(calls[1].url, /uploadType=media/);
});

test("non-2xx responses throw with the HTTP status and body", async () => {
  const { fetch } = stubFetch([makeRes({ ok: false, status: 403, text: "insufficientPermissions" })]);
  const drive = createDrive({ getToken, fetch });
  await assert.rejects(drive.listChildren("folder1"), (e: any) => {
    assert.match(e.message, /HTTP 403/);
    assert.match(e.message, /insufficientPermissions/);
    return true;
  });
});
