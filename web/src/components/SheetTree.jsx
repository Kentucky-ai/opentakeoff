import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../brand/icons.jsx";
import { buildTree, filterTree, visibleRows, nextFocus, treeKey, rowTitle } from "../lib/sheetTree.ts";

const base = (file) => file.replace(/\.pdf$/i, "");

// The Premium Sheets panel as a tree (rules in lib/sheetTree.ts). Every row
// shows today's label at once; a sheet number from the namer replaces it in
// place when it arrives, and nothing reorders. Notes about the tree sit
// after it, outside role=tree (a tree holds only its rows).
export function SheetTree({ items, current, onSelect, namer, countKnown, query, hold, onSearchAll }) {
  // numbers arrive batched per frame (sheetNamer's signal)
  const [version, bump] = useState(0);
  useEffect(() => namer?.subscribe(() => bump((n) => n + 1)), [namer]);
  const tree = useMemo(() => buildTree({ items, countKnown, numberOf: (f, p) => namer?.number(f, p), stale: (f) => !!namer?.stale(f) }),
    // version: the namer's numbers changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, countKnown, namer, version]);
  const { nodes, open: searchOpen } = useMemo(() => filterTree(tree, query), [tree, query]);
  const [expanded, setExpanded] = useState(() => new Set());
  const isOpen = (f) => searchOpen.has(f) || expanded.has(f);
  const rows = visibleRows(nodes, isOpen);
  const rowIds = rows.map((r) => r.id).join("\n");

  // the current sheet's folder opens when the current sheet changes, not on
  // every render (a folder the user closes stays closed)
  const currentFile = items.find((i) => i.key === current)?.file;
  useEffect(() => {
    if (currentFile) setExpanded((s) => (s.has(currentFile) ? s : new Set(s).add(currentFile)));
  }, [current, currentFile]);

  // one Tab stop: the focused row (else the current one, else the first)
  const [focusId, setFocusId] = useState(null);
  const prevRowsRef = useRef(rows);
  const treeRef = useRef(null);
  useEffect(() => {
    const prev = prevRowsRef.current;
    prevRowsRef.current = rows;
    if (focusId == null || rows.some((r) => r.id === focusId)) return;
    const at = nextFocus(focusId, prev, rows);
    const next = at >= 0 ? rows[at].id : null;
    const hadFocus = treeRef.current?.contains(document.activeElement);
    setFocusId(next);
    if (hadFocus && next) requestAnimationFrame(() => treeRef.current?.querySelector(`[data-row="${CSS.escape(next)}"]`)?.focus());
    // rowIds: the visible rows changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowIds]);
  const tabRow = rows.find((r) => r.id === focusId)?.id ?? rows.find((r) => r.node.kind !== "folder" && r.node.key === current)?.id ?? rows[0]?.id;

  const focusRow = (i) => {
    const r = rows[i];
    if (!r) return;
    setFocusId(r.id);
    treeRef.current?.querySelector(`[data-row="${CSS.escape(r.id)}"]`)?.focus();
  };
  const toggle = (file) => setExpanded((s) => { const n = new Set(s); if (n.has(file)) n.delete(file); else n.add(file); return n; });
  const onKeyDown = (e) => {
    // rows only: anything else in here keeps its own keys
    if (!(e.target instanceof Element) || !e.target.closest("[role=treeitem]")) return;
    const at = rows.findIndex((r) => r.id === (focusId ?? tabRow));
    const res = treeKey(e, rows, at, isOpen, !!hold?.());
    if (res.swallow) { e.preventDefault(); e.stopPropagation(); }
    if (res.move !== undefined) focusRow(res.move);
    if (res.expand) setExpanded((s) => new Set(s).add(res.expand));
    if (res.collapse) setExpanded((s) => { const n = new Set(s); n.delete(res.collapse); return n; });
    if (res.toggle) toggle(res.toggle);
    if (res.open) onSelect(res.open);
  };
  // a click opens or toggles without moving focus into the tree, so the
  // canvas's shortcuts keep working after picking a sheet with the mouse;
  // focus left in the panel's search box goes too, or the next shortcut
  // key would land in the query
  const noFocus = (e) => e.preventDefault();
  const pick = (key) => {
    onSelect(key);
    const a = document.activeElement;
    if (a instanceof HTMLElement && a.closest(".calm-navigator")) a.blur();
  };

  // files with a page not read yet: their numbers can't match a search
  const unread = useMemo(() => tree.filter((n) => n.kind === "pending" || (namer?.readCount(n.file) ?? 0) < (n.kind === "folder" ? n.pages : 1)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, namer, version]);

  // rows are flat (no nested groups), so each says its level and place
  const place = new Map(), sizes = new Map();
  for (const r of rows) { const k = r.parent ?? ""; const i = (sizes.get(k) ?? 0) + 1; sizes.set(k, i); place.set(r.id, [i, k]); }
  for (const [id, [i, k]] of place) place.set(id, [i, sizes.get(k)]);

  if (!items.length) return <div className="calm-sheet-tree"><p>Open a plan to see its sheets here.</p></div>;
  return <div className="calm-sheet-tree">
    <div role="tree" aria-label="Sheets" ref={treeRef} onKeyDown={onKeyDown}>
      {rows.map((r) => {
        const n = r.node;
        const common = {
          "data-row": r.id, role: "treeitem", "aria-level": r.depth,
          "aria-posinset": place.get(r.id)[0], "aria-setsize": place.get(r.id)[1],
          tabIndex: r.id === tabRow ? 0 : -1,
          onFocus: () => setFocusId(r.id),
          onMouseDown: noFocus,
        };
        if (n.kind === "folder") {
          return <div key={r.id} {...common} className="calm-tree-folder" aria-expanded={isOpen(n.file)} title={`${n.file} · ${n.pages} sheets`} onClick={() => { setFocusId(r.id); toggle(n.file); }}>
            <Icon name="chevronRight" size={14} /><span><strong>{base(n.file)}</strong></span><small>{n.pages} sheets</small>{n.shapes > 0 && <em>{n.shapes}</em>}
          </div>;
        }
        return <div key={r.id} {...common} className={`calm-tree-sheet${r.depth === 2 ? " is-child" : ""}`} aria-current={n.key === current ? "page" : undefined} title={rowTitle(n)} onClick={() => { setFocusId(r.id); pick(n.key); }}>
          <Icon name="document" size={17} />
          <span>
            <strong className={n.number ? "calm-sheet-number" : undefined}>{n.number ?? n.label}</strong>
            {n.kind !== "sheet" && <small>{n.file}</small>}
          </span>
          {/* an unnumbered row's label already starts with its level */}
          {n.level && n.number && <i className="calm-level-chip">{n.level}</i>}
          {n.shapes > 0 && <em>{n.shapes}</em>}
        </div>;
      })}
    </div>
    {!rows.length && <p>No sheets match your search.</p>}
    {query.trim() && unread > 0 && <p className="calm-tree-note">{unread} file{unread === 1 ? " isn't" : "s aren't"} fully numbered yet; open {unread === 1 ? "it" : "them"} to read {unread === 1 ? "its" : "their"} sheet numbers. <button type="button" onClick={onSearchAll}>Search all sheet text</button></p>}
  </div>;
}
