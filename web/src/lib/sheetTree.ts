// The Sheets panel as a tree: a multi-page PDF is a folder of its pages, a
// one-page PDF a row of its own, and a PDF whose page count isn't known yet a
// pending row that becomes one or the other in place. Pure: rows, search,
// what's visible, and what a key does; the component only renders.

/** One sheet as the canvas lists it (workspaceSheets). */
export type NavItem = { key: string; label: string; file: string; count: number; level?: string };

export type SheetRow = {
  kind: "sheet" | "single" | "pending";
  id: string; key: string; file: string; page: number;
  /** today's tab label */
  label: string;
  /** the anchored number; null when not read or none */
  number: string | null;
  shapes: number; level: string;
};
export type FolderNode = { kind: "folder"; id: string; file: string; pages: number; shapes: number; children: SheetRow[] };
export type TreeNode = FolderNode | SheetRow;

export interface TreeInput {
  items: NavItem[];
  /** the file's page count is known (else it shows as one pending row) */
  countKnown(file: string): boolean;
  /** the page's anchored number (sheetNamer.number) */
  numberOf(file: string, page: number): string | null | undefined;
  /** the file's bytes changed this session (sheetNamer.stale): its tab
   *  labels may name the old revision, so unnumbered rows say file · page */
  stale?(file: string): boolean;
}

const pageOf = (key: string) => { const m = /#(\d+)$/.exec(key); return m ? Number(m[1]) : 1; };

const plainLabel = (file: string, page: number) => { const b = file.replace(/\.pdf$/i, ""); return page > 1 ? `${b} · ${page}` : b; };

export function buildTree({ items, countKnown, numberOf, stale }: TreeInput): TreeNode[] {
  const byFile = new Map<string, NavItem[]>();
  for (const it of items) { let g = byFile.get(it.file); if (!g) byFile.set(it.file, (g = [])); g.push(it); }
  const out: TreeNode[] = [];
  for (const [file, its] of byFile) {
    const old = !!stale?.(file);
    const row = (it: NavItem, kind: SheetRow["kind"]): SheetRow => {
      const page = pageOf(it.key), n = numberOf(file, page);
      const number = typeof n === "string" ? n : null;
      const label = old && number == null ? (it.level ? `${it.level} · ` : "") + plainLabel(file, page) : it.label;
      return { kind, id: `s:${it.key}`, key: it.key, file, page, label, number, shapes: it.count, level: it.level || "" };
    };
    if (!countKnown(file)) out.push(row(its[0], "pending"));
    else if (its.length === 1) out.push(row(its[0], "single"));
    else out.push({ kind: "folder", id: `f:${file}`, file, pages: its.length, shapes: its.reduce((t, i) => t + i.count, 0), children: its.map((i) => row(i, "sheet")) });
  }
  return out;
}

const hay = (r: SheetRow) => `${r.number ?? ""} ${r.label} ${r.file}`.toLowerCase();

/** The tree for a search: rows whose number, label or file name match;
 *  folders keep their matching pages and open, others hide. */
export function filterTree(nodes: TreeNode[], query: string): { nodes: TreeNode[]; open: Set<string> } {
  const q = query.trim().toLowerCase();
  const open = new Set<string>();
  if (!q) return { nodes, open };
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.kind !== "folder") { if (hay(n).includes(q)) out.push(n); continue; }
    const kids = n.children.filter((c) => hay(c).includes(q));
    if (kids.length) { out.push({ ...n, children: kids }); open.add(n.file); }
  }
  return { nodes: out, open };
}

export type VisibleRow = { id: string; depth: 1 | 2; node: TreeNode; parent: string | null };

/** Rows in screen order: folders, and the pages of open ones. */
export function visibleRows(nodes: TreeNode[], isOpen: (file: string) => boolean): VisibleRow[] {
  const rows: VisibleRow[] = [];
  for (const n of nodes) {
    rows.push({ id: n.id, depth: 1, node: n, parent: null });
    if (n.kind === "folder" && isOpen(n.file)) for (const c of n.children) rows.push({ id: c.id, depth: 2, node: c, parent: n.id });
  }
  return rows;
}

/** Where focus goes when the rows change under it (collapse, search): the
 *  same row, else its folder, else the row now at its old place. */
export function nextFocus(prevId: string | null, prevRows: VisibleRow[], rows: VisibleRow[]): number {
  if (!rows.length) return -1;
  if (prevId == null) return 0;
  const same = rows.findIndex((r) => r.id === prevId);
  if (same >= 0) return same;
  const was = prevRows.find((r) => r.id === prevId);
  if (was?.parent) { const p = rows.findIndex((r) => r.id === was.parent); if (p >= 0) return p; }
  const at = prevRows.findIndex((r) => r.id === prevId);
  return Math.min(Math.max(at, 0), rows.length - 1);
}

export type KeyLike = { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean };
export type KeyResult = {
  /** preventDefault + stopPropagation: no canvas shortcut may see it */
  swallow: boolean;
  move?: number; expand?: string; collapse?: string; toggle?: string; open?: string;
};

/** What a key does on a tree row (W3C navigation tree). The tree takes
 *  Enter, Space, Delete and Backspace whatever modifiers are held, and every
 *  other key with no Ctrl/⌘/Alt except Tab and Escape, so a row can never
 *  finish a trace, accept proposals, pan, pick a tool or delete a shape.
 *  While a schedule read holds keys (`hold`), Enter and Space are left for it. */
export function treeKey(e: KeyLike, rows: VisibleRow[], at: number, isOpen: (file: string) => boolean, hold = false): KeyResult {
  const row = rows[at];
  const k = e.key;
  if (k === "Enter" || k === " " || k === "Spacebar") {
    if (hold) return { swallow: false };
    if (!row) return { swallow: true };
    if (row.node.kind === "folder") return { swallow: true, toggle: row.node.file };
    return { swallow: true, open: row.node.key };
  }
  if (k === "Delete" || k === "Backspace") return { swallow: true };
  if (k === "Tab" || k === "Escape") return { swallow: false };
  if (e.ctrlKey || e.metaKey || e.altKey) return { swallow: false };
  const last = rows.length - 1;
  switch (k) {
    case "ArrowDown": return { swallow: true, move: Math.min(at + 1, last) };
    case "ArrowUp": return { swallow: true, move: Math.max(at - 1, 0) };
    case "Home": return { swallow: true, move: 0 };
    case "End": return { swallow: true, move: last };
    case "ArrowRight":
      if (row?.node.kind === "folder") return isOpen(row.node.file) ? { swallow: true, move: Math.min(at + 1, last) } : { swallow: true, expand: row.node.file };
      return { swallow: true };
    case "ArrowLeft":
      if (row?.node.kind === "folder" && isOpen(row.node.file)) return { swallow: true, collapse: row.node.file };
      if (row?.parent) return { swallow: true, move: rows.findIndex((r) => r.id === row.parent) };
      return { swallow: true };
    default: return { swallow: true };
  }
}

/** A row's tooltip: the number and file, and the tab's label when it says
 *  something else (today's picker can read a door tag). */
export function rowTitle(r: SheetRow): string {
  if (!r.number) return `${r.label} · ${r.file}`;
  return r.label.endsWith(r.number) ? `${r.number} · ${r.file}` : `Sheet ${r.number} — tab shows ${r.label} · ${r.file}`;
}
