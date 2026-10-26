// Drag a marked sheet OUT of the app — Chromium's DownloadURL dataTransfer
// type lets a drag deposit a real file in Finder/Explorer, an email draft, or
// a chat drop zone. The catch that shapes this whole module: dragstart is
// SYNCHRONOUS, so the single-sheet marked PDF must exist before the drag
// begins. Hovering a sheet tab ARMS the drag (builds + caches a blob URL);
// dragstart only reads the cache and never awaits.
//
// String helpers are pure and node-tested (web/test/dragout.test.ts); the
// cache owns object URLs and revokes what it replaces.

// A filename that survives every drop target (Finder, Outlook, Slack): ASCII
// word chars, dots and dashes only — spaces collapse to dashes, everything
// else drops. Never empty: a fully-stripped part falls back to "sheet".
export function dragPart(s, fallback = "sheet") {
  const base = String(s || "").trim().replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return base || fallback;
}

export function dragFilename(projectName, sheetLabel) {
  return `${dragPart(projectName, "takeoff")}-${dragPart(sheetLabel)}-marked.pdf`;
}

// The DownloadURL payload is a single colon-joined triple. The filename must
// not carry a colon (dragPart guarantees it), the URL may (blob:http://…).
export function downloadUrlEntry(filename, url, mime = "application/pdf") {
  return `${mime}:${filename}:${url}`;
}

// Cheap identity of what would burn into this sheet's page: ids plus the
// computed quantities, so an in-place geometry edit (same id, new numbers)
// re-arms the build. Order-stable because callers pass state arrays whose
// order only changes when content does.
export function sheetContentSignature(key, shapes, markups, approvals) {
  const s = shapes.filter((x) => x.sheet_id === key).map((x) => `${x.id}:${x.computed?.area_sf ?? ""}:${x.computed?.perimeter_lf ?? ""}`);
  const m = markups.filter((x) => x.sheet_id === key).map((x) => `${x.id}:${x.type}`);
  const a = approvals.filter((x) => x.sheet_id === key).map((x) => x.id);
  return `${key}|${s.join(",")}|${m.join(",")}|${a.join(",")}`;
}

// One entry per sheet key. arm() is idempotent per signature and coalesces
// concurrent builds; get() answers synchronously (what dragstart needs).
export function createDragCache() {
  const entries = new Map(); // key → { sig, url, filename, building: Promise|null }
  return {
    async arm(key, sig, build) {
      const cur = entries.get(key);
      if (cur && cur.sig === sig && (cur.url || cur.building)) return cur.building || cur;
      const entry = { sig, url: "", filename: "", building: null };
      entries.set(key, entry);
      entry.building = (async () => {
        const { bytes, filename } = await build();
        // a newer arm may have replaced this entry while we rendered
        if (entries.get(key) !== entry) return;
        if (cur?.url) URL.revokeObjectURL(cur.url);
        entry.url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        entry.filename = filename;
        entry.building = null;
      })().catch(() => { if (entries.get(key) === entry) entries.delete(key); });
      return entry.building;
    },
    get(key, sig) {
      const e = entries.get(key);
      return e && e.sig === sig && e.url ? { url: e.url, filename: e.filename } : null;
    },
    dispose() {
      for (const e of entries.values()) if (e.url) URL.revokeObjectURL(e.url);
      entries.clear();
    },
  };
}
