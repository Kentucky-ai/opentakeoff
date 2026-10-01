// Title-block sheet numbers ("A003") for the canvas's pager, tabs and
// provenance jumps, kept per FILE: { fileName: { pageNum: "A003" } }. Page
// numbers repeat across files, so labels are keyed by file and a write always
// lands under the file whose text it read. A previous file's late background
// scan can't fill another file's pages, and a file's own label survives the
// reset on a file change whichever lands first.
export type PageLabels = Record<number, string>;
export type SheetLabels = Record<string, PageLabels>;

// the stable empty map (a fresh {} per render would re-run [pageLabels] hooks)
const NO_LABELS: PageLabels = Object.freeze({}) as PageLabels;

export function labelsForFile(m: SheetLabels, file: string): PageLabels {
  return m[file] || NO_LABELS;
}

// a new active file starts with only its own labels; other files' go
export function labelsOnFileChange(m: SheetLabels, file: string): SheetLabels {
  const own = m[file];
  return own ? { [file]: own } : {};
}

// the label just read for one page (replaces what was there)
export function withPageLabel(m: SheetLabels, file: string, page: number, label: string): SheetLabels {
  const own = labelsForFile(m, file);
  return own[page] === label ? m : { ...m, [file]: { ...own, [page]: label } };
}

// a batch from the background scan: a label already read wins
export function withFoundLabels(m: SheetLabels, file: string, found: PageLabels): SheetLabels {
  return { ...m, [file]: { ...found, ...labelsForFile(m, file) } };
}
