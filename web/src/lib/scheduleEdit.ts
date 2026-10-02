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
//   duplicate — its (edited) tag collides with another row's here that claims it
//               (the first such row, or the highest-ranked — see evaluateTags)
//   ok        — a unique, creatable tag
export type TagStatus = "ok" | "empty" | "in-use" | "duplicate";

export type TagInput = { key: string; tag: string };
export type TagState = { key: string; tag: string; status: TagStatus };

// Resolve every row's edited tag to a normalized value + a status, in row order.
// `existing` is compared against the normalized tag — the same value the dialog
// hands to onCreate — so what the dialog flags is exactly what create would
// refuse, and a duplicate can never slip through. An existing code is "in-use"
// whatever the row's rank.
// Among rows that share a code here, one claims it and the rest are flagged
// "duplicate". Without `rank`, the first row wins (mirroring the parent create
// loop, which walks the selected rows in order and skips a tag it has already
// made). With `rank(key)` — called with the row's stable key, never its edited
// tag — the highest-ranked row claims the code, ties to the first row. The
// dialog ranks a row the schedule marks NOT USED lowest, so a real row with the
// same code keeps it.
export function evaluateTags(rows: TagInput[], existing: Set<string> = new Set(), rank?: (key: string) => number): Map<string, TagState> {
  const tags = rows.map((r) => normalizeTag(r.tag));
  // which row claims each code: the first highest-ranked row (rank absent → the first)
  const owner = new Map<string, { key: string; rank: number }>();
  rows.forEach((r, i) => {
    const tag = tags[i];
    if (!tag || existing.has(tag)) return;
    const rk = rank ? rank(r.key) : 0;
    const cur = owner.get(tag);
    if (!cur || rk > cur.rank) owner.set(tag, { key: r.key, rank: rk });
  });
  const out = new Map<string, TagState>();
  rows.forEach((r, i) => {
    const tag = tags[i];
    let status: TagStatus;
    if (!tag) status = "empty";
    else if (existing.has(tag)) status = "in-use";
    else status = owner.get(tag)?.key === r.key ? "ok" : "duplicate";
    out.set(r.key, { key: r.key, tag, status });
  });
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

// A group's checkbox: "all" when every pickable row in the group is picked,
// "some" when some are, "none" when none are or nothing in it can be picked
// (the checkbox is then disabled). A locked row (in use / duplicate / needs a
// code) is left out, so it never holds a group at "some".
export type GroupState = "all" | "some" | "none";
export function groupState(picked: Set<string>, keys: string[], canPick: (key: string) => boolean): GroupState {
  const pickable = keys.filter(canPick);
  const n = pickable.filter((k) => picked.has(k)).length;
  return !pickable.length || !n ? "none" : n === pickable.length ? "all" : "some";
}

// Clicking a group's checkbox: an "all" group clears every row in it (a stale
// pick on a locked row too); any other state picks every pickable row,
// NOT USED rows included. Returns a NEW set.
export function groupToggle(picked: Set<string>, keys: string[], canPick: (key: string) => boolean): Set<string> {
  return groupState(picked, keys, canPick) === "all" ? setPicked(picked, keys, canPick, false) : setPicked(picked, keys, canPick, true);
}

// Codes the reader saw but didn't read (ScheduleRead.skipped: four- or
// five-letter codes with no number, one entry per line). Distinct codes in
// first-seen order; a code on more than one line shows its line count; past
// 8 codes the rest are counted. count = distinct codes, lines = entries.
export function skippedSummary(skipped: readonly string[]): { count: number; list: string; lines: number } {
  const n = new Map<string, number>();
  for (const w of skipped) n.set(w, (n.get(w) ?? 0) + 1);
  const words = [...n].map(([w, c]) => (c > 1 ? `${w} (${c} lines)` : w));
  const shown = words.slice(0, 8);
  const list = words.length > 8 ? `${shown.join(", ")}, and ${words.length - 8} more` : shown.join(", ");
  return { count: n.size, list, lines: skipped.length };
}

const SKIPPED_RULE = "A four- or five-letter code with no number is read only when the header or a read row is above it, it fills two or more other columns, and a row with a numbered code, like CPT-1, comes after it";

// The Import from schedule dialog's notice for skipped codes.
export function skippedBanner(skipped: readonly string[]): string {
  const { count, list } = skippedSummary(skipped);
  return count === 1
    ? `1 code wasn't read: ${list}. ${SKIPPED_RULE} — if it's a finish, add it as a condition yourself.`
    : `${count} codes weren't read: ${list}. ${SKIPPED_RULE} — if they're finishes, add them as conditions yourself.`;
}

// The agent's read_schedule note when skipped codes are all a box held.
export function skippedNote(skipped: readonly string[]): string {
  const { count, list, lines } = skippedSummary(skipped);
  return count === 1
    ? `No rows read. A four- or five-letter code with no number wasn't read: ${list}. Find its ${lines > 1 ? "lines" : "line"} with read_sheet_text, check it with view_region, then create it with create_condition if it's a finish.`
    : `No rows read. Four- or five-letter codes with no number weren't read: ${list}. Find their lines with read_sheet_text, check them with view_region, then create them with create_condition if they're finishes.`;
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

// The dialog's document keydown listener. Escape closes the dialog — unless it
// was a tag edit's Escape, which only cancels the edit: the input's onEditKey
// preventDefaults it, and React's handler runs before this document listener.
// Propagation is stopped so the canvas's own Escape (clear the selection,
// disarm tools) doesn't also fire behind the modal. Returns whether it closed.
type EscapeEvent = { key: string; defaultPrevented: boolean; stopPropagation: () => void };
export function closeOnEscape(e: EscapeEvent, onClose?: () => void): boolean {
  if (e.key !== "Escape" || e.defaultPrevented) return false;
  e.stopPropagation();
  onClose?.();
  return true;
}
