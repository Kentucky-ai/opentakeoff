// Inline finish-tag editing for the Import-from-schedule dialog. PURE and
// DOM-free on purpose (the sheets.ts / oneclick.ts / scheduleParse.ts precedent)
// so the identity + dedup math is node-tested independently of the .jsx view.
//
// Why this exists: the scan/OCR ingest path will mis-read finish codes (O↔0,
// I↔1, CPT↔CRT). finish_tag is the identity the canvas dedups on and the code a
// plan callout is matched against, so the estimator has to be able to FIX a
// mangled tag before the condition is created — right in the approval dialog.
// The dialog keeps checkbox state on a STABLE per-row key (not the mutable tag),
// then asks these helpers what each edited tag resolves to.

// Finish codes are conventionally all-caps with no interior runs of whitespace
// (CPT-1, PLAM-2, RES-W). Normalize an edited tag the same way the parser emits
// them so dedup is case/whitespace insensitive and matches what flows to create.
export function normalizeTag(raw: string): string {
  return (raw || "").trim().replace(/\s+/g, " ").toUpperCase();
}

// Why a row can't be created, or "ok" when it can.
//   empty     — edited to blank; nothing to create (row disabled)
//   in-use    — its (edited) tag already exists as a condition (the `existing` set)
//   duplicate — its (edited) tag collides with an EARLIER row's edited tag here
//   ok        — a unique, creatable tag
export type TagStatus = "ok" | "empty" | "in-use" | "duplicate";

export type TagInput = { key: string; tag: string };
export type TagState = { key: string; tag: string; status: TagStatus };

// Resolve every row's edited tag to a normalized value + a status, in row order.
// First-seen wins for in-dialog collisions (mirrors the parent create loop, which
// walks the selected rows in order and skips a tag it has already made), so a
// later row that now duplicates an earlier one is flagged rather than the other
// way round. `existing` is compared against the normalized tag — the same value
// the dialog hands to onCreate — so what the dialog flags is exactly what create
// would refuse, and a duplicate can never slip through.
export function evaluateTags(rows: TagInput[], existing: Set<string> = new Set()): Map<string, TagState> {
  const seen = new Set<string>();
  const out = new Map<string, TagState>();
  for (const r of rows) {
    const tag = normalizeTag(r.tag);
    let status: TagStatus;
    if (!tag) status = "empty";
    else if (existing.has(tag)) status = "in-use";
    else if (seen.has(tag)) status = "duplicate";
    else { status = "ok"; seen.add(tag); }
    out.set(r.key, { key: r.key, tag, status });
  }
  return out;
}

export const isCreatable = (s: TagState | undefined): boolean => s?.status === "ok";

// Turn a set of rows on or off together — Select All / Deselect All over every
// row, or one group's checkbox over its rows. Returns a NEW set (React state);
// rows outside `keys` keep their pick. Turning on never picks a row canPick
// refuses (in use / duplicate / empty), so the footer's "Create N" can't count
// one; turning off clears every given key, including a stale pick on a row an
// edit has since made uncreatable.
export function setPicked(picked: Set<string>, keys: string[], canPick: (key: string) => boolean, on: boolean): Set<string> {
  const n = new Set(picked);
  for (const k of keys) {
    if (!on) n.delete(k);
    else if (canPick(k)) n.add(k);
  }
  return n;
}

// The line colour each row's condition will get, for the dialog's swatch. The
// parent (TakeoffCanvas.createFromSchedule → rowToSeed) assigns
// palette[(startIndex + n) % len] over the rows it CREATES — picked and
// creatable, in row order — so number only those. An unpicked row gets no
// entry (the dialog shows the neutral swatch): it would get no colour at all.
export function previewColors(keys: string[], willCreate: (key: string) => boolean, palette: string[], startIndex = 0): Map<string, string> {
  const m = new Map<string, string>();
  if (!palette.length) return m;
  let n = startIndex;
  for (const k of keys) if (willCreate(k)) m.set(k, palette[n++ % palette.length]);
  return m;
}
